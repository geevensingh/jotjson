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
  chunkId: number;
  tabSize: IndentSize;
  strings: readonly string[];
}

interface ScanResultMessage {
  type: 'scanResult';
  sourceVersion: number;
  chunkId: number;
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
 * keyed under the wrong tabSize. We also capture the sourceVersion so
 * the worker-message handler can verify the chunk still belongs to the
 * generation that issued it. See issue #253 and PR #289 review.
 */
interface PendingChunk {
  strings: string[];
  tabSize: IndentSize;
  sourceVersion: number;
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
   */
  private readonly cache = new Map<string, CachedExtraction>();
  private readonly currentGenerationStrings = new Set<string>();
  private readonly currentGenerationInFlight = new Set<string>();
  private readonly currentGenerationResults = new Map<string, ExtractedJson>();
  /**
   * Pending worker chunks keyed by per-chunk id. Replaced the prior
   * version-keyed FIFO queue (PR #289 review): the queue allowed a
   * stale OLD-tabSize response (arriving after `rescanCurrentGenerationOnTabSizeChange`
   * had cleared the queue slot and reposted a NEW-tabSize chunk at the
   * same sourceVersion) to misassociate with the NEW chunk -- poisoning
   * the cache under the new tabSize key AND eating the legitimate new
   * response. With per-chunk ids the stale response simply finds no
   * matching chunk and is dropped.
   *
   * Invariant: every chunk in this Map has `sourceVersion ===
   * currentVersionSignal()`. `beginGeneration` clears the map, and
   * `rescanCurrentGenerationOnTabSizeChange` deletes the
   * currentVersion entries before reposting.
   */
  private readonly pendingChunksById = new Map<number, PendingChunk>();
  /**
   * Per-version pending chunk count. Kept in sync with `pendingChunksById`
   * so `refreshScanInFlight` can answer "any chunk for currentVersion?"
   * in O(1) without iterating the id map. Required for the editor hot
   * path where a large pasted blob can produce many chunks.
   */
  private readonly pendingChunkCountByVersion = new Map<number, number>();
  private readonly candidatesSignal: WritableSignal<ReadonlyMap<string, ExtractedJson>> = signal(
    new Map<string, ExtractedJson>(),
  );
  private readonly scannerUnavailableSignal = signal(false);
  private readonly scanInFlightSignal = signal(false);
  private readonly currentVersionSignal = signal(0);
  private worker: Worker | null = null;
  private nextVersion = 0;
  /**
   * Monotonic per-chunk identifier. NEVER reset by `beginGeneration` --
   * cross-generation collisions would re-enable a worse variant of the
   * bug fixed in PR #289 review. Number.MAX_SAFE_INTEGER (~9e15) is
   * astronomically more than any plausible service lifetime can produce.
   */
  private nextChunkId = 0;
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
    this.pendingChunksById.clear();
    this.pendingChunkCountByVersion.clear();
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

      // shouldScan is pure and deterministic over (rawString,
      // MAX_INPUT_LENGTH) -- the same input always yields the same
      // result. A prior memoization set was removed in the PR #289
      // review: it was dead code (a string that fails shouldScan once
      // would fail it on every subsequent call) and unbounded.
      // shouldScan is O(string-length) with V8-optimized
      // string.includes; recomputing is essentially free.
      if (!this.shouldScan(rawString)) {
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
    const chunkId = this.nextChunkId++;
    this.addPendingChunk(chunkId, sourceVersion, tabSize, chunk);
    const request: ScanRequest = {
      type: 'scan',
      sourceVersion,
      chunkId,
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
    chunkId: number,
    sourceVersion: number,
    tabSize: IndentSize,
    chunk: readonly string[],
  ): void {
    const ownedChunk: PendingChunk = { strings: [...chunk], tabSize, sourceVersion };
    this.pendingChunksById.set(chunkId, ownedChunk);
    const priorCount = this.pendingChunkCountByVersion.get(sourceVersion) ?? 0;
    this.pendingChunkCountByVersion.set(sourceVersion, priorCount + 1);
    this.refreshScanInFlight();
  }

  private popPendingChunk(chunkId: number): PendingChunk | undefined {
    const chunk = this.pendingChunksById.get(chunkId);
    if (!chunk) {
      return undefined;
    }
    this.pendingChunksById.delete(chunkId);
    const priorCount = this.pendingChunkCountByVersion.get(chunk.sourceVersion) ?? 0;
    if (priorCount <= 1) {
      this.pendingChunkCountByVersion.delete(chunk.sourceVersion);
    } else {
      this.pendingChunkCountByVersion.set(chunk.sourceVersion, priorCount - 1);
    }
    this.refreshScanInFlight();
    return chunk;
  }

  private refreshScanInFlight(): void {
    const currentVersion = this.currentVersionSignal();
    const pendingForCurrent = this.pendingChunkCountByVersion.get(currentVersion) ?? 0;
    this.scanInFlightSignal.set(!this.scannerUnavailableSignal() && pendingForCurrent > 0);
  }

  private handleWorkerMessage(event: MessageEvent<unknown>): void {
    if (this.scannerUnavailableSignal()) {
      return;
    }

    const message = event.data;
    if (!isScanResultMessage(message) || message.sourceVersion !== this.currentVersionSignal()) {
      return;
    }

    // Per-chunk lookup: a stale response whose chunk was deleted (by
    // beginGeneration, rescanCurrentGenerationOnTabSizeChange, or a
    // worker failure) finds no matching entry and is dropped. This is
    // the load-bearing guard against the PR #289 review TOCTOU bug.
    const chunk = this.popPendingChunk(message.chunkId);
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
   *
   * Pending chunks for the current sourceVersion are deleted before
   * reposting. PR #289 review: this is the load-bearing invariant
   * paired with per-chunk ids -- by removing the OLD chunkIds, a stale
   * worker response arriving after rescan finds no matching entry in
   * `pendingChunksById` and is dropped, instead of misassociating with
   * a NEW chunk and poisoning the cache.
   */
  private rescanCurrentGenerationOnTabSizeChange(): void {
    if (this.currentGenerationStrings.size === 0) {
      return;
    }
    const strings = [...this.currentGenerationStrings];
    this.currentGenerationStrings.clear();
    this.currentGenerationInFlight.clear();
    this.currentGenerationResults.clear();
    this.clearPendingChunksForVersion(this.currentVersionSignal());
    this.refreshScanInFlight();
    this.candidatesSignal.set(new Map<string, ExtractedJson>());
    this.enqueueScan(strings);
  }

  private clearPendingChunksForVersion(sourceVersion: number): void {
    // Invariant: only currentVersion chunks should be in the map (see
    // pendingChunksById JSDoc). Walk defensively anyway in case a
    // future change relaxes that invariant.
    for (const [chunkId, chunk] of this.pendingChunksById) {
      if (chunk.sourceVersion === sourceVersion) {
        this.pendingChunksById.delete(chunkId);
      }
    }
    this.pendingChunkCountByVersion.delete(sourceVersion);
  }

  private handleWorkerFailure(reason: ScannerUnavailableReason): void {
    if (!this.scannerUnavailableSignal()) {
      this.logger.warn('tree.stringExtractor.workerUnavailable', { reason });
    }
    this.scannerUnavailableSignal.set(true);
    this.currentGenerationInFlight.clear();
    this.pendingChunksById.clear();
    this.pendingChunkCountByVersion.clear();
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
    chunkId?: unknown;
    results?: unknown;
  };
  return (
    candidate.type === 'scanResult' &&
    typeof candidate.sourceVersion === 'number' &&
    typeof candidate.chunkId === 'number' &&
    Number.isInteger(candidate.chunkId) &&
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
