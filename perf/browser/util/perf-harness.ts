// Window-attached perf-harness shim. Installed via Playwright's
// `page.addInitScript` BEFORE app code runs. Cooperates with the
// `LoggerService.__attachPerfHarnessForTesting` test seam.
//
// As of DR-007 (PR #194), attach is driven by `src/main.ts`: once
// Angular bootstraps, `main.ts` looks for `window.__jotjsonPerfHarness`,
// attaches a `LoggerService` sink that pushes every emitted event into
// `events`, and flips `attached = true`. Tests then observe the
// `events` array directly. There is no `page.evaluate`-driven attach
// helper anymore.
//
// In production, the shim is never installed, the seam stays detached
// (`LoggerService.perfSink` stays null), and
// `__attachPerfHarnessForTesting` is never called.
//
// Usage:
//   await page.addInitScript({ content: perfHarnessInitScript() });
//   ... drive the page ...
//   const events = await page.evaluate(
//     () => window.__jotjsonPerfHarness?.events ?? [],
//   );

import type { PerfHarnessEvent } from '../../../src/app/core/telemetry/logger.service';

declare global {
  interface Window {
    __jotjsonPerfHarness?: {
      events: PerfHarnessEvent[];
      attached?: boolean;
    };
  }
}

/**
 * The init script source. Playwright requires either a string or a
 * pure function that gets stringified -- references to the surrounding
 * lexical scope are NOT closed over. So this is a self-contained
 * function body.
 *
 * `attached: false` is the explicit pre-attach sentinel: `main.ts`
 * flips it to `true` once `__attachPerfHarnessForTesting` has been
 * called. Tests distinguish `undefined` (shim never installed) from
 * `false` (shim installed but self-attach never ran) from `true` (the
 * happy path).
 */
export function perfHarnessInitScript(): string {
  return `
    (function () {
      if (window.__jotjsonPerfHarness) return;
      window.__jotjsonPerfHarness = { events: [], attached: false };
    })();
  `;
}
