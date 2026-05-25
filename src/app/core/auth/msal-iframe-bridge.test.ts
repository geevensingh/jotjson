import { isInMsalSilentIframe, postAuthResponseToParent } from './msal-iframe-bridge';

const BRIDGE_FAIL_KEY = 'jotjson.msalBridgeErr';
const VALID_STATE = 'AQIDBAUGBwgJCgsMDQ4PEBESExQ'; // 27-char base64url string

interface FakeLocation {
  hash: string;
  search: string;
}

function makeWinStub(opts: {
  isTop?: boolean;
  hash?: string;
  search?: string;
  topThrows?: boolean;
}): Window {
  const stub: { self: unknown; location: FakeLocation } & { top?: unknown } = {
    self: null as unknown,
    location: { hash: opts.hash ?? '', search: opts.search ?? '' },
  };
  stub.self = stub;
  if (opts.topThrows) {
    Object.defineProperty(stub, 'top', {
      get: () => {
        throw new Error('SecurityError: cross-origin access denied');
      },
    });
  } else {
    stub.top = opts.isTop ? stub : { __sentinel: 'differentWindow' };
  }
  return stub as unknown as Window;
}

describe('isInMsalSilentIframe', () => {
  it('returns false when win.self === win.top (top-level browsing context)', () => {
    const win = makeWinStub({ isTop: true, hash: `#code=abc&state=${VALID_STATE}` });
    expect(isInMsalSilentIframe(win)).toBe(false);
  });

  it('returns false in iframe context without auth markers in URL', () => {
    const win = makeWinStub({ isTop: false, hash: '#some/route', search: '?foo=bar' });
    expect(isInMsalSilentIframe(win)).toBe(false);
  });

  it('returns true in iframe with #code=...&state=<base64url> (hash mode)', () => {
    const win = makeWinStub({ isTop: false, hash: `#code=abc.def&state=${VALID_STATE}` });
    expect(isInMsalSilentIframe(win)).toBe(true);
  });

  it('returns true in iframe with #error=...&state=<base64url>', () => {
    const win = makeWinStub({
      isTop: false,
      hash: `#error=interaction_required&state=${VALID_STATE}`,
    });
    expect(isInMsalSilentIframe(win)).toBe(true);
  });

  it('returns true in iframe with ?code=...&state=<base64url> (query mode)', () => {
    const win = makeWinStub({ isTop: false, search: `?code=abc&state=${VALID_STATE}` });
    expect(isInMsalSilentIframe(win)).toBe(true);
  });

  it('returns false when state= is present but code/error is absent', () => {
    const win = makeWinStub({ isTop: false, hash: `#state=${VALID_STATE}&other=1` });
    expect(isInMsalSilentIframe(win)).toBe(false);
  });

  it('returns false when code= is present but state= is absent', () => {
    const win = makeWinStub({ isTop: false, hash: '#code=abc.def' });
    expect(isInMsalSilentIframe(win)).toBe(false);
  });

  it('returns false when state= value is too short to be a libraryState', () => {
    // Regression guard: tracker strings like "?state=ok" must not trigger.
    const win = makeWinStub({ isTop: false, search: '?code=abc&state=ok' });
    expect(isInMsalSilentIframe(win)).toBe(false);
  });

  it('returns false when win.top access throws SecurityError', () => {
    const win = makeWinStub({ topThrows: true, hash: `#code=abc&state=${VALID_STATE}` });
    expect(isInMsalSilentIframe(win)).toBe(false);
  });

  it('returns false when called with no arguments at top-level (default-resolution path)', () => {
    // Regression guard for the default-parameter fix: ensures the
    // signature default expression evaluates without throwing even
    // when no arg is passed. In Karma's top-level browsing context,
    // `window.self === window.top`, so the result is false.
    expect(isInMsalSilentIframe()).toBe(false);
  });
});

describe('postAuthResponseToParent', () => {
  beforeEach(() => {
    sessionStorage.removeItem(BRIDGE_FAIL_KEY);
  });

  afterEach(() => {
    sessionStorage.removeItem(BRIDGE_FAIL_KEY);
  });

  it('calls broadcastResponseToMainFrame exactly once when loader resolves', async () => {
    const broadcastSpy = vi.fn().mockResolvedValue(undefined);
    const loader = jasmine
      .createSpy('loader')
      .mockResolvedValue({ broadcastResponseToMainFrame: broadcastSpy });

    await postAuthResponseToParent(loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(BRIDGE_FAIL_KEY)).toBeNull();
  });

  it('resolves without throwing when broadcast rejects with parse error', async () => {
    // Regression guard for the unhandled-rejection bug: if the bridge
    // call were not awaited, this test would pass with the rejection
    // bubbling out asynchronously after the function returned.
    const broadcastSpy = jasmine
      .createSpy('broadcast')
      .mockRejectedValue(new Error('No payload found in URL'));
    const loader = () => Promise.resolve({ broadcastResponseToMainFrame: broadcastSpy });

    await expectAsync(postAuthResponseToParent(loader)).toBeResolved();
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
  });

  it('persists sanitized error to sessionStorage on rejection', async () => {
    const cause = new Error('No payload found in URL');
    cause.name = 'AuthError';
    const broadcastSpy = vi.fn().mockRejectedValue(cause);
    const loader = () => Promise.resolve({ broadcastResponseToMainFrame: broadcastSpy });

    await postAuthResponseToParent(loader);

    const raw = sessionStorage.getItem(BRIDGE_FAIL_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? '{}') as { name?: string; message?: string };
    expect(parsed.name).toBe('AuthError');
    expect(parsed.message).toBe('No payload found in URL');
  });

  it('swallows sessionStorage failures', async () => {
    const broadcastSpy = vi.fn().mockRejectedValue(new Error('boom'));
    const loader = () => Promise.resolve({ broadcastResponseToMainFrame: broadcastSpy });
    vi.spyOn(sessionStorage, 'setItem').and.throwError('QuotaExceededError');

    await expectAsync(postAuthResponseToParent(loader)).toBeResolved();
  });
});
