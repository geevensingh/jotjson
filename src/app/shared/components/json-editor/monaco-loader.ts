/**
 * Lazy AMD-loader bootstrap for Monaco.
 *
 * Monaco's minified distribution lives at /vs/ (copied from
 * node_modules/monaco-editor/min/vs by the build - see angular.json assets).
 * We load the AMD loader script on first use, then require editor.main.
 *
 * By keeping Monaco out of the Angular esbuild graph we preserve the 1MB
 * initial-bundle budget - Monaco only downloads when the editor mounts.
 *
 * ## One evaluation per realm (issue #513)
 *
 * `vs/loader.js` is a **classic script** whose first statement is
 * `const _amdLoaderGlobal = this`. That is a lexical binding on the
 * realm's global scope, so evaluating the script a second time in the
 * same realm is a hard compile-time `SyntaxError` - and, because the
 * HTML spec still fires `load` for a script whose evaluation threw, it
 * *also* produces a spurious "did not attach window.require" rejection.
 *
 * Loader evaluation is therefore **irreversible**: it cannot be undone
 * by deleting `window.require`, by removing the `<script>` element, or
 * by discarding this module's cached promise. Any of those makes the
 * guards lie while the realm stays loaded.
 *
 * So the authoritative record of "the loader was injected into this
 * realm" lives on `window` as {@link MonacoLoaderRealmState}, not in
 * module scope and not in the DOM:
 *
 * - it survives this module being re-instantiated (duplicate Vite
 *   module graphs, test files sharing a realm),
 * - it survives the test-only cache seam below, and
 * - it cannot be cleared by removing a DOM node.
 *
 * `monacoPromise` remains, but only as a resettable memo of an
 * in-flight or settled load - never as evidence about the realm.
 */
import type * as MonacoNS from 'monaco-editor';

/**
 * The subset of an AMD `require` implementation that this module drives.
 * Monaco's loader installs one on `window` when `vs/loader.js`
 * evaluates.
 */
interface MonacoAmdRequire {
  config: (cfg: { paths: Record<string, string> }) => void;
  (modules: string[], onReady: () => void): void;
}

/**
 * Realm-scoped, irreversible record of the AMD loader's lifecycle.
 *
 * `status` distinguishes "the fetch is in flight" from "the script has
 * finished evaluating", so a caller that arrives late can settle from
 * the recorded terminal state instead of attaching a listener to an
 * event that already fired (which would hang forever).
 */
interface MonacoLoaderRealmState {
  status: 'injecting' | 'evaluated' | 'failed';
  script: HTMLScriptElement;
}

declare global {
  interface Window {
    require?: MonacoAmdRequire;
    monaco?: typeof MonacoNS;
    MonacoEnvironment?: {
      getWorkerUrl?: (workerId: string, label: string) => string;
      // `getWorker` is part of Monaco's documented Environment interface
      // and takes precedence over `getWorkerUrl` when set. We do not use
      // it from the production loader (see `getWorkerUrl` above), but the
      // integration spec stubs it to avoid fetching
      // `vs/assets/editor.worker-*.js`. Declared here so the test-side
      // assignment is type-safe without widening to `any`.
      getWorker?: (workerId: string, label: string) => Worker | Promise<Worker>;
    };
    /**
     * See {@link MonacoLoaderRealmState}. `JJ_` is this repo's reserved
     * prefix for in-code symbols (`JOTJSON_*` is reserved for
     * environment variables) - see AGENTS.md Section 4.
     */
    JJ_MONACO_LOADER_STATE?: MonacoLoaderRealmState;
  }
}

const LOADER_SCRIPT_SELECTOR = 'script[data-monaco-loader="true"]';
const LOADER_SCRIPT_SRC = '/vs/loader.js';

/**
 * Upper bound on waiting for a loader `<script>` this module did not
 * inject (so it carries no {@link MonacoLoaderRealmState} telling us
 * whether its `load` event has already fired). Without the bound, an
 * element that never fires either event - e.g. a `src`-less stub -
 * would leave the returned promise pending forever.
 */
const FOREIGN_LOADER_TIMEOUT_MS = 30_000;

const FETCH_FAILED_MESSAGE = 'Failed to load Monaco AMD loader';
const NO_REQUIRE_MESSAGE = 'Monaco AMD loader did not attach window.require';
const ALREADY_EVALUATED_MESSAGE =
  'Monaco AMD loader already evaluated in this realm but window.require is gone. ' +
  'Re-evaluating vs/loader.js would throw a SyntaxError, so this load cannot be ' +
  'retried; a clean realm needs a fresh document.';

let monacoPromise: Promise<typeof MonacoNS> | undefined;
let monacoPromiseOverride: Promise<typeof MonacoNS> | undefined;

type ResolveMonaco = (namespace: typeof MonacoNS) => void;
type RejectMonaco = (reason: unknown) => void;

/**
 * Returns `window.require` only when it actually looks like an AMD
 * loader. An unrelated global named `require` (a bundler shim, another
 * library) would otherwise be handed to {@link bootstrap}, which calls
 * `.config(...)` on it and would throw a `TypeError` or stall.
 */
function readAmdRequire(): MonacoAmdRequire | undefined {
  const candidate: unknown = window.require;
  if (typeof candidate !== 'function') return undefined;
  const config: unknown = Reflect.get(candidate, 'config');
  if (typeof config !== 'function') return undefined;
  return window.require;
}

function makeWorkerUrl(): string {
  // The AMD loader spins up web-workers by eval-loading vs/base/worker/workerMain.
  // Point it at our copied /vs/ folder.
  return URL.createObjectURL(
    new Blob(
      [
        `self.MonacoEnvironment = { baseUrl: '${location.origin}/vs/' };` +
          `importScripts('${location.origin}/vs/base/worker/workerMain.js');`,
      ],
      { type: 'text/javascript' },
    ),
  );
}

export function loadMonaco(): Promise<typeof MonacoNS> {
  if (monacoPromiseOverride) return monacoPromiseOverride;
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Monaco is not available during SSR'));
  }
  if (window.monaco) return Promise.resolve(window.monaco);
  if (monacoPromise) return monacoPromise;

  monacoPromise = new Promise<typeof MonacoNS>((resolve, reject) => {
    // The loader owns `getWorkerUrl` and nothing else on this global, so
    // merge rather than replace: a caller-installed `getWorker` (the
    // browser-integration spec's no-op worker) must survive.
    window.MonacoEnvironment = { ...window.MonacoEnvironment, getWorkerUrl: makeWorkerUrl };

    const realmState = window.JJ_MONACO_LOADER_STATE;
    const existingScript =
      realmState?.script ??
      document.querySelector<HTMLScriptElement>(LOADER_SCRIPT_SELECTOR) ??
      undefined;

    // 1. A loader we own is already live in this realm. Re-bootstrapping
    //    off it is always correct and is never a second evaluation.
    const amdRequire = readAmdRequire();
    if (amdRequire && (realmState || existingScript)) {
      bootstrap(amdRequire, resolve, reject);
      return;
    }

    // 2. We injected the loader into this realm before. Whatever state
    //    it is in, injecting again is the one thing we must not do.
    if (realmState) {
      settleFromRealmState(realmState, resolve, reject);
      return;
    }

    // 3. A loader script we did not inject. Adopt it under a timeout
    //    rather than racing it with a second injection.
    if (existingScript) {
      adoptForeignScript(existingScript, resolve, reject);
      return;
    }

    // 4. First injection in this realm.
    injectLoaderScript(resolve, reject);
  });

  return monacoPromise;
}

function injectLoaderScript(resolve: ResolveMonaco, reject: RejectMonaco): void {
  const script = document.createElement('script');
  script.src = LOADER_SCRIPT_SRC;
  script.async = true;
  script.dataset['monacoLoader'] = 'true';

  const state: MonacoLoaderRealmState = { status: 'injecting', script };

  script.addEventListener(
    'error',
    () => {
      state.status = 'failed';
      reject(new Error(FETCH_FAILED_MESSAGE));
    },
    { once: true },
  );
  script.addEventListener(
    'load',
    () => {
      // Recorded before settling so a late adopter reads a terminal
      // status instead of attaching to an event that already fired.
      state.status = 'evaluated';
      settleAfterEvaluation(resolve, reject);
    },
    { once: true },
  );

  // Recorded before the append, because appending starts the fetch and
  // this record is what stops any later call from injecting again.
  window.JJ_MONACO_LOADER_STATE = state;
  document.head.appendChild(script);
}

function settleFromRealmState(
  state: MonacoLoaderRealmState,
  resolve: ResolveMonaco,
  reject: RejectMonaco,
): void {
  if (state.status === 'failed') {
    reject(new Error(FETCH_FAILED_MESSAGE));
    return;
  }
  if (state.status === 'evaluated') {
    // Reached only when something removed `window.require` after the
    // loader ran. Report it plainly instead of re-injecting, which
    // would be a `SyntaxError`.
    reject(new Error(ALREADY_EVALUATED_MESSAGE));
    return;
  }
  state.script.addEventListener('load', () => settleAfterEvaluation(resolve, reject), {
    once: true,
  });
  state.script.addEventListener('error', () => reject(new Error(FETCH_FAILED_MESSAGE)), {
    once: true,
  });
}

function adoptForeignScript(
  script: HTMLScriptElement,
  resolve: ResolveMonaco,
  reject: RejectMonaco,
): void {
  const timeoutId = setTimeout(() => {
    reject(
      new Error(
        `A Monaco AMD loader script was already present but did not initialize within ${FOREIGN_LOADER_TIMEOUT_MS}ms`,
      ),
    );
  }, FOREIGN_LOADER_TIMEOUT_MS);

  script.addEventListener(
    'load',
    () => {
      clearTimeout(timeoutId);
      settleAfterEvaluation(resolve, reject);
    },
    { once: true },
  );
  script.addEventListener(
    'error',
    () => {
      clearTimeout(timeoutId);
      reject(new Error(FETCH_FAILED_MESSAGE));
    },
    { once: true },
  );
}

function settleAfterEvaluation(resolve: ResolveMonaco, reject: RejectMonaco): void {
  const amdRequire = readAmdRequire();
  if (!amdRequire) {
    reject(new Error(NO_REQUIRE_MESSAGE));
    return;
  }
  bootstrap(amdRequire, resolve, reject);
}

function bootstrap(
  amdRequire: MonacoAmdRequire,
  resolve: ResolveMonaco,
  reject: RejectMonaco,
): void {
  amdRequire.config({ paths: { vs: '/vs' } });
  amdRequire(['vs/editor/editor.main'], () => {
    if (window.monaco) resolve(window.monaco);
    else reject(new Error('Monaco loaded but window.monaco is unavailable'));
  });
}

/**
 * Test-only seam: drops this module's cached load promise so the next
 * `loadMonaco()` re-runs its decision logic.
 *
 * It deliberately clears **nothing else**. Its predecessor also deleted
 * `window.require` / `window.MonacoEnvironment` / `window.monaco` and
 * removed the injected `<script>`, which made every guard report "not
 * loaded" while the realm was still permanently loaded - the cause of
 * issue #513. Loader evaluation cannot be undone from inside the realm;
 * a genuinely clean realm requires a fresh document or browser context.
 *
 * A test that installed a `window.*` fake owns restoring it, and a test
 * that installed a promise override clears it with
 * {@link __setMonacoLoaderPromiseForTesting}`(undefined)`. Production
 * callers must never reference this. See AGENTS.md `__<verb>ForTesting`
 * convention.
 */
export function __resetMonacoLoaderCacheForTesting(): void {
  monacoPromise = undefined;
}

/**
 * Test-only seam: pin `loadMonaco()` to a caller-supplied promise so a
 * spec can suspend the load between the await and the post-await body
 * (e.g., to verify destroy-before-load behavior in
 * `JsonEditorComponent`), or keep a unit-level spec away from the real
 * loader entirely. Takes precedence over both the `window.monaco`
 * shortcut and the cached `monacoPromise`. Pass `undefined` to clear.
 * Production callers must never reference this. See AGENTS.md
 * `__<verb>ForTesting` convention.
 */
export function __setMonacoLoaderPromiseForTesting(
  promise: Promise<typeof MonacoNS> | undefined,
): void {
  monacoPromiseOverride = promise;
}
