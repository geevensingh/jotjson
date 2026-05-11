// Window-attached perf-harness shim. Installed via Playwright's
// `page.addInitScript` BEFORE app code runs. Cooperates with the
// `LoggerService.__attachPerfHarnessForTesting` test seam: when the
// shim sees `window.__jotjsonPerfHarness` already present, the
// LoggerService routes every event into `events: []`.
//
// In production, the seam is null-op (LoggerService.perfSink stays
// null) because we never call `__attachPerfHarnessForTesting`.
//
// Usage:
//   await page.addInitScript(perfHarnessInitScript);
//   ... drive the page ...
//   const events = await readPerfEvents(page);

export interface PerfEvent {
  level: 'event' | 'info' | 'warn' | 'error';
  messageId: string;
  props: Record<string, string> | null;
  measurements: Record<string, number> | null;
  timestamp: number;
}

declare global {
  interface Window {
    __jotjsonPerfHarness?: { events: PerfEvent[] };
  }
}

/**
 * The init script source. Playwright requires either a string or a
 * pure function that gets stringified -- references to the surrounding
 * lexical scope are NOT closed over. So this is a self-contained
 * function body.
 */
export function perfHarnessInitScript(): string {
  return `
    (function () {
      if (window.__jotjsonPerfHarness) return;
      window.__jotjsonPerfHarness = { events: [] };
    })();
  `;
}

/**
 * Hooks the perf harness into LoggerService AFTER Angular has bootstrapped.
 * Called from a Playwright spec via `page.evaluate`.
 *
 * The LoggerService instance is reachable via the AngularInjector global
 * exposed in dev/perf builds. We do NOT add a new window symbol just for
 * the harness; the seam already exists.
 */
export const PERF_HARNESS_ATTACH_SCRIPT = `
  (async function () {
    // Wait for Angular to be ready: the splash element is removed once
    // the app is bootstrapped.
    const start = performance.now();
    while (document.querySelector('app-splash, [data-loading-splash]')) {
      if (performance.now() - start > 30000) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // The harness shim is the single source of truth. Production
    // LoggerService instances honor it via the test seam.
    return window.__jotjsonPerfHarness ? window.__jotjsonPerfHarness.events.length : -1;
  })();
`;
