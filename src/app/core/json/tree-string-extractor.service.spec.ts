import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { UserPreferences } from '../api/models';
import { DEFAULT_PREFERENCES, PreferencesService } from '../preferences/preferences.service';
import { LoggerService } from '../telemetry/logger.service';
import type { ExtractedJson, IndentSize } from './json-extractor.core';
import { MAX_INPUT_LENGTH } from './json-extractor.core';
import {
  TREE_STRING_EXTRACTOR_BATCH_SIZE,
  TREE_STRING_EXTRACTOR_CACHE_CAPACITY,
  TreeStringExtractorService,
  WORKER_FACTORY,
} from './tree-string-extractor.service';

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

class MockWorker {
  readonly postedMessages: ScanRequest[] = [];
  throwOnPostMessage = false;
  private readonly workerShape: Partial<Worker> = {
    postMessage: (message: unknown) => this.capturePostMessage(message),
    terminate: () => undefined,
  };

  asWorker(): Worker {
    return this.workerShape as Worker;
  }

  respondToMessage(
    messageIndex: number,
    results?: readonly (ExtractedJsonWireFormat | null)[],
  ): void {
    const request = this.requirePostedMessage(messageIndex);
    this.emitScanResult({
      type: 'scanResult',
      sourceVersion: request.sourceVersion,
      results: results ?? request.strings.map((rawString) => wireResultFor(rawString)),
    });
  }

  respondToMessages(startIndex: number, endIndex: number): void {
    for (let messageIndex = startIndex; messageIndex < endIndex; messageIndex++) {
      this.respondToMessage(messageIndex);
    }
  }

  emitScanResult(message: ScanResultMessage): void {
    const handler = this.workerShape.onmessage;
    if (!handler) {
      throw new Error('Expected worker onmessage handler to be registered');
    }
    handler.call(this.asWorker(), new MessageEvent('message', { data: message }));
  }

  emitError(): void {
    const handler = this.workerShape.onerror;
    if (!handler) {
      throw new Error('Expected worker onerror handler to be registered');
    }
    handler.call(this.asWorker(), new ErrorEvent('error'));
  }

  emitMessageError(): void {
    const handler = this.workerShape.onmessageerror;
    if (!handler) {
      throw new Error('Expected worker onmessageerror handler to be registered');
    }
    handler.call(this.asWorker(), new MessageEvent('messageerror'));
  }

  requirePostedMessage(messageIndex: number): ScanRequest {
    const request = this.postedMessages[messageIndex];
    if (request === undefined) {
      throw new Error(`Expected posted worker message at index ${messageIndex}`);
    }
    return request;
  }

  private capturePostMessage(message: unknown): void {
    if (this.throwOnPostMessage) {
      throw new Error('postMessage failed');
    }
    if (!isScanRequest(message)) {
      throw new Error('Expected a scan request');
    }
    this.postedMessages.push(message);
  }
}

describe('TreeStringExtractorService', () => {
  let service: TreeStringExtractorService;
  let mockWorker: MockWorker;
  let logger: jasmine.SpyObj<LoggerService>;
  let prefsSignal: ReturnType<typeof signal<UserPreferences>>;
  let prefsStub: Pick<PreferencesService, 'prefs'>;

  function createPrefsStub(initial: UserPreferences): {
    signal: ReturnType<typeof signal<UserPreferences>>;
    stub: Pick<PreferencesService, 'prefs'>;
  } {
    const stateSignal = signal<UserPreferences>(initial);
    const stub = { prefs: stateSignal.asReadonly() } as Pick<PreferencesService, 'prefs'>;
    return { signal: stateSignal, stub };
  }

  beforeEach(() => {
    mockWorker = new MockWorker();
    logger = jasmine.createSpyObj<LoggerService>('LoggerService', ['warn']);
    const created = createPrefsStub({ ...DEFAULT_PREFERENCES });
    prefsSignal = created.signal;
    prefsStub = created.stub;
    TestBed.configureTestingModule({
      providers: [
        { provide: WORKER_FACTORY, useValue: () => mockWorker.asWorker() },
        { provide: LoggerService, useValue: logger },
        { provide: PreferencesService, useValue: prefsStub },
      ],
    });
    service = TestBed.inject(TreeStringExtractorService);
    service.beginGeneration();
    // Flush the constructor's first-sync effect run so `lastObservedTabSize`
    // captures the initial prefs value. Without this, the next
    // `prefsSignal.set(...)` would be observed as the "first" tabSize and
    // would not trigger a rescan.
    TestBed.flushEffects();
  });

  it('rejects strings shorter than two characters', () => {
    service.enqueueScan(['', '{']);

    expect(mockWorker.postedMessages).toEqual([]);
    expect(service.candidates().size).toBe(0);
  });

  it('rejects strings without object or array delimiters', () => {
    service.enqueueScan(['plain text', 'true', '42']);

    expect(mockWorker.postedMessages).toEqual([]);
    expect(service.candidates().size).toBe(0);
  });

  it('rejects strings longer than the maximum extractor input length', () => {
    const oversizedString = `{${'x'.repeat(MAX_INPUT_LENGTH)}}`;

    service.enqueueScan([oversizedString]);

    expect(mockWorker.postedMessages).toEqual([]);
    expect(service.candidates().size).toBe(0);
  });

  it('scans a duplicate string once within a generation', () => {
    const rawString = rawJsonString(1);

    service.enqueueScan([rawString, rawString]);
    service.enqueueScan([rawString]);

    expect(mockWorker.postedMessages.length).toBe(1);
    expect(mockWorker.requirePostedMessage(0).strings).toEqual([rawString]);

    mockWorker.respondToMessage(0);
    service.enqueueScan([rawString]);

    expect(mockWorker.postedMessages.length).toBe(1);
    expectCandidateText(rawString, rawString);
  });

  it('serves cached strings across generation rollovers', () => {
    const rawString = rawJsonString(2);

    service.enqueueScan([rawString]);
    mockWorker.respondToMessage(0);
    expectCandidateText(rawString, rawString);

    service.beginGeneration();
    expect(service.candidates().size).toBe(0);

    service.enqueueScan([rawString]);

    expect(mockWorker.postedMessages.length).toBe(1);
    expectCandidateText(rawString, rawString);
  });

  it('evicts the least recently used cache entry while preserving touched entries', () => {
    const cachedStrings = Array.from(
      { length: TREE_STRING_EXTRACTOR_CACHE_CAPACITY },
      (_unused, index) => rawJsonString(index),
    );
    const firstString = requireString(cachedStrings, 0);
    const secondString = requireString(cachedStrings, 1);
    const initialChunkCount =
      TREE_STRING_EXTRACTOR_CACHE_CAPACITY / TREE_STRING_EXTRACTOR_BATCH_SIZE;

    service.enqueueScan(cachedStrings);
    expect(mockWorker.postedMessages.length).toBe(initialChunkCount);
    mockWorker.respondToMessages(0, initialChunkCount);

    service.beginGeneration();
    service.enqueueScan([firstString]);
    expect(mockWorker.postedMessages.length).toBe(initialChunkCount);
    expectCandidateText(firstString, firstString);

    const newString = rawJsonString(TREE_STRING_EXTRACTOR_CACHE_CAPACITY);
    service.enqueueScan([newString]);
    expect(mockWorker.postedMessages.length).toBe(initialChunkCount + 1);
    mockWorker.respondToMessage(initialChunkCount);

    service.beginGeneration();
    service.enqueueScan([firstString, secondString]);

    expect(mockWorker.postedMessages.length).toBe(initialChunkCount + 2);
    expect(mockWorker.requirePostedMessage(initialChunkCount + 1).strings).toEqual([secondString]);
    expectCandidateText(firstString, firstString);
    expect(service.candidates().has(secondString)).toBeFalse();
  });

  it('drops stale worker responses when a newer generation starts', () => {
    const oldString = rawJsonString(10);
    const newString = rawJsonString(11);

    service.enqueueScan([oldString]);
    const oldRequest = mockWorker.requirePostedMessage(0);

    service.beginGeneration();
    service.enqueueScan([newString]);
    const newRequest = mockWorker.requirePostedMessage(1);

    mockWorker.emitScanResult({
      type: 'scanResult',
      sourceVersion: oldRequest.sourceVersion,
      results: [wireResultFor(oldString)],
    });

    expect(service.candidates().size).toBe(0);

    mockWorker.emitScanResult({
      type: 'scanResult',
      sourceVersion: newRequest.sourceVersion,
      results: [wireResultFor(newString)],
    });

    expect(service.candidates().has(oldString)).toBeFalse();
    expectCandidateText(newString, newString);
  });

  it('stops posting cache misses after a worker error', () => {
    const rawString = rawJsonString(20);

    service.enqueueScan([rawString]);
    mockWorker.emitError();
    service.enqueueScan([rawJsonString(21)]);

    expect(service.scannerUnavailable()).toBeTrue();
    expect(mockWorker.postedMessages.length).toBe(1);
    expect(logger.warn).toHaveBeenCalledOnceWith('tree.stringExtractor.workerUnavailable', {
      reason: 'error',
    });
  });

  it('serves cached candidates after the worker becomes unavailable', () => {
    const cachedString = rawJsonString(22);

    service.enqueueScan([cachedString]);
    mockWorker.respondToMessage(0);
    mockWorker.emitError();

    service.beginGeneration();
    service.enqueueScan([cachedString, rawJsonString(23)]);

    expect(service.scannerUnavailable()).toBeTrue();
    expect(mockWorker.postedMessages.length).toBe(1);
    expectCandidateText(cachedString, cachedString);
  });

  it('marks the scanner unavailable when worker creation fails', () => {
    TestBed.resetTestingModule();
    logger = jasmine.createSpyObj<LoggerService>('LoggerService', ['warn']);
    const fallbackPrefs = createPrefsStub({ ...DEFAULT_PREFERENCES });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: WORKER_FACTORY,
          useValue: () => {
            throw new Error('Worker creation failed');
          },
        },
        { provide: LoggerService, useValue: logger },
        { provide: PreferencesService, useValue: fallbackPrefs.stub },
      ],
    });
    service = TestBed.inject(TreeStringExtractorService);
    service.beginGeneration();

    service.enqueueScan([rawJsonString(24)]);

    expect(service.scannerUnavailable()).toBeTrue();
    expect(logger.warn).toHaveBeenCalledOnceWith('tree.stringExtractor.workerUnavailable', {
      reason: 'factory',
    });
  });

  it('marks the scanner unavailable when posting to the worker fails', () => {
    mockWorker.throwOnPostMessage = true;

    service.enqueueScan([rawJsonString(25)]);

    expect(service.scannerUnavailable()).toBeTrue();
    expect(mockWorker.postedMessages.length).toBe(0);
    expect(logger.warn).toHaveBeenCalledOnceWith('tree.stringExtractor.workerUnavailable', {
      reason: 'postMessage',
    });
  });

  it('grows candidates progressively as worker chunks respond', () => {
    const strings = Array.from({ length: 200 }, (_unused, index) => rawJsonString(index + 100));

    service.enqueueScan(strings);

    expect(service.scanInFlight()).toBeTrue();
    expect(mockWorker.postedMessages.length).toBe(4);
    for (let messageIndex = 0; messageIndex < 4; messageIndex++) {
      mockWorker.respondToMessage(messageIndex);
      expect(service.candidates().size).toBe((messageIndex + 1) * TREE_STRING_EXTRACTOR_BATCH_SIZE);
      expect(service.scanInFlight()).toBe(messageIndex < 3);
    }
  });

  it('clears current generation candidates while keeping cache entries across generations', () => {
    const oldString = rawJsonString(30);
    const newString = rawJsonString(31);

    service.enqueueScan([oldString]);
    mockWorker.respondToMessage(0);
    expectCandidateText(oldString, oldString);

    service.beginGeneration();
    expect(service.candidates().size).toBe(0);

    service.enqueueScan([newString]);
    mockWorker.respondToMessage(1);
    expect(service.candidates().has(oldString)).toBeFalse();
    expectCandidateText(newString, newString);

    service.enqueueScan([oldString]);
    expect(mockWorker.postedMessages.length).toBe(2);
    expectCandidateText(oldString, oldString);
  });

  it('surfaces cached candidates while rejecting pre-screened strings', () => {
    const cachedString = rawJsonString(40);

    service.enqueueScan([cachedString]);
    mockWorker.respondToMessage(0);

    service.beginGeneration();
    service.enqueueScan(['not extractable', 'x', cachedString]);

    expect(mockWorker.postedMessages.length).toBe(1);
    expect(service.candidates().size).toBe(1);
    expectCandidateText(cachedString, cachedString);
  });

  it('leaves signals unchanged for an empty scan request', () => {
    service.enqueueScan([]);

    expect(mockWorker.postedMessages).toEqual([]);
    expect(service.candidates().size).toBe(0);
    expect(service.scannerUnavailable()).toBeFalse();
  });

  it('stops posting cache misses after a worker message error', () => {
    service.enqueueScan([rawJsonString(50)]);
    mockWorker.emitMessageError();
    service.enqueueScan([rawJsonString(51)]);

    expect(service.scannerUnavailable()).toBeTrue();
    expect(service.scanInFlight()).toBeFalse();
    expect(mockWorker.postedMessages.length).toBe(1);
    expect(logger.warn).toHaveBeenCalledOnceWith('tree.stringExtractor.workerUnavailable', {
      reason: 'messageerror',
    });
  });

  it('reports scanInFlight while a worker request is pending', () => {
    const rawString = rawJsonString(60);

    expect(service.scanInFlight()).toBeFalse();

    service.enqueueScan([rawString]);

    expect(service.scanInFlight()).toBeTrue();

    mockWorker.respondToMessage(0);

    expect(service.scanInFlight()).toBeFalse();
  });

  it('resets scanInFlight when a new generation begins', () => {
    service.enqueueScan([rawJsonString(61)]);
    expect(service.scanInFlight()).toBeTrue();

    service.beginGeneration();

    expect(service.scanInFlight()).toBeFalse();
  });

  it('keeps scanInFlight false when all results are served from cache', () => {
    const rawString = rawJsonString(62);
    service.enqueueScan([rawString]);
    mockWorker.respondToMessage(0);

    service.beginGeneration();
    service.enqueueScan([rawString]);

    expect(service.scanInFlight()).toBeFalse();
    expectCandidateText(rawString, rawString);
  });

  it('forwards prose segment counts from worker results', () => {
    const rawString = rawJsonString(63);

    service.enqueueScan([rawString]);
    mockWorker.respondToMessage(0, [
      {
        text: '{"prefix":"before ","json":{"id":63}}',
        blockCount: 1,
        preservesComments: true,
        proseSegments: 1,
        hasComments: false,
      },
    ]);

    const candidate = service.candidates().get(rawString);
    expect(candidate).toBeDefined();
    expect(candidate?.proseSegments).toBe(1);
  });

  describe('tabSize', () => {
    // Issue #253: editor tab-size preference must propagate to the
    // worker request and govern cache keying so visible indent
    // matches the user's preference at all times.

    it('posts the current prefs editorTabSize on each scan request', () => {
      prefsSignal.set({ ...DEFAULT_PREFERENCES, editorTabSize: 4 });
      TestBed.flushEffects();

      service.beginGeneration();
      service.enqueueScan([rawJsonString(70)]);

      expect(mockWorker.requirePostedMessage(0).tabSize).toBe(4);
    });

    it('captures tabSize at dispatch so mid-flight pref flips do not corrupt the cache (TOCTOU regression)', () => {
      const rawString = rawJsonString(71);

      // Dispatch at tabSize=2.
      service.enqueueScan([rawString]);
      expect(mockWorker.requirePostedMessage(0).tabSize).toBe(2);

      // Flip prefs to 4 BEFORE responding. The pending chunk must
      // still cache the result under tabSize=2 because that is the
      // tabSize the worker formatted at.
      prefsSignal.set({ ...DEFAULT_PREFERENCES, editorTabSize: 4 });

      mockWorker.respondToMessage(0);

      // The flushed effect will trigger a re-scan at tabSize=4. The
      // re-post must MISS the cache (different key) and dispatch a
      // fresh worker request with tabSize=4.
      TestBed.flushEffects();

      expect(mockWorker.postedMessages.length).toBe(2);
      expect(mockWorker.requirePostedMessage(1).tabSize).toBe(4);
      expect(mockWorker.requirePostedMessage(1).strings).toEqual([rawString]);
    });

    it('flipping editorTabSize invalidates current-generation results and re-scans', () => {
      const rawString = rawJsonString(72);

      service.enqueueScan([rawString]);
      mockWorker.respondToMessage(0);
      expectCandidateText(rawString, rawString);

      prefsSignal.set({ ...DEFAULT_PREFERENCES, editorTabSize: 4 });
      TestBed.flushEffects();

      // Stale results cleared until the new-tabSize chunk responds.
      expect(service.candidates().size).toBe(0);
      expect(mockWorker.postedMessages.length).toBe(2);
      expect(mockWorker.requirePostedMessage(1).tabSize).toBe(4);
    });

    it('serves a cached tabSize-4 result on re-flip without re-posting', () => {
      const rawString = rawJsonString(73);

      // Cache an entry at tabSize=2.
      service.enqueueScan([rawString]);
      mockWorker.respondToMessage(0);

      // Flip to 4: forces a re-scan at the new tabSize.
      prefsSignal.set({ ...DEFAULT_PREFERENCES, editorTabSize: 4 });
      TestBed.flushEffects();
      mockWorker.respondToMessage(1);

      // Flip back to 2: the tabSize=2 entry is still in the LRU,
      // so no fresh worker post is needed.
      prefsSignal.set({ ...DEFAULT_PREFERENCES, editorTabSize: 2 });
      TestBed.flushEffects();

      expect(mockWorker.postedMessages.length).toBe(2);
      expectCandidateText(rawString, rawString);
    });

    it('pre-screen failures are tabSize-independent (no re-post after tabSize flip)', () => {
      // Strings without `{` or `[` cannot have JSON regardless of
      // tabSize. They go into definitelyNullStrings, not the cache.
      service.enqueueScan(['plain text without delimiters']);
      expect(mockWorker.postedMessages).toEqual([]);

      prefsSignal.set({ ...DEFAULT_PREFERENCES, editorTabSize: 4 });
      TestBed.flushEffects();

      service.beginGeneration();
      service.enqueueScan(['plain text without delimiters']);

      expect(mockWorker.postedMessages).toEqual([]);
    });
  });

  function expectCandidateText(rawString: string, expectedText: string): void {
    const candidate = service.candidates().get(rawString);
    expect(candidate).toBeDefined();
    expect(candidate?.text).toBe(expectedText);
  }
});

function rawJsonString(index: number): string {
  return `candidate ${index} {"id":${index}}`;
}

function wireResultFor(rawString: string): ExtractedJson {
  return {
    text: rawString,
    blockCount: 1,
    preservesComments: true,
    proseSegments: 0,
    hasComments: false,
  };
}

function isScanRequest(value: unknown): value is ScanRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as {
    type?: unknown;
    sourceVersion?: unknown;
    tabSize?: unknown;
    strings?: unknown;
  };
  return (
    candidate.type === 'scan' &&
    typeof candidate.sourceVersion === 'number' &&
    (candidate.tabSize === 2 || candidate.tabSize === 4) &&
    Array.isArray(candidate.strings) &&
    candidate.strings.every((item) => typeof item === 'string')
  );
}

function requireString(strings: readonly string[], index: number): string {
  const value = strings[index];
  if (value === undefined) {
    throw new Error(`Expected string at index ${index}`);
  }
  return value;
}
