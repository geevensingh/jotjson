// Layer-3 scenario: harness-attach (DR-007 / SK-021).
//
// Validates that `src/main.ts`'s bootstrap self-attach actually wires
// `LoggerService` into the perf harness shim, and that pushed events
// reflect a real user action. Without this guard, every other perf
// row would silently report zero telemetry events if the seam ever
// regressed -- the bench would still pass while the measurement
// surface had quietly disappeared.
//
// Distinguishes three failure modes via `attached`:
//   - `undefined` -> shim was never installed (`addInitScript` broken,
//     or page navigated before the script ran).
//   - `false`     -> shim installed but `main.ts` self-attach never
//     ran (bootstrap path regressed, or the harness check in
//     `main.ts` was removed).
//   - `true`      -> happy path; self-attach completed.
//
// And via the event-count sentinel:
//   - `pre === -1` -> shim missing (already ruled out by the
//     `attached === true` assertion, but kept explicit).
//   - `post <= pre` -> attach ran but the sink isn't routing events;
//     the toolbar paste click produced no `paste.handle` envelope.
//
// This scenario does NOT emit `@@PERF_L3@@` sentinels because it
// produces no bench row -- it is a contract test that runs alongside
// the perf bench specs to fail loudly when the harness wiring breaks.

import { expect, test } from '@playwright/test';
import { perfHarnessInitScript } from '../util/perf-harness';

test('harness-attach: main.ts self-attach routes paste.handle into the harness', async ({
  context,
  page,
}) => {
  test.setTimeout(2 * 60 * 1000);

  // Install the shim BEFORE any app code runs.
  await page.addInitScript({ content: perfHarnessInitScript() });

  // Grant clipboard permissions up front so the toolbar Paste button
  // can enable itself once `ClipboardPollingService` detects JSON.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.goto('/', { waitUntil: 'load' });

  // Wait for the SPA to bootstrap. Monaco's editor textbox is a
  // well-known post-bootstrap marker that the existing perf specs
  // already rely on.
  await page.getByRole('textbox', { name: 'JSON editor' }).waitFor({ state: 'visible' });

  // Assertion #1: `main.ts` self-attach actually ran. Read the literal
  // `attached` sentinel so the failure mode is unambiguous: `undefined`
  // means the shim was never installed; `false` means the shim was
  // installed but the self-attach block never executed.
  const attached = await page.evaluate(() => window.__jotjsonPerfHarness?.attached);
  expect(
    attached,
    'window.__jotjsonPerfHarness.attached should be true after Angular bootstraps -- ' +
      'undefined means the shim never installed; false means main.ts self-attach never ran',
  ).toBe(true);

  // Capture pre-paste event count. `-1` would mean the shim is
  // missing entirely; the previous assertion rules that out, but we
  // keep the sentinel explicit for symmetry with the post-paste read
  // and to surface a clear message if the shape ever changes.
  const pre = await page.evaluate(() => window.__jotjsonPerfHarness?.events.length ?? -1);
  expect(pre, 'harness shim should be installed and observable on window').not.toBe(-1);

  // Fire a real toolbar paste of small JSON. Writing to the OS
  // clipboard primes `ClipboardPollingService` to flip the toolbar
  // Paste button out of its `disabled` state. Playwright's `.click()`
  // auto-waits for the button to become enabled, so we don't need an
  // explicit polling-interval sleep.
  const payload = '{"a":1}';
  await page.evaluate(async (text) => {
    await navigator.clipboard.writeText(text);
  }, payload);

  await page.getByRole('button', { name: 'Paste JSON from clipboard' }).click({ timeout: 30_000 });

  // Wait until the harness sees the toolbar's `paste.handle` event.
  // `expect.poll` re-evaluates on Playwright's standard cadence so we
  // do not race the post-paste rAF + telemetry emit.
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window.__jotjsonPerfHarness?.events ?? []).some(
            (event) => event.messageId === 'paste.handle',
          ),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);

  // Final assertion: the captured event count strictly increased.
  // This is the canonical signal that the sink is routing live
  // events, not just the `paste.handle` we explicitly waited for.
  const post = await page.evaluate(() => window.__jotjsonPerfHarness?.events.length ?? -1);
  expect(
    post,
    'post-paste event count should strictly increase over pre-paste -- ' +
      'sink wired but not routing events otherwise',
  ).toBeGreaterThan(pre);
});
