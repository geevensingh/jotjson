import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import type { Signal, WritableSignal } from '@angular/core';
import { LoggerService } from '../telemetry/logger.service';
import { MAX_INPUT_LENGTH } from './json-extractor.core';
import type { ExtractedJson } from './json-extractor.core';

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
  hasComments: boolean;
}

type CachedExtraction = ExtractedJson | null;
type ScannerUnavailableReason = 'factory' | 'postMessage' | 'error' | 'messageerror';

@Injectable({ providedIn: 'root' })
export class TreeStringExtractorService {
  private readonly logger = inject(LoggerService);
  private readonly workerFactory = inject(WORKER_FACTORY);
  private readonly cache = new Map<string, CachedExtraction>();
  private readonly currentGenerationStrings = new Set<string>();
  private readonly currentGenerationInFlight = new Set<string>();
  private readonly currentGenerationResults = new Map<string, ExtractedJson>();
  private readonly pendingChunksByVersion = new Map<number, string[][]>();
  private readonly candidatesSignal: WritableSignal<ReadonlyMap<string, ExtractedJson>> = signal(
    new Map<string, ExtractedJson>(),
  );
  private readonly scannerUnavailableSignal = signal(false);
  private readonly scanInFlightSignal = signal(false);
  private readonly currentVersionSignal = signal(0);
  private worker: Worker | null = null;
  private nextVersion = 0;

  readonly candidates: Signal<ReadonlyMap<string, ExtractedJson>> =
    this.candidatesSignal.asReadonly();
  readonly scannerUnavailable: Signal<boolean> = this.scannerUnavailableSignal.asReadonly();
  readonly scanInFlight: Signal<boolean> = this.scanInFlightSignal.asReadonly();
  readonly currentVersion: Signal<number> = this.currentVersionSignal.asReadonly();

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
    const queuedStrings: string[] = [];
    let hasImmediateCandidateChange = false;

    for (const rawString of new Set(strings)) {
      this.currentGenerationStrings.add(rawString);

      if (!this.shouldScan(rawString)) {
        this.setCachedResult(rawString, null);
        continue;
      }

      const cachedResult = this.getCachedResult(rawString);
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
      this.postChunk(worker, sourceVersion, chunk);
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

  private getCachedResult(rawString: string): CachedExtraction | undefined {
    if (!this.cache.has(rawString)) {
      return undefined;
    }

    const cachedResult = this.cache.get(rawString);
    this.cache.delete(rawString);
    if (cachedResult === undefined) {
      return undefined;
    }
    this.cache.set(rawString, cachedResult);
    return cachedResult;
  }

  private setCachedResult(rawString: string, result: CachedExtraction): void {
    if (this.cache.has(rawString)) {
      this.cache.delete(rawString);
    }
    this.cache.set(rawString, result);

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

  private postChunk(worker: Worker, sourceVersion: number, chunk: readonly string[]): void {
    this.addPendingChunk(sourceVersion, chunk);
    const request: ScanRequest = {
      type: 'scan',
      sourceVersion,
      strings: chunk,
    };

    try {
      worker.postMessage(request);
    } catch {
      this.handleWorkerFailure('postMessage');
    }
  }

  private addPendingChunk(sourceVersion: number, chunk: readonly string[]): void {
    const existingChunks = this.pendingChunksByVersion.get(sourceVersion);
    const ownedChunk = [...chunk];
    if (existingChunks) {
      existingChunks.push(ownedChunk);
      return;
    }
    this.pendingChunksByVersion.set(sourceVersion, [ownedChunk]);
    this.refreshScanInFlight();
  }

  private shiftPendingChunk(sourceVersion: number): string[] | undefined {
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
    for (let index = 0; index < chunk.length; index++) {
      const rawString = chunk[index];
      if (rawString === undefined) {
        continue;
      }

      this.currentGenerationInFlight.delete(rawString);
      const wireResult = message.results[index] ?? null;
      const result = wireResult ? toExtractedJson(wireResult) : null;
      this.setCachedResult(rawString, result);
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
    hasComments: wireResult.hasComments,
  };
}
