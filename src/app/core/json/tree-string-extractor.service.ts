import type { Signal, WritableSignal } from '@angular/core';
import { Injectable, InjectionToken, effect, inject, signal } from '@angular/core';
import { PreferencesService } from '../preferences/preferences.service';
import { LoggerService } from '../telemetry/logger.service';
import type { ExtractedJson, IndentSize } from './json-extractor.core';
import { MAX_INPUT_LENGTH } from './json-extractor.core';

export const TREE_STRING_EXTRACTOR_CACHE_CAPACITY = 10_000;
export const TREE_STRING_EXTRACTOR_BATCH_SIZE = 50;

export const WORKER_FACTORY = new InjectionToken<() => Worker>(
  'TreeStringExtractor.WORKER_FACTORY',
  {
    providedIn: 'root',
    factory: () => () =>
      new Worker(new URL('./json-extractor.worker', import.meta.url), {
        type: 'module',
      }),
  },
);

interface ScanRequest {
  type: 'scan';
  sourceVersion: number;
  tabSize: IndentSize;
  strings: readonly string[];
}

interface ScanResultMessage {
  type: 'scanResult';
  sourceVersion: number;
  results: readonly (ExtractedJsonWireFormat | null)[];
}

interface ExtractedJsonWireFormat {
  text: string;
  blockCount: number;
  preservesComments: boolean;
  proseSegments?: number;
  hasComments: boolean;
}

type CachedExtraction = ExtractedJson | null;
type ScannerUnavailableReason = 'factory' | 'postMessage' | 'error' | 'messageerror';

/**
 * One pending chunk awaiting a worker response. We capture the tabSize
 * at chunk-dispatch time (not at response time) so that a tabSize change
 * between dispatch and response cannot poison the cache with a result
 * keyed under the wrong tabSize. See issue #253.
 */
interface PendingChunk {
  strings: string[];
  tabSize: IndentSize;
}

@Injectable({ providedIn: 'root' })
export class TreeStringExtractorService {
  private readonly logger = inject(LoggerService);
  private readonly workerFactory = inject(WORKER_FACTORY);
  private readonly prefs = inject(PreferencesService);
  /**
   * LRU cache keyed by `${tabSize}:${rawString}`. tabSize is always the
   * captured-at-dispatch value, never a live read from prefs, so a
   * mid-flight tabSize toggle cannot land a result under the wrong key.
   * Strings that fail `shouldScan` (length / no `{` or `[`) bypass this
   * cache and use `definitelyNullStrings` instead, since that result is
   * tabSize-independent.
   */
  private readonly cache = new Map<string, CachedExtraction>();
  /**
   * Strings that cannot contain any extractable JSON regardless of
   * tabSize (too short, too long, or no `{`/`[` trigger). Tracked
   * separately from the indent-keyed `cache` so a tabSize flip does
   * not invalidate these mechanical-failure entries.
   */
  private readonly definitelyNullStrings = new Set<string>();
  private readonly currentGenerationStrings = new Set<string>();
  private readonly currentGenerationInFlight = new Set<string>();
  private readonly currentGenerationResults = new Map<string, ExtractedJson>();
  private readonly pendingChunksByVersion = new Map<number, PendingChunk[]>();
  private readonly candidatesSignal: WritableSignal<ReadonlyMap<string, ExtractedJson>> = signal(
    new Map<string, ExtractedJson>(),
  );
  private readonly scannerUnavailableSignal = signal(false);
  private readonly scanInFlightSignal = signal(false);
  private readonly currentVersionSignal = signal(0);
  private worker: Worker | null = null;
  private nextVersion = 0;
  /**
   * Tracks the last tabSize observed by the prefs-change effect so the
   * first synchronous run (during construction) does not invalidate a
   * brand-new generation. After the first read, any change triggers a
   * fresh re-scan of the current generation under the new tabSize.
   */
  private lastObservedTabSize: IndentSize | null = null;

  readonly candidates: Signal<ReadonlyMap<string, ExtractedJson>> =
    this.candidatesSignal.asReadonly();
  readonly scannerUnavailable: Signal<boolean> = this.scannerUnavailableSignal.asReadonly();
  readonly scanInFlight: Signal<boolean> = this.scanInFlightSignal.asReadonly();
  readonly currentVersion: Signal<number> = this.currentVersionSignal.asReadonly();

  constructor() {
    // M-#253: when editorTabSize flips, the visible candidates signal
    // continues to hold results indented at the prior tabSize until a
    // fresh scan is issued. Re-scan the current generation so tree
    // string previews reformat without requiring an editor edit. The
    // LRU cache key includes the dispatched tabSize, so previously
    // computed results at the new tabSize will still hit; otherwise
    // we re-post to the worker with the new tabSize. Root-provided
    // service lives for the app lifetime; no explicit cleanup needed.
    effect(() => {
      const tabSize = this.prefs.prefs().editorTabSize;
      if (this.lastObservedTabSize === null) {
        this.lastObservedTabSize = tabSize;
        return;
      }
      if (this.lastObservedTabSize === tabSize) {
        return;
      }
      this.lastObservedTabSize = tabSize;
      this.rescanCurrentGenerationOnTabSizeChange();
    });
  }

  beginGeneration(): number {
    const sourceVersion = ++this.nextVersion;
    this.currentVersionSignal.set(sourceVersion);
    this.currentGenerationStrings.clear();
    this.currentGenerationInFlight.clear();
    this.currentGenerationResults.clear();
    this.pendingChunksByVersion.clear();
    this.scanInFlightSignal.set(false);
    this.candidatesSignal.set(new Map<string, ExtractedJson>());
    return sourceVersion;
  }

  enqueueScan(strings: readonly string[]): void {
    if (strings.length === 0) {
      return;
    }

    const sourceVersion = this.currentVersionSignal();
    const tabSize = this.prefs.prefs().editorTabSize;
    const queuedStrings: string[] = [];
    let hasImmediateCandidateChange = false;

    for (const rawString of new Set(strings)) {
      this.currentGenerationStrings.add(rawString);

      if (!this.shouldScan(rawString)) {
        this.definitelyNullStrings.add(rawString);
        continue;
      }
      if (this.definitelyNullStrings.has(rawString)) {
        continue;
      }

      const cachedResult = this.getCachedResult(rawString, tabSize);
      if (cachedResult !== undefined) {
        if (cachedResult !== null) {
          this.currentGenerationResults.set(rawString, cachedResult);
          hasImmediateCandidateChange = true;
        }
        continue;
      }

      if (this.currentGenerationInFlight.has(rawString) || this.scannerUnavailableSignal()) {
        continue;
      }

      this.currentGenerationInFlight.add(rawString);
      queuedStrings.push(rawString);
    }

    if (hasImmediateCandidateChange) {
      this.publishCurrentGenerationResults();
    }

    if (queuedStrings.length === 0 || this.scannerUnavailableSignal()) {
      return;
    }

    const worker = this.getOrCreateWorker();
    if (!worker) {
      return;
    }

    for (
      let startIndex = 0;
      startIndex < queuedStrings.length;
      startIndex += TREE_STRING_EXTRACTOR_BATCH_SIZE
    ) {
      const chunk = queuedStrings.slice(startIndex, startIndex + TREE_STRING_EXTRACTOR_BATCH_SIZE);
      this.postChunk(worker, sourceVersion, tabSize, chunk);
      if (this.scannerUnavailableSignal()) {
        return;
      }
    }
  }

  private shouldScan(rawString: string): boolean {
    return (
      rawString.length >= 2 &&
      rawString.length <= MAX_INPUT_LENGTH &&
      (rawString.includes('{') || rawString.includes('['))
    );
  }

  private cacheKey(rawString: string, tabSize: IndentSize): string {
    return `${tabSize}:${rawString}`;
  }

  private getCachedResult(rawString: string, tabSize: IndentSize): CachedExtraction | undefined {
    const key = this.cacheKey(rawString, tabSize);
    if (!this.cache.has(key)) {
      return undefined;
    }

    const cachedResult = this.cache.get(key);
    this.cache.delete(key);
    if (cachedResult === undefined) {
      return undefined;
    }
    this.cache.set(key, cachedResult);
    return cachedResult;
  }

  private setCachedResult(rawString: string, tabSize: IndentSize, result: CachedExtraction): void {
    const key = this.cacheKey(rawString, tabSize);
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, result);

    while (this.cache.size > TREE_STRING_EXTRACTOR_CACHE_CAPACITY) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.cache.delete(oldestKey);
    }
  }

  private getOrCreateWorker(): Worker | null {
    if (this.worker || this.scannerUnavailableSignal()) {
      return this.worker;
    }

    try {
      const worker = this.workerFactory();
      worker.onmessage = (event: MessageEvent<unknown>) => this.handleWorkerMessage(event);
      worker.onerror = () => this.handleWorkerFailure('error');
      worker.onmessageerror = () => this.handleWorkerFailure('messageerror');
      this.worker = worker;
      return worker;
    } catch {
      this.handleWorkerFailure('factory');
      return null;
    }
  }

  private postChunk(
    worker: Worker,
    sourceVersion: number,
    tabSize: IndentSize,
    chunk: readonly string[],
  ): void {
    this.addPendingChunk(sourceVersion, tabSize, chunk);
    const request: ScanRequest = {
      type: 'scan',
      sourceVersion,
      tabSize,
      strings: chunk,
    };

    try {
      worker.postMessage(request);
    } catch {
      this.handleWorkerFailure('postMessage');
    }
  }

  private addPendingChunk(
    sourceVersion: number,
    tabSize: IndentSize,
    chunk: readonly string[],
  ): void {
    const existingChunks = this.pendingChunksByVersion.get(sourceVersion);
    const ownedChunk: PendingChunk = { strings: [...chunk], tabSize };
    if (existingChunks) {
      existingChunks.push(ownedChunk);
      return;
    }
    this.pendingChunksByVersion.set(sourceVersion, [ownedChunk]);
    this.refreshScanInFlight();
  }

  private shiftPendingChunk(sourceVersion: number): PendingChunk | undefined {
    const pendingChunks = this.pendingChunksByVersion.get(sourceVersion);
    if (!pendingChunks) {
      return undefined;
    }

    const chunk = pendingChunks.shift();
    if (pendingChunks.length === 0) {
      this.pendingChunksByVersion.delete(sourceVersion);
    }
    this.refreshScanInFlight();
    return chunk;
  }

  private refreshScanInFlight(): void {
    this.scanInFlightSignal.set(
      !this.scannerUnavailableSignal() &&
        this.pendingChunksByVersion.has(this.currentVersionSignal()),
    );
  }

  private handleWorkerMessage(event: MessageEvent<unknown>): void {
    if (this.scannerUnavailableSignal()) {
      return;
    }

    const message = event.data;
    if (!isScanResultMessage(message) || message.sourceVersion !== this.currentVersionSignal()) {
      return;
    }

    const chunk = this.shiftPendingChunk(message.sourceVersion);
    if (!chunk) {
      return;
    }

    let hasCandidateChange = false;
    for (let index = 0; index < chunk.strings.length; index++) {
      const rawString = chunk.strings[index];
      if (rawString === undefined) {
        continue;
      }

      this.currentGenerationInFlight.delete(rawString);
      const wireResult = message.results[index] ?? null;
      const result = wireResult ? toExtractedJson(wireResult) : null;
      this.setCachedResult(rawString, chunk.tabSize, result);
      if (result && this.currentGenerationStrings.has(rawString)) {
        this.currentGenerationResults.set(rawString, result);
        hasCandidateChange = true;
      }
    }

    if (hasCandidateChange) {
      this.publishCurrentGenerationResults();
    }
  }

  private publishCurrentGenerationResults(): void {
    const snapshot = new Map<string, ExtractedJson>();
    for (const [rawString, result] of this.currentGenerationResults) {
      if (this.currentGenerationStrings.has(rawString)) {
        snapshot.set(rawString, result);
      }
    }
    this.candidatesSignal.set(snapshot);
  }

  /**
   * Issue #253: tabSize flipped. Re-run a scan over the current
   * generation's strings under the new tabSize. Cache hits (if any
   * already-formatted-at-this-tabSize entries exist) are served
   * immediately; misses repost to the worker. Stale results from the
   * prior tabSize are cleared so the visible candidates signal does
   * not show outdated indent.
   */
  private rescanCurrentGenerationOnTabSizeChange(): void {
    if (this.currentGenerationStrings.size === 0) {
      return;
    }
    const strings = [...this.currentGenerationStrings];
    this.currentGenerationStrings.clear();
    this.currentGenerationInFlight.clear();
    this.currentGenerationResults.clear();
    this.pendingChunksByVersion.delete(this.currentVersionSignal());
    this.refreshScanInFlight();
    this.candidatesSignal.set(new Map<string, ExtractedJson>());
    this.enqueueScan(strings);
  }

  private handleWorkerFailure(reason: ScannerUnavailableReason): void {
    if (!this.scannerUnavailableSignal()) {
      this.logger.warn('tree.stringExtractor.workerUnavailable', { reason });
    }
    this.scannerUnavailableSignal.set(true);
    this.currentGenerationInFlight.clear();
    this.pendingChunksByVersion.clear();
    this.scanInFlightSignal.set(false);
  }
}

function isScanResultMessage(value: unknown): value is ScanResultMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as {
    type?: unknown;
    sourceVersion?: unknown;
    results?: unknown;
  };
  return (
    candidate.type === 'scanResult' &&
    typeof candidate.sourceVersion === 'number' &&
    Array.isArray(candidate.results)
  );
}

function toExtractedJson(wireResult: ExtractedJsonWireFormat): ExtractedJson {
  return {
    text: wireResult.text,
    blockCount: wireResult.blockCount,
    preservesComments: wireResult.preservesComments,
    proseSegments: wireResult.proseSegments ?? 0,
    hasComments: wireResult.hasComments,
  };
}
