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

const LOADER_SCRIPT_SELECTOR = 'script[data-monaco-loader="true"]';

/**
 * The pristine prototype method, captured before any spy is installed.
 * `interceptLoaderInjection()` spies on `document.head.appendChild` as an
 * own property, so this stays unpatched and can re-attach elements
 * without being swallowed by the interceptor.
 */
const nativeAppendChild = Node.prototype.appendChild;

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
  vi.spyOn(document.head, 'appendChild').mockImplementation(((node: Node): Node => {
    if (isInjectedLoaderScript(node)) {
      captured.push({ script: node, statusAtAppend: window.JJ_MONACO_LOADER_STATE?.status });
      // Deliberately NOT inserted - see the file header.
      return node;
    }
    return nativeAppendChild.call(document.head, node);
  }) as typeof document.head.appendChild);
  return captured;
}

function onlyInjection(captured: CapturedInjection[]): CapturedInjection {
  expect(
    captured.length,
    'expected loadMonaco() to inject exactly one loader script; 0 usually means this realm ' +
      'still had a loader <script> or realm state from another spec file, so loadMonaco() ' +
      'adopted that instead of injecting',
  ).toBe(1);
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
  let detachedLoaderScripts: Array<{ script: HTMLScriptElement; parent: Node }> = [];

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

    // Realms are shared across spec files, and the loader deliberately
    // no longer removes its `<script>` on reset - pretending evaluation
    // was reversible is what caused issue #513. So the browser
    // integration spec's real loader element can still be sitting in
    // this document. Detach whatever is here, or `loadMonaco()` adopts
    // it (branch 3) instead of injecting and every case below sees zero
    // injections. Re-attached in `afterEach` so the realm is left
    // exactly as it was found.
    detachedLoaderScripts = [];
    for (const script of document.querySelectorAll<HTMLScriptElement>(LOADER_SCRIPT_SELECTOR)) {
      const parent = script.parentNode;
      if (!parent) continue;
      detachedLoaderScripts.push({ script, parent });
      parent.removeChild(script);
    }

    delete window.JJ_MONACO_LOADER_STATE;
    delete window.require;
    delete window.monaco;
    __setMonacoLoaderPromiseForTesting(undefined);
    __resetMonacoLoaderCacheForTesting();

    // Locks the precondition every case below depends on. Without it a
    // leaked loader script turns into ten confusing "expected 0 to be 1"
    // assertion failures instead of one message naming the cause.
    expect(
      document.querySelector(LOADER_SCRIPT_SELECTOR),
      'this realm must start with no loader <script> visible, or loadMonaco() adopts it ' +
        'instead of injecting',
    ).toBeNull();
  });

  afterEach(() => {
    __setMonacoLoaderPromiseForTesting(undefined);
    __resetMonacoLoaderCacheForTesting();

    for (const placeholder of insertedPlaceholders) {
      placeholder.remove();
    }
    insertedPlaceholders = [];

    // Native appendChild: the interceptor spy may still be installed on
    // `document.head`, and it swallows real loader scripts by design.
    for (const { script, parent } of detachedLoaderScripts) {
      nativeAppendChild.call(parent, script);
    }
    detachedLoaderScripts = [];

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

    await expect(silenced(loadMonaco())).rejects.toThrow(
      /already evaluated in this realm, but window\.require is absent/,
    );
    expect(captured.length).toBe(1);
  });

  it('names a shadowing non-AMD require when the loader already evaluated here', async () => {
    const captured = interceptLoaderInjection();

    const first = loadMonaco();
    const injection = onlyInjection(captured);
    window.require = makeAmdRequire(() => {
      window.monaco = fakeMonaco;
    });
    injection.script.dispatchEvent(new Event('load'));
    await first;

    // Distinct from the case above: `require` is present, so the
    // diagnostic must not claim it is absent. "Absent" and "shadowed"
    // have different remedies, and Monaco's loader also declines to
    // initialize at all when another `define.amd` was already there -
    // so neither state proves a reset happened.
    __resetMonacoLoaderCacheForTesting();
    delete window.monaco;
    window.require = (() => undefined) as unknown as AmdRequire;

    await expect(silenced(loadMonaco())).rejects.toThrow(
      /already evaluated in this realm, but window\.require is callable but exposes no config\(\)/,
    );
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

    // The diagnostic names which of the three failure shapes occurred,
    // rather than claiming `require` was never attached.
    await expect(pending).rejects.toThrow(
      'did not attach a usable window.require: window.require is callable but exposes no config()',
    );
    expect(captured.length).toBe(0);
  });

  it('reports a non-callable require distinctly from an absent one', async () => {
    const captured = interceptLoaderInjection();
    const placeholder = insertPlaceholderLoaderScript();
    window.require = 'not a function' as unknown as AmdRequire;

    const pending = silenced(loadMonaco());
    placeholder.dispatchEvent(new Event('load'));

    await expect(pending).rejects.toThrow('window.require is present but is not callable');
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

  it('preserves a caller-installed MonacoEnvironment object and its getWorker', async () => {
    const captured = interceptLoaderInjection();
    const callerGetWorker = vi.fn() as unknown as NonNullable<
      NonNullable<typeof window.MonacoEnvironment>['getWorker']
    >;
    const callerEnvironment = { getWorker: callerGetWorker };
    window.MonacoEnvironment = callerEnvironment;

    const pending = loadMonaco();

    // The loader owns `getWorkerUrl` and nothing else here, so it adds
    // its key in place: a caller that kept a reference (the browser
    // integration spec holds one to delete `getWorker` before revoking
    // its blob URL) must still be looking at the live object.
    expect(window.MonacoEnvironment).toBe(callerEnvironment);
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
