/**
 * Unit spec for the Monaco AMD-loader bootstrap (issue #513).
 *
 * The invariant under test: **`/vs/loader.js` is injected at most once
 * per realm.** Monaco's loader is a classic script whose first statement
 * is `const _amdLoaderGlobal = this`, so a second evaluation in the same
 * realm is a hard `SyntaxError` - which Vitest records as an unhandled
 * error (job red, suite green) *and*, because the script still fires
 * `load`, as a spurious "did not attach window.require" rejection.
 *
 * These cases deliberately drive the **injection** branch rather than
 * pre-seeding an already-injected state: a spec that only pre-seeded
 * would still pass if the production code stopped recording
 * `window.JJ_MONACO_LOADER_STATE`, leaving the real hole open.
 *
 * `document.head.appendChild` is intercepted so the loader element is
 * captured but never inserted. Inserting it would fetch and evaluate the
 * real loader, which is precisely the irreversible act this spec exists
 * to prevent - and which is the browser-integration spec's job, not
 * this one's.
 *
 * Every case restores the realm globals it touches, because
 * `sequence.shuffle` randomizes order within the file and realms are
 * shared across files.
 */
import type * as MonacoNS from 'monaco-editor';
import {
  __resetMonacoLoaderCacheForTesting,
  __setMonacoLoaderPromiseForTesting,
  loadMonaco,
} from './monaco-loader';

type AmdRequire = NonNullable<typeof window.require>;

interface CapturedInjection {
  script: HTMLScriptElement;
  statusAtAppend: string | undefined;
}

const fakeMonaco = {} as unknown as typeof MonacoNS;

/**
 * A loader script the production code injected, identified by having a
 * `src`. Test-installed placeholders carry the same dataset flag but no
 * `src`, and must still reach the DOM so `document.querySelector` can
 * find them.
 */
function isInjectedLoaderScript(node: Node): node is HTMLScriptElement {
  return (
    node instanceof HTMLScriptElement && node.dataset['monacoLoader'] === 'true' && node.src !== ''
  );
}

function interceptLoaderInjection(): CapturedInjection[] {
  const captured: CapturedInjection[] = [];
  const originalAppendChild = Node.prototype.appendChild;
  vi.spyOn(document.head, 'appendChild').mockImplementation(((node: Node): Node => {
    if (isInjectedLoaderScript(node)) {
      captured.push({ script: node, statusAtAppend: window.JJ_MONACO_LOADER_STATE?.status });
      // Deliberately NOT inserted - see the file header.
      return node;
    }
    return originalAppendChild.call(document.head, node);
  }) as typeof document.head.appendChild);
  return captured;
}

function onlyInjection(captured: CapturedInjection[]): CapturedInjection {
  expect(captured.length).toBe(1);
  const first = captured[0];
  if (!first) throw new Error('expected exactly one captured loader injection');
  return first;
}

/** An AMD `require` shaped like the one Monaco's loader installs. */
function makeAmdRequire(onRequire?: () => void): AmdRequire {
  const amdRequire = (modules: string[], onReady: () => void): void => {
    void modules;
    onRequire?.();
    onReady();
  };
  return Object.assign(amdRequire, { config: () => undefined });
}

/**
 * Attaches a no-op catch before the `rejects` assertion so Zone.js does
 * not log a deliberately-rejected promise as unhandled. Same pattern as
 * `json-editor.component.a11y.test.ts`.
 */
function silenced(promise: Promise<typeof MonacoNS>): Promise<typeof MonacoNS> {
  promise.catch(() => undefined);
  return promise;
}

describe('monaco-loader', () => {
  let savedRealmState: typeof window.JJ_MONACO_LOADER_STATE;
  let savedRequire: typeof window.require;
  let savedMonaco: typeof window.monaco;
  let savedEnvironment: typeof window.MonacoEnvironment;
  let insertedPlaceholders: HTMLScriptElement[] = [];

  function insertPlaceholderLoaderScript(): HTMLScriptElement {
    const script = document.createElement('script');
    script.dataset['monacoLoader'] = 'true';
    document.head.appendChild(script);
    insertedPlaceholders.push(script);
    return script;
  }

  beforeEach(() => {
    savedRealmState = window.JJ_MONACO_LOADER_STATE;
    savedRequire = window.require;
    savedMonaco = window.monaco;
    savedEnvironment = window.MonacoEnvironment;
    insertedPlaceholders = [];

    delete window.JJ_MONACO_LOADER_STATE;
    delete window.require;
    delete window.monaco;
    __setMonacoLoaderPromiseForTesting(undefined);
    __resetMonacoLoaderCacheForTesting();
  });

  afterEach(() => {
    __setMonacoLoaderPromiseForTesting(undefined);
    __resetMonacoLoaderCacheForTesting();

    for (const placeholder of insertedPlaceholders) {
      placeholder.remove();
    }
    insertedPlaceholders = [];

    if (savedRealmState === undefined) delete window.JJ_MONACO_LOADER_STATE;
    else window.JJ_MONACO_LOADER_STATE = savedRealmState;
    if (savedRequire === undefined) delete window.require;
    else window.require = savedRequire;
    if (savedMonaco === undefined) delete window.monaco;
    else window.monaco = savedMonaco;
    if (savedEnvironment === undefined) delete window.MonacoEnvironment;
    else window.MonacoEnvironment = savedEnvironment;
  });

  it('records the realm state before appending the loader script', async () => {
    const captured = interceptLoaderInjection();

    const pending = loadMonaco();

    const injection = onlyInjection(captured);
    // The record must exist *at append time*: appending starts the fetch,
    // and the record is the only thing that stops a later call from
    // injecting a second script.
    expect(injection.statusAtAppend).toBe('injecting');
    expect(window.JJ_MONACO_LOADER_STATE?.script).toBe(injection.script);

    window.require = makeAmdRequire(() => {
      window.monaco = fakeMonaco;
    });
    injection.script.dispatchEvent(new Event('load'));

    await expect(pending).resolves.toBe(fakeMonaco);
    expect(window.JJ_MONACO_LOADER_STATE?.status).toBe('evaluated');
  });

  it('never injects a second script once the loader has evaluated in this realm', async () => {
    const captured = interceptLoaderInjection();

    const first = loadMonaco();
    const injection = onlyInjection(captured);
    window.require = makeAmdRequire(() => {
      window.monaco = fakeMonaco;
    });
    injection.script.dispatchEvent(new Event('load'));
    await first;

    // Reproduce exactly what the old reset seam did: drop the cached
    // promise and every observable guard. Before the fix this made
    // `loadMonaco()` inject a second `/vs/loader.js`.
    __resetMonacoLoaderCacheForTesting();
    delete window.monaco;
    delete window.require;
    injection.script.remove();

    await expect(silenced(loadMonaco())).rejects.toThrow(/already evaluated in this realm/);
    expect(captured.length).toBe(1);
  });

  it('adopts an in-flight loader script instead of injecting alongside it', async () => {
    const captured = interceptLoaderInjection();

    const first = loadMonaco();
    // Still in flight: the script has not evaluated, so `window.require`
    // is absent. This is the state the old DOM probe mis-read as
    // "no loader present".
    expect(window.JJ_MONACO_LOADER_STATE?.status).toBe('injecting');
    __resetMonacoLoaderCacheForTesting();
    const second = loadMonaco();

    const injection = onlyInjection(captured);
    window.require = makeAmdRequire(() => {
      window.monaco = fakeMonaco;
    });
    injection.script.dispatchEvent(new Event('load'));

    await expect(first).resolves.toBe(fakeMonaco);
    await expect(second).resolves.toBe(fakeMonaco);
  });

  it('reports a failed loader fetch without retrying the injection', async () => {
    const captured = interceptLoaderInjection();

    const first = silenced(loadMonaco());
    const injection = onlyInjection(captured);
    injection.script.dispatchEvent(new Event('error'));
    await expect(first).rejects.toThrow('Failed to load Monaco AMD loader');
    expect(window.JJ_MONACO_LOADER_STATE?.status).toBe('failed');

    __resetMonacoLoaderCacheForTesting();
    await expect(silenced(loadMonaco())).rejects.toThrow('Failed to load Monaco AMD loader');
    expect(captured.length).toBe(1);
  });

  it('bootstraps from an existing loader script and AMD require without injecting', async () => {
    const captured = interceptLoaderInjection();
    insertPlaceholderLoaderScript();
    window.require = makeAmdRequire(() => {
      window.monaco = fakeMonaco;
    });

    await expect(loadMonaco()).resolves.toBe(fakeMonaco);
    expect(captured.length).toBe(0);
  });

  it('ignores a global require that is not an AMD loader', async () => {
    const captured = interceptLoaderInjection();
    const placeholder = insertPlaceholderLoaderScript();
    // A bundler shim or unrelated library. Handing this to the loader
    // would call `.config(...)` on it and throw a TypeError.
    window.require = (() => undefined) as unknown as AmdRequire;

    const pending = silenced(loadMonaco());
    placeholder.dispatchEvent(new Event('load'));

    await expect(pending).rejects.toThrow('did not attach window.require');
    expect(captured.length).toBe(0);
  });

  it('leaves realm facts intact when the cache seam runs', async () => {
    const captured = interceptLoaderInjection();
    const pending = loadMonaco();
    const injection = onlyInjection(captured);
    window.require = makeAmdRequire(() => {
      window.monaco = fakeMonaco;
    });
    injection.script.dispatchEvent(new Event('load'));
    await pending;

    const stateBefore = window.JJ_MONACO_LOADER_STATE;
    const requireBefore = window.require;
    const environmentBefore = window.MonacoEnvironment;

    __resetMonacoLoaderCacheForTesting();

    expect(window.JJ_MONACO_LOADER_STATE).toBe(stateBefore);
    expect(window.require).toBe(requireBefore);
    expect(window.MonacoEnvironment).toBe(environmentBefore);
    expect(window.monaco).toBe(fakeMonaco);
  });

  it('preserves a caller-installed MonacoEnvironment.getWorker', async () => {
    const captured = interceptLoaderInjection();
    const callerGetWorker = vi.fn() as unknown as NonNullable<
      NonNullable<typeof window.MonacoEnvironment>['getWorker']
    >;
    window.MonacoEnvironment = { getWorker: callerGetWorker };

    const pending = loadMonaco();

    // The loader owns `getWorkerUrl`; it must not clobber the whole
    // object and strip a `getWorker` the caller installed (the browser
    // integration spec's no-op worker depends on this).
    expect(window.MonacoEnvironment?.getWorker).toBe(callerGetWorker);
    expect(typeof window.MonacoEnvironment?.getWorkerUrl).toBe('function');

    const injection = onlyInjection(captured);
    window.require = makeAmdRequire(() => {
      window.monaco = fakeMonaco;
    });
    injection.script.dispatchEvent(new Event('load'));
    await pending;
  });

  it('rejects when the loader evaluates but never exposes window.monaco', async () => {
    const captured = interceptLoaderInjection();
    const pending = silenced(loadMonaco());
    const injection = onlyInjection(captured);
    window.require = makeAmdRequire();
    injection.script.dispatchEvent(new Event('load'));

    await expect(pending).rejects.toThrow('Monaco loaded but window.monaco is unavailable');
  });

  it('returns the pinned promise ahead of every other path when one is set', async () => {
    const captured = interceptLoaderInjection();
    __setMonacoLoaderPromiseForTesting(Promise.resolve(fakeMonaco));

    await expect(loadMonaco()).resolves.toBe(fakeMonaco);
    expect(captured.length).toBe(0);
  });
});
