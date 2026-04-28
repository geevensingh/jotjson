import { TestBed } from '@angular/core/testing';
import {
  ClipboardPermissionState,
  ClipboardPollingService
} from './clipboard-polling.service';

type ClipboardLike = Pick<Clipboard, 'readText' | 'writeText'>;

interface PermissionStatusStub {
  state: PermissionState;
  listeners: Array<(e: Event) => void>;
  addEventListener: jasmine.Spy;
  removeEventListener: jasmine.Spy;
  dispatchChange(newState: PermissionState): void;
}

function makeStatus(initial: PermissionState): PermissionStatusStub {
  const stub: PermissionStatusStub = {
    state: initial,
    listeners: [],
    addEventListener: jasmine.createSpy('addEventListener'),
    removeEventListener: jasmine.createSpy('removeEventListener'),
    dispatchChange(newState) {
      stub.state = newState;
      const evt = { target: stub } as unknown as Event;
      for (const l of stub.listeners) l(evt);
    }
  };
  stub.addEventListener.and.callFake((name: string, cb: (e: Event) => void) => {
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
  permissionsQuery?: jasmine.Spy | null;
}): () => void {
  const origClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const origPermissions = Object.getOwnPropertyDescriptor(navigator, 'permissions');

  if (opts.clipboard === null) {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true
    });
  } else if (opts.clipboard) {
    Object.defineProperty(navigator, 'clipboard', {
      value: opts.clipboard,
      configurable: true
    });
  }

  if (opts.permissionsQuery === null) {
    Object.defineProperty(navigator, 'permissions', {
      value: undefined,
      configurable: true
    });
  } else if (opts.permissionsQuery) {
    Object.defineProperty(navigator, 'permissions', {
      value: { query: opts.permissionsQuery },
      configurable: true
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

describe('ClipboardPollingService', () => {
  let restore: () => void = () => {};

  afterEach(() => {
    restore();
    restore = () => {};
  });

  function createService(opts: {
    readText?: jasmine.Spy;
    permissionsQuery?: jasmine.Spy | null;
    clipboardMissing?: boolean;
  }): ClipboardPollingService {
    const clipboard: ClipboardLike | null = opts.clipboardMissing
      ? null
      : {
          readText: opts.readText ?? jasmine.createSpy('readText').and.resolveTo(''),
          writeText: jasmine.createSpy('writeText').and.resolveTo(undefined)
        };
    restore = installNavigatorStubs({
      clipboard,
      permissionsQuery:
        opts.permissionsQuery === undefined
          ? jasmine.createSpy('query').and.resolveTo(makeStatus('prompt'))
          : opts.permissionsQuery
    });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    return TestBed.inject(ClipboardPollingService);
  }

  it('reports unsupported when navigator.clipboard is missing', async () => {
    const svc = createService({ clipboardMissing: true });
    await flush();
    expect(svc.permissionState()).toBe('unsupported');
  });

  it('reports unknown when permissions.query throws (Firefox)', async () => {
    const svc = createService({
      permissionsQuery: jasmine.createSpy('query').and.rejectWith(new Error('nope'))
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
    const readText = jasmine.createSpy('readText').and.resolveTo('{"a":1}');
    const svc = createService({ readText });
    await flush();
    const state = await svc.enable();
    expect(state).toBe('granted');
    expect(svc.permissionState()).toBe('granted');
    expect(svc.hasJson()).toBe(true);
    expect(svc.preview()).toContain('{"a":1}');
  });

  it('flips to denied when enable() rejects with NotAllowedError', async () => {
    const readText = jasmine.createSpy('readText').and.rejectWith(notAllowedError());
    const svc = createService({ readText });
    await flush();
    const state = await svc.enable();
    expect(state).toBe('denied');
    expect(svc.permissionState()).toBe('denied');
    expect(svc.hasJson()).toBe(false);
  });

  it('does NOT flip to denied when a background checkOnce throws NotAllowedError (Safari no-gesture)', async () => {
    const readText = jasmine.createSpy('readText').and.rejectWith(notAllowedError());
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
      .and.callFake(() => Promise.resolve(clipboardText));
    const svc = createService({
      readText,
      permissionsQuery: jasmine.createSpy('query').and.resolveTo(makeStatus('granted'))
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
      { text: '"{\\"a\\":1}"', expected: true, name: 'escaped JSON (literal { qualifies)' }
    ];

    for (const c of cases) {
      clipboardText = c.text;
      await svc.checkOnce();
      expect(svc.hasJson())
        .withContext(`case: ${c.name}`)
        .toBe(c.expected);
    }
  });

  it('clears preview when clipboard no longer has JSON', async () => {
    let clipboardText = '{"a":1}';
    const readText = jasmine
      .createSpy('readText')
      .and.callFake(() => Promise.resolve(clipboardText));
    const svc = createService({
      readText,
      permissionsQuery: jasmine.createSpy('query').and.resolveTo(makeStatus('granted'))
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
    const readText = jasmine.createSpy('readText').and.resolveTo(`{"${longKey}":1}`);
    const svc = createService({
      readText,
      permissionsQuery: jasmine.createSpy('query').and.resolveTo(makeStatus('granted'))
    });
    await flush();
    await svc.checkOnce();
    const preview = svc.preview();
    expect(preview.length).toBeLessThanOrEqual(80);
    expect(preview.endsWith('...')).toBe(true);
  });

  it('readForPaste performs exactly one readText call and returns the raw value', async () => {
    const readText = jasmine.createSpy('readText').and.resolveTo('{"a":1}');
    const svc = createService({
      readText,
      permissionsQuery: jasmine.createSpy('query').and.resolveTo(makeStatus('granted'))
    });
    await flush();
    readText.calls.reset();
    const result = await svc.readForPaste();
    expect(result).toBe('{"a":1}');
    expect(readText).toHaveBeenCalledTimes(1);
  });

  it('startPolling is idempotent (no duplicate intervals)', async () => {
    jasmine.clock().install();
    try {
      const readText = jasmine.createSpy('readText').and.resolveTo('{"a":1}');
      const svc = createService({
        readText,
        permissionsQuery: jasmine.createSpy('query').and.resolveTo(makeStatus('granted'))
      });
      await flush();
      readText.calls.reset();

      svc.startPolling();
      svc.startPolling();
      svc.startPolling();

      jasmine.clock().tick(2001);
      await flush();
      expect(readText).toHaveBeenCalledTimes(1);

      jasmine.clock().tick(2001);
      await flush();
      expect(readText).toHaveBeenCalledTimes(2);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('startPolling no-ops when state is not granted', async () => {
    jasmine.clock().install();
    try {
      const readText = jasmine.createSpy('readText').and.resolveTo('{"a":1}');
      const svc = createService({ readText });
      await flush();
      readText.calls.reset();

      svc.startPolling();
      jasmine.clock().tick(5000);
      await flush();
      expect(readText).not.toHaveBeenCalled();
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('stopPolling halts the interval and destroy cleans up', async () => {
    jasmine.clock().install();
    try {
      const readText = jasmine.createSpy('readText').and.resolveTo('{"a":1}');
      const svc = createService({
        readText,
        permissionsQuery: jasmine.createSpy('query').and.resolveTo(makeStatus('granted'))
      });
      await flush();
      svc.startPolling();
      readText.calls.reset();

      svc.stopPolling();
      jasmine.clock().tick(5000);
      await flush();
      expect(readText).not.toHaveBeenCalled();
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('permission change to denied clears derived state', async () => {
    const status = makeStatus('granted');
    const readText = jasmine.createSpy('readText').and.resolveTo('{"a":1}');
    const svc = createService({
      readText,
      permissionsQuery: jasmine.createSpy('query').and.resolveTo(status)
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
      const readText = jasmine.createSpy('readText').and.resolveTo(text);
      const svc = createService({
        readText,
        permissionsQuery: jasmine.createSpy('query').and.resolveTo(makeStatus('granted'))
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
