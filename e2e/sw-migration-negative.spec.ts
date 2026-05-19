import { expect, test } from '@playwright/test';

/**
 * Negative path: without the byte-identical alias at
 * `/ngsw-worker.js`, an OLD ngsw cannot unstick. This is the
 * failure mode the v1 plan would have shipped (swap URL instead
 * of swap bytes at the existing URL -- skeptic v2 S1).
 *
 * If this test ever PASSES, it means a browser behavior change
 * has invalidated the whole migration's premise and we need to
 * re-evaluate.
 *
 * SKIPPED PENDING FIXTURE INFRASTRUCTURE.
 *
 * Like `sw-migration.spec.ts`, this needs the OLD ngsw build to
 * be controlling the page at test start. Until the Playwright
 * `globalSetup` from the follow-up PR lands (see the matching
 * comment in `sw-migration.spec.ts`), the negative scenario
 * cannot be exercised against the current webServer.
 *
 * The negative failure mode this would catch (a future browser
 * change that makes 4xx-during-update unregister the SW) is
 * additionally caught at the spec layer by SW.spec's explicit
 * "byte-check returns NEW bytes at SAME URL" mechanism.
 */
test.skip('without /ngsw-worker.js byte-identical alias, stuck client stays stuck', async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.goto('/');

  // Pretend the migration shipped at `/sw.js` only (no alias).
  // The OLD ngsw at `/ngsw-worker.js` byte-checks against itself
  // and finds... nothing useful. We simulate that by returning
  // 404 on `/ngsw-worker.js`.
  await ctx.route('**/ngsw-worker.js', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'text/plain',
      body: 'not found',
    }),
  );

  // Capture the OLD active worker's URL.
  const preMigrationActiveUrl = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg?.active?.scriptURL ?? null;
  });

  // Force an update check. Per the SW spec, a 4xx response during
  // byte-revalidation does NOT unregister and does NOT install --
  // the registration stays as-is, the old SW remains controlling.
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg?.update().catch(() => undefined);
  });

  // Brief settle so any (incorrect) state transitions would have
  // happened by now.
  await page.waitForTimeout(2_000);

  const postUpdateActiveUrl = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg?.active?.scriptURL ?? null;
  });

  // The OLD SW must remain controlling: the migration mechanism
  // would have failed without the byte-identical alias.
  expect(postUpdateActiveUrl).toBe(preMigrationActiveUrl);
});
