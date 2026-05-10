/**
 * Lazy AMD-loader bootstrap for Monaco.
 *
 * Monaco's minified distribution lives at /vs/ (copied from
 * node_modules/monaco-editor/min/vs by the build - see angular.json assets).
 * We load the AMD loader script on first use, then require editor.main.
 *
 * By keeping Monaco out of the Angular esbuild graph we preserve the 1MB
 * initial-bundle budget - Monaco only downloads when the editor mounts.
 */
import type * as MonacoNS from 'monaco-editor';

declare global {
  interface Window {
    require?: {
      config: (cfg: { paths: Record<string, string> }) => void;
      (modules: string[], onReady: () => void): void;
    };
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
  }
}

let monacoPromise: Promise<typeof MonacoNS> | undefined;
let monacoPromiseOverride: Promise<typeof MonacoNS> | undefined;

export function loadMonaco(): Promise<typeof MonacoNS> {
  if (monacoPromiseOverride) return monacoPromiseOverride;
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Monaco is not available during SSR'));
  }
  if (window.monaco) return Promise.resolve(window.monaco);
  if (monacoPromise) return monacoPromise;

  monacoPromise = new Promise<typeof MonacoNS>((resolve, reject) => {
    // The AMD loader spins up web-workers by eval-loading vs/base/worker/workerMain.
    // Point it at our copied /vs/ folder.
    window.MonacoEnvironment = {
      getWorkerUrl: () => {
        const proxy = URL.createObjectURL(
          new Blob(
            [
              `self.MonacoEnvironment = { baseUrl: '${location.origin}/vs/' };` +
                `importScripts('${location.origin}/vs/base/worker/workerMain.js');`,
            ],
            { type: 'text/javascript' },
          ),
        );
        return proxy;
      },
    };

    const existing = document.querySelector<HTMLScriptElement>('script[data-monaco-loader="true"]');
    if (existing && window.require) {
      bootstrap(resolve, reject);
      return;
    }

    const script = document.createElement('script');
    script.src = '/vs/loader.js';
    script.async = true;
    script.dataset['monacoLoader'] = 'true';
    script.onerror = () => reject(new Error('Failed to load Monaco AMD loader'));
    script.onload = () => bootstrap(resolve, reject);
    document.head.appendChild(script);
  });

  return monacoPromise;
}

function bootstrap(resolve: (m: typeof MonacoNS) => void, reject: (error: unknown) => void): void {
  const req = window.require;
  if (!req) {
    reject(new Error('Monaco AMD loader did not attach window.require'));
    return;
  }
  req.config({ paths: { vs: '/vs' } });
  req(['vs/editor/editor.main'], () => {
    if (window.monaco) resolve(window.monaco);
    else reject(new Error('Monaco loaded but window.monaco is unavailable'));
  });
}

/**
 * Test-only seam: clears every piece of loader-owned global state so a
 * subsequent `loadMonaco()` call goes through the full bootstrap again.
 * Resets the cached promise, removes the AMD loader's globals
 * (`window.require`, `window.MonacoEnvironment`, `window.monaco`), and
 * detaches the injected loader script tag. Production callers must
 * never reference this. See AGENTS.md `__<verb>ForTesting` convention.
 */
export function __resetMonacoLoaderForTesting(): void {
  monacoPromise = undefined;
  monacoPromiseOverride = undefined;
  if (typeof window === 'undefined') return;
  const winRef = window as unknown as Record<string, unknown>;
  delete winRef['require'];
  delete winRef['MonacoEnvironment'];
  delete winRef['monaco'];
  document.querySelector('script[data-monaco-loader="true"]')?.remove();
}

/**
 * Test-only seam: pin `loadMonaco()` to a caller-supplied promise so a
 * spec can suspend the load between the await and the post-await body
 * (e.g., to verify destroy-before-load behavior in
 * `JsonEditorComponent`). Takes precedence over both the
 * `window.monaco` shortcut and the cached `monacoPromise`. Pass
 * `undefined` to clear. Production callers must never reference this.
 * See AGENTS.md `__<verb>ForTesting` convention.
 */
export function __setMonacoLoaderPromiseForTesting(
  promise: Promise<typeof MonacoNS> | undefined,
): void {
  monacoPromiseOverride = promise;
}
