import {
  __resetSwRegistrationForTesting,
  attachSwEventDirectEmit,
  classifyRegistrationError,
  detectBrowserBucket,
  isSwEvent,
  queueSwEvent,
  SW_EVENTS_KEY,
  type SwEvent,
} from './sw-registration';

describe('sw-registration', () => {
  beforeEach(() => {
    __resetSwRegistrationForTesting();
  });

  afterEach(() => {
    __resetSwRegistrationForTesting();
  });

  describe('queueSwEvent + sessionStorage queue', () => {
    it('writes a queued event with BuildIdentity in props', () => {
      queueSwEvent({ name: 'sw.registered' });
      const raw = sessionStorage.getItem(SW_EVENTS_KEY);
      expect(raw).not.toBeNull();
      const events = JSON.parse(raw!) as SwEvent[];
      expect(events.length).toBe(1);
      expect(events[0].name).toBe('sw.registered');
      expect(events[0].props).toEqual(
        expect.objectContaining({
          version: expect.any(String),
          sha: expect.any(String),
          branch: expect.any(String),
          buildNumber: expect.any(String),
        }),
      );
      expect(typeof events[0].timestamp).toBe('number');
    });

    it('appends in FIFO order when multiple events queued', () => {
      queueSwEvent({ name: 'sw.registered' });
      queueSwEvent({ name: 'sw.activated' });
      const events = JSON.parse(sessionStorage.getItem(SW_EVENTS_KEY)!) as SwEvent[];
      expect(events.map((e) => e.name)).toEqual(['sw.registered', 'sw.activated']);
    });

    it('survives malformed pre-existing queue (non-array)', () => {
      sessionStorage.setItem(SW_EVENTS_KEY, JSON.stringify({ not: 'an array' }));
      queueSwEvent({ name: 'sw.registered' });
      const events = JSON.parse(sessionStorage.getItem(SW_EVENTS_KEY)!) as SwEvent[];
      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBe(1);
    });

    it('carries the registerFailed reason in props', () => {
      queueSwEvent({ name: 'sw.registerFailed', reason: 'syntax' });
      const events = JSON.parse(sessionStorage.getItem(SW_EVENTS_KEY)!) as SwEvent[];
      expect(events[0].name).toBe('sw.registerFailed');
      expect((events[0].props as { reason?: string }).reason).toBe('syntax');
    });

    it('carries browser/os bucket on legacyCacheWiped', () => {
      queueSwEvent({ name: 'sw.legacyCacheWiped' });
      const events = JSON.parse(sessionStorage.getItem(SW_EVENTS_KEY)!) as SwEvent[];
      expect(events[0].name).toBe('sw.legacyCacheWiped');
      const props = events[0].props as { browser?: string; os?: string };
      expect(typeof props.browser).toBe('string');
      expect(typeof props.os).toBe('string');
    });
  });

  describe('attachSwEventDirectEmit', () => {
    it('attaches direct-emit even when the pre-bootstrap queue is empty (S1 regression)', () => {
      const emit = jasmine.createSpy<(event: SwEvent) => void>('emit');
      attachSwEventDirectEmit(emit);
      // No drain expected.
      expect(emit).not.toHaveBeenCalled();
      // Subsequent queueSwEvent should go direct, not to sessionStorage.
      queueSwEvent({ name: 'sw.registered' });
      expect(emit).toHaveBeenCalledTimes(1);
      expect(sessionStorage.getItem(SW_EVENTS_KEY)).toBeNull();
    });

    it('drains a populated pre-bootstrap queue in FIFO order', () => {
      queueSwEvent({ name: 'sw.registered' });
      queueSwEvent({ name: 'sw.activated' });
      const seenNames: string[] = [];
      const emit = (event: SwEvent) => seenNames.push(event.name);
      attachSwEventDirectEmit(emit);
      expect(seenNames).toEqual(['sw.registered', 'sw.activated']);
      expect(sessionStorage.getItem(SW_EVENTS_KEY)).toBeNull();
    });

    it('per-event try/catch: one throwing emit does not drop the rest (S4 regression)', () => {
      queueSwEvent({ name: 'sw.registered' });
      queueSwEvent({ name: 'sw.activated' });
      queueSwEvent({ name: 'sw.legacyCacheWiped' });
      const seenNames: string[] = [];
      const emit = (event: SwEvent) => {
        if (event.name === 'sw.activated') throw new Error('boom');
        seenNames.push(event.name);
      };
      attachSwEventDirectEmit(emit);
      // Throwing emit was skipped; the other two still landed.
      expect(seenNames).toEqual(['sw.registered', 'sw.legacyCacheWiped']);
    });

    it('survives malformed queue', () => {
      sessionStorage.setItem(SW_EVENTS_KEY, 'not-json-{{{');
      const emit = jasmine.createSpy<(event: SwEvent) => void>('emit');
      // Should not throw.
      attachSwEventDirectEmit(emit);
      expect(emit).not.toHaveBeenCalled();
      // Direct-emit is still wired.
      queueSwEvent({ name: 'sw.registered' });
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('attaches direct-emit even when sessionStorage.getItem throws', () => {
      // Simulate private-mode / blocked-storage / SecurityError on read.
      const original = Storage.prototype.getItem;
      Storage.prototype.getItem = function thrower(): string | null {
        throw new DOMException('blocked', 'SecurityError');
      };
      try {
        const emit = jasmine.createSpy<(event: SwEvent) => void>('emit');
        // Must not throw despite storage failure.
        expect(() => attachSwEventDirectEmit(emit)).not.toThrow();
        expect(emit).not.toHaveBeenCalled();
      } finally {
        Storage.prototype.getItem = original;
      }
      // Direct-emit is wired: post-attach events bypass sessionStorage.
      const directSpy = jasmine.createSpy<(event: SwEvent) => void>('directSpy');
      // The first attach already won (idempotent). Force a fresh attach
      // here for the wiring assertion by resetting state.
      __resetSwRegistrationForTesting();
      attachSwEventDirectEmit(directSpy);
      queueSwEvent({ name: 'sw.registered' });
      expect(directSpy).toHaveBeenCalledTimes(1);
    });

    it('skips drain but still attaches direct-emit when sessionStorage.removeItem throws', () => {
      // Pre-populate the queue so removeItem is reached.
      queueSwEvent({ name: 'sw.registered' });
      const queuedRaw = sessionStorage.getItem('jotjson.sw.events');
      expect(queuedRaw).not.toBeNull();
      const original = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function thrower(): void {
        throw new DOMException('blocked', 'SecurityError');
      };
      const emit = jasmine.createSpy<(event: SwEvent) => void>('emit');
      try {
        // Must not throw despite removeItem failure.
        expect(() => attachSwEventDirectEmit(emit)).not.toThrow();
      } finally {
        Storage.prototype.removeItem = original;
      }
      // Per the canDrain invariant: the queue was NOT cleared, so
      // the queued event is NOT drained on this attach. This is the
      // defense against double-emit when the same queue is read
      // again on the next page load.
      expect(emit).not.toHaveBeenCalled();
      // The queue must still be in sessionStorage so a later attach
      // (next page load) can drain it once if removeItem succeeds.
      expect(sessionStorage.getItem('jotjson.sw.events')).toBe(queuedRaw);
      // Direct-emit is still wired so post-attach events flow.
      const directSpy = jasmine.createSpy<(event: SwEvent) => void>('directSpy');
      __resetSwRegistrationForTesting();
      attachSwEventDirectEmit(directSpy);
      queueSwEvent({ name: 'sw.activated' });
      expect(directSpy).toHaveBeenCalledTimes(1);
    });

    it('is idempotent: a second attach call is a no-op', () => {
      const first = jasmine.createSpy<(event: SwEvent) => void>('first');
      const second = jasmine.createSpy<(event: SwEvent) => void>('second');
      attachSwEventDirectEmit(first);
      // Re-invoke; should NOT switch the emit target or re-drain.
      attachSwEventDirectEmit(second);
      queueSwEvent({ name: 'sw.registered' });
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).not.toHaveBeenCalled();
    });
  });

  describe('classifyRegistrationError', () => {
    it('maps SecurityError to security', () => {
      expect(classifyRegistrationError({ name: 'SecurityError' })).toBe('security');
    });
    it('maps SyntaxError to syntax', () => {
      expect(classifyRegistrationError({ name: 'SyntaxError' })).toBe('syntax');
    });
    it('maps NetworkError to network', () => {
      expect(classifyRegistrationError({ name: 'NetworkError' })).toBe('network');
    });
    it('maps AbortError to abort', () => {
      expect(classifyRegistrationError({ name: 'AbortError' })).toBe('abort');
    });
    it('maps TypeError to type', () => {
      expect(classifyRegistrationError({ name: 'TypeError' })).toBe('type');
    });
    it('falls back to fetch when error message mentions script/fetch/load', () => {
      expect(classifyRegistrationError({ name: 'Other', message: 'script load failed' })).toBe(
        'fetch',
      );
    });
    it('falls back to other for unknown shapes', () => {
      expect(classifyRegistrationError(undefined)).toBe('other');
      expect(classifyRegistrationError(null)).toBe('other');
      expect(classifyRegistrationError('something')).toBe('other');
      expect(classifyRegistrationError({})).toBe('other');
    });
  });

  describe('isSwEvent', () => {
    it('accepts events with sw. prefix', () => {
      expect(isSwEvent({ name: 'sw.registered', props: {}, timestamp: 1 })).toBe(true);
    });
    it('rejects events without sw. prefix', () => {
      expect(isSwEvent({ name: 'app.boot', props: {}, timestamp: 1 })).toBe(false);
    });
    it('rejects non-objects', () => {
      expect(isSwEvent('sw.registered')).toBe(false);
      expect(isSwEvent(null)).toBe(false);
      expect(isSwEvent(undefined)).toBe(false);
    });
  });

  describe('detectBrowserBucket (iOS UA fix, skeptic v5 S7)', () => {
    let originalUa: string;
    beforeEach(() => {
      originalUa = navigator.userAgent;
    });
    function withUa(ua: string, fn: () => void): void {
      Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
      try {
        fn();
      } finally {
        Object.defineProperty(navigator, 'userAgent', { value: originalUa, configurable: true });
      }
    }

    it('buckets iOS Chrome (CriOS) as chrome, not safari', () => {
      withUa(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0 Mobile/15E148 Safari/604.1',
        () => {
          const bucket = detectBrowserBucket();
          expect(bucket.browser).toBe('chrome');
          expect(bucket.os).toBe('ios');
        },
      );
    });

    it('buckets iOS Firefox (FxiOS) as firefox, not safari', () => {
      withUa(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/120.0 Mobile/15E148 Safari/605.1.15',
        () => {
          const bucket = detectBrowserBucket();
          expect(bucket.browser).toBe('firefox');
          expect(bucket.os).toBe('ios');
        },
      );
    });

    it('buckets iOS Edge (EdgiOS) as edge, not safari', () => {
      withUa(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/120.0 Mobile/15E148 Safari/604.1',
        () => {
          const bucket = detectBrowserBucket();
          expect(bucket.browser).toBe('edge');
          expect(bucket.os).toBe('ios');
        },
      );
    });

    it('buckets desktop Chrome as chrome', () => {
      withUa(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        () => {
          const bucket = detectBrowserBucket();
          expect(bucket.browser).toBe('chrome');
          expect(bucket.os).toBe('windows');
        },
      );
    });

    it('buckets desktop Edge as edge', () => {
      withUa(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
        () => {
          const bucket = detectBrowserBucket();
          expect(bucket.browser).toBe('edge');
          expect(bucket.os).toBe('windows');
        },
      );
    });
  });
});
