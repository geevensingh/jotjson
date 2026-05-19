import { expect, test } from '@playwright/test';

import { swapServedBytesForMigration } from './sw-migration.helpers';

/**
 * Positive path: a stuck OLD ngsw client unsticks via the
 * `/ngsw-worker.js` byte-revalidation path.
 *
 * Asserts state-machine progression (controllerchange fired,
 * active worker is `'activated'`, caches empty), NOT body-substring
 * fetch (which was the v2 mistake -- the test fixture serves
 * whatever bytes we tell it to, so a body-substring assertion is
 * tautological per skeptic v3 S4).
 *
 * Also asserts that `localStorage` survives the migration (R3 --
 * the editor's draft persistence must not be wiped by the
 * `activate`-time cache wipe in `src/sw.worker.ts`).
 *
 * SKIPPED PENDING FIXTURE INFRASTRUCTURE.
 *
 * This spec needs an OLD ngsw build to be controlling the page
 * at test start. The Playwright `webServer` in `playwright.config.ts`
 * builds the CURRENT branch (post-migration code), so on first
 * navigation the NEW minimal SW takes over and there is no OLD
 * ngsw cache state to wipe. The `buildFixture()` helper in
 * `./sw-migration.setup.ts` materializes the pre-migration build
 * via `git worktree`, but it is not yet wired into
 * `playwright.config.ts` as a global setup that swaps the served
 * `dist/` for the duration of the test.
 *
 * Follow-up PR (not blocking this migration): add a Playwright
 * `globalSetup` that:
 *   1. Calls `buildFixture()` from `./sw-migration.setup.ts`.
 *   2. Swaps the webServer's served path to the fixture `dist/`.
 *   3. Lets this test register OLD ngsw, then swaps back to the
 *      post-migration `dist/` for the byte-revalidation step.
 *
 * Until that lands, the migration mechanism is verified in
 * production via the §4d post-deploy runbook (telemetry curve +
 * stuck-machine recovery check) and the broken-SW canary in
 * `sw-migration-broken-sw.spec.ts` (which DOES run against the
 * current webServer and validates the failure-handling path).
 */
test.skip('stuck ngsw client unsticks via /ngsw-worker.js byte-check', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.goto('/');

  // Step 1: write a localStorage sentinel so we can assert R3 survival.
  await page.evaluate(() => localStorage.setItem('jotjson.test.sentinel', 'pre-migration-value'));

  // Step 2: swap served bytes at both URLs to the new minimal SW.
  await swapServedBytesForMigration(ctx);

  // Step 3: fresh tab on the same context. In production this is the
  // user's next browser open after the deploy.
  const page2 = await ctx.newPage();

  // Listen for controllerchange BEFORE we trigger the byte-check.
  // The event firing is the load-bearing signal that the state
  // machine actually transitioned (skeptic v3 #4).
  await page2.addInitScript(() => {
    (window as unknown as { __controllerChangeFired: boolean }).__controllerChangeFired = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      (window as unknown as { __controllerChangeFired: boolean }).__controllerChangeFired = true;
    });
  });

  await page2.goto('/');

  // Step 4: force the byte-check via reg.update() (production: 24h
  // automatic; CI: forced via Playwright).
  await page2.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg?.update();
  });

  // Step 5: assert state-machine progression. The controllerchange
  // event must fire (proves the SW state machine actually advanced),
  // the active worker must transition to 'activated', and caches
  // must be empty post-wipe.
  await page2.waitForFunction(
    async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg?.active || reg.active.state !== 'activated') return false;
      const controllerChanged = (window as unknown as { __controllerChangeFired: boolean })
        .__controllerChangeFired;
      const cachesEmpty = (await caches.keys()).length === 0;
      return controllerChanged && cachesEmpty;
    },
    null,
    { timeout: 30_000 },
  );

  // Step 6: assert the localStorage sentinel survived the activate-
  // time cache wipe. The wipe targets only the Cache API, not
  // localStorage / IndexedDB / sessionStorage.
  const sentinel = await page2.evaluate(() => localStorage.getItem('jotjson.test.sentinel'));
  expect(sentinel).toBe('pre-migration-value');
});
