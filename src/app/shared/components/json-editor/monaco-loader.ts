/**
 * Lazy AMD-loader bootstrap for Monaco.
 *
 * Monaco's minified distribution lives at /vs/ (copied from
 * node_modules/monaco-editor/min/vs by the build — see angular.json assets).
 * We load the AMD loader script on first use, then require editor.main.
 *
 * By keeping Monaco out of the Angular esbuild graph we preserve the 1MB
 * initial-bundle budget — Monaco only downloads when the editor mounts.
 */
import type * as MonacoNS from 'monaco-editor';

declare global {
  interface Window {
    require?: {
      config: (cfg: { paths: Record<string, string> }) => void;
      (modules: string[], onReady: () => void): void;
    };
    monaco?: typeof MonacoNS;
    MonacoEnvironment?: { getWorkerUrl: (workerId: string, label: string) => string };
  }
}

let monacoPromise: Promise<typeof MonacoNS> | undefined;

export function loadMonaco(): Promise<typeof MonacoNS> {
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
                `importScripts('${location.origin}/vs/base/worker/workerMain.js');`
            ],
            { type: 'text/javascript' }
          )
        );
        return proxy;
      }
    };

    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-monaco-loader="true"]'
    );
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

function bootstrap(
  resolve: (m: typeof MonacoNS) => void,
  reject: (err: unknown) => void
): void {
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
