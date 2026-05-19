import { expect, test } from '@playwright/test';

/**
 * Broken-SW canary (architect v2 R2 + skeptic v3 S5 fix).
 *
 * Parameterized over BOTH `/sw.js` (the canonical URL the new
 * `main.ts` registers) and `/ngsw-worker.js` (the legacy alias the
 * stuck cohort's 24h byte-check fires against). v2's mistake was
 * canarying only `/sw.js` -- a broken legacy alias would silently
 * brick the stuck cohort with no visible failure.
 *
 * Asserts:
 *   (a) the page renders even when the SW script fails to parse
 *       -- registration failure must NOT block bootstrap;
 *   (b) for `/sw.js`, the `sw.registerFailed` queue entry is
 *       written with a classified reason -- proves the
 *       `classifyRegistrationError` closed-enum bucketing is
 *       exercised by a real broken-SW path. Accepts either
 *       `'syntax'` (some browsers) or `'type'` (Chromium
 *       empirically classifies unparseable-script registration
 *       failures as `TypeError`). The point of the assertion is
 *       to prove a known bucket fired, not to mandate one
 *       browser's classification.
 *
 * Fixture body is *unparseable* JS (unterminated string literal).
 * The skeptic v5 S5 hope that this would force `SyntaxError`
 * across every browser was empirically refuted on Chromium
 * (which surfaces `TypeError` for parse-step rejection of the
 * SW registration promise). The closed-enum bucketing handles
 * both, so the canary remains useful as long as the reason is
 * one of the seven known buckets and not `'other'`.
 */
for (const brokenUrl of ['/sw.js', '/ngsw-worker.js'] as const) {
  test(`broken SW at ${brokenUrl} does not block bootstrap`, async ({ browser }) => {
    const ctx = await browser.newContext();
    await ctx.route(`**${brokenUrl}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: 'throw new SyntaxError("broken',
      }),
    );

    const page = await ctx.newPage();
    await page.goto('/');

    // The page must render and become interactive even if SW
    // registration fails. Assert: app-root is visible.
    await expect(page.locator('app-root')).toBeVisible({ timeout: 10_000 });

    if (brokenUrl === '/sw.js') {
      // The new main.ts registers `/sw.js`; the rejection should
      // be classified into a known bucket (`syntax` per the W3C
      // spec, OR `type` per Chromium's empirical behavior on
      // unparseable script bytes) and queued in sessionStorage
      // (or already drained -- whichever happens first, the queue
      // persists across the bootstrap boundary).
      await page.waitForFunction(
        () => {
          const raw = sessionStorage.getItem('jotjson.sw.events');
          return raw !== null && raw.includes('sw.registerFailed');
        },
        null,
        { timeout: 10_000 },
      );
      const queue = await page.evaluate(() => sessionStorage.getItem('jotjson.sw.events'));
      // Accept either `'syntax'` (spec-correct) or `'type'`
      // (Chromium's empirical classification). The point is to
      // prove a known closed-enum bucket fired, not `'other'`.
      expect(queue).toMatch(/"reason":"(syntax|type)"/);
    }
    // For `/ngsw-worker.js`: the new main.ts doesn't register
    // that URL -- only the OLD ngsw's byte-check fires against
    // it. Without an OLD ngsw in the test fixture there's
    // nothing to detect; the build-time byte-equality check
    // (scripts/build-sw.mjs + scripts/check-sw-shape.mjs)
    // catches a broken legacy-alias build before deploy.
  });
}
