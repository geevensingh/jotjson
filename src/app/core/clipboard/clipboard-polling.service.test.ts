import { TestBed } from '@angular/core/testing';
import { type MockInstance } from 'vitest';
import { ClipboardPermissionState, ClipboardPollingService } from './clipboard-polling.service';

type ClipboardLike = Pick<Clipboard, 'readText' | 'writeText'>;

interface PermissionStatusStub {
  state: PermissionState;
  listeners: Array<(e: Event) => void>;
  addEventListener: MockInstance;
  removeEventListener: MockInstance;
  dispatchChange(newState: PermissionState): void;
}

function makeStatus(initial: PermissionState): PermissionStatusStub {
  const stub: PermissionStatusStub = {
    state: initial,
    listeners: [],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchChange(newState) {
      stub.state = newState;
      const evt = { target: stub } as unknown as Event;
      for (const l of stub.listeners) l(evt);
    },
  };
  stub.addEventListener.mockImplementation((name: string, cb: (e: Event) => void) => {
    if (name === 'change') stub.listeners.push(cb);
  });
  return stub;
}

/**
 * Swap navigator.clipboard and navigator.permissions for the duration of a
 * spec. Returns a restore fn so tests never leak stubs into adjacent suites
 * (cf. the known Karma clipboard-spy bleed-through).
 */
function installNavigatorStubs(opts: {
  clipboard?: ClipboardLike | null;
  permissionsQuery?: MockInstance | null;
}): () => void {
  const origClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const origPermissions = Object.getOwnPropertyDescriptor(navigator, 'permissions');

  if (opts.clipboard === null) {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });
  } else if (opts.clipboard) {
    Object.defineProperty(navigator, 'clipboard', {
      value: opts.clipboard,
      configurable: true,
    });
  }

  if (opts.permissionsQuery === null) {
    Object.defineProperty(navigator, 'permissions', {
      value: undefined,
      configurable: true,
    });
  } else if (opts.permissionsQuery) {
    Object.defineProperty(navigator, 'permissions', {
      value: { query: opts.permissionsQuery },
      configurable: true,
    });
  }

  return () => {
    if (origClipboard) Object.defineProperty(navigator, 'clipboard', origClipboard);
    else delete (navigator as unknown as { clipboard?: Clipboard }).clipboard;
    if (origPermissions) Object.defineProperty(navigator, 'permissions', origPermissions);
    else delete (navigator as unknown as { permissions?: Permissions }).permissions;
  };
}

function notAllowedError(): Error {
  const err = new Error('not allowed');
  err.name = 'NotAllowedError';
  return err;
}

async function flush(): Promise<void> {
  // Wait for queued microtasks (permission query + initial checkOnce) to drain.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveDeferred: (value: T | PromiseLike<T>) => void = () => {
    throw new Error('Deferred resolve called before initialization');
  };
  let rejectDeferred: (reason?: unknown) => void = () => {
    throw new Error('Deferred reject called before initialization');
  };
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

describe('ClipboardPollingService', () => {
  let restore: () => void = () => {};

  // Defensive backstop: snapshot the truly-original navigator.clipboard /
  // navigator.permissions descriptors once before any test in this suite
  // can install a stub. If a test (or test helper) ever forgets to restore
  // - or stacks two installNavigatorStubs() calls in a single spec without
  // restoring between them - afterAll will still put the originals back so
  // a stub does not leak into adjacent suites that vi.spyOn(navigator.clipboard,
  // 'writeText'/'readText') directly. Without this guard, a leaked stub
  // whose methods are jasmine spies trips Jasmine's "already been spied
  // upon" guard in later specs (observed in CI on Linux Chrome Headless).
  let suiteOrigClipboard: PropertyDescriptor | undefined;
  let suiteOrigPermissions: PropertyDescriptor | undefined;
  beforeAll(() => {
    suiteOrigClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    suiteOrigPermissions = Object.getOwnPropertyDescriptor(navigator, 'permissions');
  });
  afterAll(() => {
    if (suiteOrigClipboard) {
      Object.defineProperty(navigator, 'clipboard', suiteOrigClipboard);
    } else {
      delete (navigator as unknown as { clipboard?: Clipboard }).clipboard;
    }
    if (suiteOrigPermissions) {
      Object.defineProperty(navigator, 'permissions', suiteOrigPermissions);
    } else {
      delete (navigator as unknown as { permissions?: Permissions }).permissions;
    }
  });

  afterEach(() => {
    restore();
    restore = () => {};
  });

  // FIX FOR #140: pin document.visibilityState='visible' for every test in
  // this file. ClipboardPollingService.startPolling() early-returns when
  // visibility is 'hidden' (intentional production behavior to save CPU when
  // the tab is backgrounded), so under headless Chrome on CI -- which can
  // transiently report 'hidden' -- the constructor's startPolling() call
  // becomes a no-op and pollHandle stays null, leaving the test's
  // clock.tick() with no interval to fire. Pinning visibility here mirrors
  // the real-user condition (page is visible while you're using JotJSON)
  // and isolates the suite from headless Chrome's visibility flakiness.
  let visibilityDescriptor: PropertyDescriptor | undefined;
  beforeEach(() => {
    visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
  });
  afterEach(() => {
    if (visibilityDescriptor) {
      Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
    } else {
      delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    }
  });

  function createService(opts: {
    readText?: MockInstance;
    permissionsQuery?: MockInstance | null;
    clipboardMissing?: boolean;
  }): ClipboardPollingService {
    // Restore any prior stubs first. Without this, back-to-back createService
    // calls in a single `it` would stack: the second installNavigatorStubs
    // would capture the first call's STUB as the "original" descriptor, and
    // afterEach's restore would put the first stub back instead of the real
    // clipboard - leaking a stubbed navigator.clipboard whose writeText is
    // already a jasmine spy into adjacent suites.
    restore();
    restore = () => {};

    const clipboard: ClipboardLike | null = opts.clipboardMissing
      ? null
      : {
          readText: opts.readText ?? vi.fn().mockResolvedValue(''),
          writeText: vi.fn().mockResolvedValue(undefined),
        };
    restore = installNavigatorStubs({
      clipboard,
      permissionsQuery:
        opts.permissionsQuery === undefined
          ? vi.fn().mockResolvedValue(makeStatus('prompt'))
          : opts.permissionsQuery,
    });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    return TestBed.inject(ClipboardPollingService);
  }

  it('sets permissionReady after async permission discovery settles', async () => {
    const permissionCases: Array<{
      name: string;
      permissionsQuery: MockInstance;
      expectedState: ClipboardPermissionState;
    }> = [
      {
        name: 'granted',
        permissionsQuery: vi.fn().mockResolvedValue(makeStatus('granted')),
        expectedState: 'granted',
      },
      {
        name: 'denied',
        permissionsQuery: vi.fn().mockResolvedValue(makeStatus('denied')),
        expectedState: 'denied',
      },
      {
        name: 'prompt',
        permissionsQuery: vi.fn().mockResolvedValue(makeStatus('prompt')),
        expectedState: 'prompt',
      },
      {
        name: 'Firefox throw',
        permissionsQuery: vi.fn().mockRejectedValue(new Error('nope')),
        expectedState: 'unknown',
      },
    ];

    for (const permissionCase of permissionCases) {
      const svc = createService({ permissionsQuery: permissionCase.permissionsQuery });
      expect(svc.permissionReady(), permissionCase.name).toBe(false);
      await flush();
      expect(svc.permissionReady(), permissionCase.name).toBe(true);
      expect(svc.permissionState(), permissionCase.name).toBe(permissionCase.expectedState);
    }
  });

  it('sets permissionReady synchronously when navigator.clipboard is missing', () => {
    const svc = createService({ clipboardMissing: true });
    expect(svc.permissionReady()).toBe(true);
    expect(svc.permissionState()).toBe('unsupported');
  });

  it('sets permissionReady synchronously when navigator.permissions is unavailable', () => {
    const svc = createService({ permissionsQuery: null });
    expect(svc.permissionReady()).toBe(true);
    expect(svc.permissionState()).toBe('unknown');
  });

  it('reports unsupported when navigator.clipboard is missing', async () => {
    const svc = createService({ clipboardMissing: true });
    await flush();
    expect(svc.permissionState()).toBe('unsupported');
  });

  it('reports unknown when permissions.query throws (Firefox)', async () => {
    const svc = createService({
      permissionsQuery: vi.fn().mockRejectedValue(new Error('nope')),
    });
    await flush();
    expect(svc.permissionState()).toBe('unknown');
  });

  it('reports unknown when navigator.permissions is unavailable', async () => {
    const svc = createService({ permissionsQuery: null });
    await flush();
    expect(svc.permissionState()).toBe('unknown');
  });

  it('reports prompt when permission.state is prompt', async () => {
    const svc = createService({});
    await flush();
    expect(svc.permissionState()).toBe('prompt');
    expect(svc.hasJson()).toBe(false);
    expect(svc.preview()).toBe('');
  });

  it('upgrades directly to granted on successful enable() without waiting on onchange', async () => {
    const readText = vi.fn().mockResolvedValue('{"a":1}');
    const svc = createService({ readText });
    await flush();
    const state = await svc.enable();
    expect(state).toBe('granted');
    expect(svc.permissionState()).toBe('granted');
    expect(svc.hasJson()).toBe(true);
    expect(svc.preview()).toContain('{"a":1}');
  });

  it('flips to denied when enable() rejects with NotAllowedError', async () => {
    const readText = vi.fn().mockRejectedValue(notAllowedError());
    const svc = createService({ readText });
    await flush();
    const state = await svc.enable();
    expect(state).toBe('denied');
    expect(svc.permissionState()).toBe('denied');
    expect(svc.hasJson()).toBe(false);
  });

  it('does NOT flip to denied when a background checkOnce throws NotAllowedError (Safari no-gesture)', async () => {
    const readText = vi.fn().mockRejectedValue(notAllowedError());
    const svc = createService({ readText });
    await flush();
    await svc.checkOnce();
    expect(svc.permissionState()).toBe('prompt');
    expect(svc.hasJson()).toBe(false);
  });

  it('hasJson classification matches the paste predicate', async () => {
    let clipboardText = '';
    const readText = jasmine
      .createSpy('readText')
      .mockImplementation(() => Promise.resolve(clipboardText));
    const svc = createService({
      readText,
      permissionsQuery: vi.fn().mockResolvedValue(makeStatus('granted')),
    });
    await flush();

    const cases: { text: string; expected: boolean; name: string }[] = [
      { text: '{"a":1}', expected: true, name: 'raw JSON object' },
      { text: '[1,2,3]', expected: true, name: 'raw JSON array' },
      { text: '{ // comment\n "a": 1 }', expected: true, name: 'JSONC object' },
      { text: '{"a":', expected: true, name: 'partial-but-plausible' },
      { text: 'INFO {"a":1}', expected: true, name: 'mixed prose with object' },
      { text: 'log line with [array, here]', expected: true, name: 'mixed prose with array' },
      { text: 'hello world', expected: false, name: 'plain prose' },
      { text: '42 dollars', expected: false, name: 'numbers and prose' },
      { text: '', expected: false, name: 'empty' },
      { text: '   \n  \t', expected: false, name: 'whitespace only' },
      { text: '"{\\"a\\":1}"', expected: true, name: 'escaped JSON (literal { qualifies)' },
    ];

    for (const c of cases) {
      clipboardText = c.text;
      await svc.checkOnce();
      expect(svc.hasJson(), `case: ${c.name}`).toBe(c.expected);
    }
  });

  it('clears preview when clipboard no longer has JSON', async () => {
    let clipboardText = '{"a":1}';
    const readText = jasmine
      .createSpy('readText')
      .mockImplementation(() => Promise.resolve(clipboardText));
    const svc = createService({
      readText,
      permissionsQuery: vi.fn().mockResolvedValue(makeStatus('granted')),
    });
    await flush();
    await svc.checkOnce();
    expect(svc.preview()).not.toBe('');

    clipboardText = 'not json';
    await svc.checkOnce();
    expect(svc.hasJson()).toBe(false);
    expect(svc.preview()).toBe('');
  });

  it('truncates preview to 80 chars with ellipsis', async () => {
    const longKey = 'x'.repeat(200);
    const readText = vi.fn().mockResolvedValue(`{"${longKey}":1}`);
    const svc = createService({
      readText,
      permissionsQuery: vi.fn().mockResolvedValue(makeStatus('granted')),
    });
    await flush();
    await svc.checkOnce();
    const preview = svc.preview();
    expect(preview.length).toBeLessThanOrEqual(80);
    expect(preview.endsWith('...')).toBe(true);
  });

  it('readGrantedClipboardOnce waits for permission readiness before deciding', async () => {
    const permissionStatus = createDeferred<PermissionStatusStub>();
    const permissionsQuery = vi.fn().mockReturnValue(permissionStatus.promise);
    const readText = vi.fn().mockResolvedValue('{"slow":true}');
    const svc = createService({ readText, permissionsQuery });

    const resultPromise = svc.readGrantedClipboardOnce('coldBootAutoPaste');
    await flush();
    expect(svc.permissionReady()).toBe(false);
    expect(readText).not.toHaveBeenCalled();

    permissionStatus.resolve(makeStatus('denied'));
    const result = await resultPromise;

    expect(svc.permissionReady()).toBe(true);
    expect(result).toEqual({ ok: false });
    expect(readText).not.toHaveBeenCalled();
  });

  it('readGrantedClipboardOnce returns text and updates derived clipboard state when granted', async () => {
    let clipboardText = 'not json';
    const readText = jasmine
      .createSpy('readText')
      .mockImplementation(() => Promise.resolve(clipboardText));
    const svc = createService({
      readText,
      permissionsQuery: vi.fn().mockResolvedValue(makeStatus('granted')),
    });
    await flush();
    expect(svc.hasJson()).toBe(false);
    readText.mockClear();

    clipboardText = '{"cold":true}';
    const result = await svc.readGrantedClipboardOnce('coldBootAutoPaste');

    expect(result).toEqual({ ok: true, text: '{"cold":true}' });
    expect(readText).toHaveBeenCalledTimes(1);
    expect(svc.hasJson()).toBe(true);
    expect(svc.preview()).toContain('"cold"');
  });

  it('readGrantedClipboardOnce returns false without reading when permission is denied or prompt', async () => {
    const permissionStates: PermissionState[] = ['denied', 'prompt'];

    for (const permissionState of permissionStates) {
      const readText = vi.fn().mockResolvedValue('{"blocked":true}');
      const svc = createService({
        readText,
        permissionsQuery: vi.fn().mockResolvedValue(makeStatus(permissionState)),
      });
      await flush();
      readText.mockClear();

      const result = await svc.readGrantedClipboardOnce('coldBootAutoPaste');

      expect(result, permissionState).toEqual({ ok: false });
      expect(readText, permissionState).not.toHaveBeenCalled();
    }
  });

  it('readGrantedClipboardOnce keeps granted permission when readText throws NotAllowedError', async () => {
    const readText = vi.fn().mockResolvedValue('');
    const svc = createService({
      readText,
      permissionsQuery: vi.fn().mockResolvedValue(makeStatus('granted')),
    });
    await flush();
    readText.mockClear();
    readText.mockRejectedValue(notAllowedError());

    const result = await svc.readGrantedClipboardOnce('coldBootAutoPaste');

    expect(result).toEqual({ ok: false });
    expect(readText).toHaveBeenCalledTimes(1);
    expect(svc.permissionState()).toBe('granted');
  });

  it('readGrantedClipboardOnce coalesces concurrent reads', async () => {
    const clipboardRead = createDeferred<string>();
    const readText = vi.fn().mockReturnValue(clipboardRead.promise);
    const svc = createService({
      readText,
      permissionsQuery: vi.fn().mockResolvedValue(makeStatus('granted')),
    });
    await flush();
    readText.mockClear();

    const firstRead = svc.readGrantedClipboardOnce('coldBootAutoPaste');
    const secondRead = svc.readGrantedClipboardOnce('coldBootAutoPaste');

    expect(firstRead).toBe(secondRead);
    // The internal `await permissionDiscoveryPromise` inserts a microtask
    // boundary even when permission discovery is already settled, so we
    // need to drain the queue before asserting `readText` was called.
    await flush();
    expect(readText).toHaveBeenCalledTimes(1);

    clipboardRead.resolve('{"coalesced":true}');
    const firstResult = await firstRead;
    const secondResult = await secondRead;

    expect(firstResult).toEqual({ ok: true, text: '{"coalesced":true}' });
    expect(secondResult).toBe(firstResult);
  });

  it('readGrantedClipboardOnce starts a new read after the previous read settles', async () => {
    let clipboardText = '{"first":true}';
    const readText = jasmine
      .createSpy('readText')
      .mockImplementation(() => Promise.resolve(clipboardText));
    const svc = createService({
      readText,
      permissionsQuery: vi.fn().mockResolvedValue(makeStatus('granted')),
    });
    await flush();
    readText.mockClear();

    const firstResult = await svc.readGrantedClipboardOnce('coldBootAutoPaste');
    clipboardText = '{"second":true}';
    const secondResult = await svc.readGrantedClipboardOnce('coldBootAutoPaste');

    expect(readText).toHaveBeenCalledTimes(2);
    expect(firstResult).toEqual({ ok: true, text: '{"first":true}' });
    expect(secondResult).toEqual({ ok: true, text: '{"second":true}' });
  });

  it('readForPaste performs exactly one readText call and returns the raw value', async () => {
    const readText = vi.fn().mockResolvedValue('{"a":1}');
    const svc = createService({
      readText,
      permissionsQuery: vi.fn().mockResolvedValue(makeStatus('granted')),
    });
    await flush();
    readText.mockClear();
    const result = await svc.readForPaste();
    expect(result).toBe('{"a":1}');
    expect(readText).toHaveBeenCalledTimes(1);
  });

  it('startPolling is idempotent (no duplicate intervals)', async () => {
    vi.useFakeTimers();
    try {
      const readText = vi.fn().mockResolvedValue('{"a":1}');
      const svc = createService({
        readText,
        permissionsQuery: vi.fn().mockResolvedValue(makeStatus('granted')),
      });
      await flush();
      readText.mockClear();

      svc.startPolling();
      svc.startPolling();
      svc.startPolling();

      vi.advanceTimersByTime(2001);
      await flush();
      expect(readText).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2001);
      await flush();
      expect(readText).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('startPolling no-ops when state is not granted', async () => {
    vi.useFakeTimers();
    try {
      const readText = vi.fn().mockResolvedValue('{"a":1}');
      const svc = createService({ readText });
      await flush();
      readText.mockClear();

      svc.startPolling();
      vi.advanceTimersByTime(5000);
      await flush();
      expect(readText).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stopPolling halts the interval and destroy cleans up', async () => {
    vi.useFakeTimers();
    try {
      const readText = vi.fn().mockResolvedValue('{"a":1}');
      const svc = createService({
        readText,
        permissionsQuery: vi.fn().mockResolvedValue(makeStatus('granted')),
      });
      await flush();
      svc.startPolling();
      readText.mockClear();

      svc.stopPolling();
      vi.advanceTimersByTime(5000);
      await flush();
      expect(readText).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('permission change to denied clears derived state', async () => {
    const status = makeStatus('granted');
    const readText = vi.fn().mockResolvedValue('{"a":1}');
    const svc = createService({
      readText,
      permissionsQuery: vi.fn().mockResolvedValue(status),
    });
    await flush();
    expect(svc.permissionState()).toBe('granted');

    status.dispatchChange('denied');
    expect(svc.permissionState()).toBe('denied');
    expect(svc.hasJson()).toBe(false);
    expect(svc.preview()).toBe('');
  });

  describe('looksLikeJson (M7p widening)', () => {
    async function classify(text: string): Promise<boolean> {
      const readText = vi.fn().mockResolvedValue(text);
      const svc = createService({
        readText,
        permissionsQuery: vi.fn().mockResolvedValue(makeStatus('granted')),
      });
      await flush();
      await svc.checkOnce();
      return svc.hasJson();
    }

    it('returns true for prose preceding a JSON object', async () => {
      expect(await classify('INFO log {"a":1}')).toBe(true);
    });

    it('returns true for prose surrounding a JSON array', async () => {
      expect(await classify('see results: [1,2,3] (count=3)')).toBe(true);
    });

    it('returns true when only a stray brace appears (gate is plausibility-only)', async () => {
      expect(await classify('value is { somewhere')).toBe(true);
    });

    it('returns true for escaped JSON literals (the literal { qualifies)', async () => {
      expect(await classify('"{\\"a\\":1}"')).toBe(true);
    });

    it('returns false for prose without { or [ anywhere', async () => {
      expect(await classify('just a normal sentence with no json')).toBe(false);
    });

    it('returns false for numeric-only prose', async () => {
      expect(await classify('42 dollars and 99 cents')).toBe(false);
    });

    it('returns false for empty and whitespace-only text', async () => {
      expect(await classify('')).toBe(false);
      expect(await classify('   \n\t  ')).toBe(false);
    });
  });
});
