import { expect, test } from '@playwright/test';

/**
 * Deployed-only spec: validates that the SWA-applied response headers
 * declared in `staticwebapp.config.json` `globalHeaders` actually reach
 * the browser on a request to `/`.
 *
 * The repo has a `lint:swa-config` gate (`scripts/check-swa-config.mjs`)
 * that asserts the source config file declares each required header
 * with the expected value. That gate runs on every CI build but it can
 * only read the source file -- it cannot prove the SWA deploy pipeline,
 * Azure Front Door, or any CDN edge in between is not stripping or
 * rewriting headers on the way to the browser. This spec closes that
 * end-to-end gap by inspecting a real HTTP response from a deployed
 * preview environment.
 *
 * Skipped when `PLAYWRIGHT_BASE_URL` is unset (i.e. CI `e2e` job or any
 * local `npm run test:e2e` against the locally-served `dist/`). The
 * local `serve --single` does not apply `globalHeaders`, so running
 * this spec there would always fail or, worse, silently false-pass
 * against a different header set.
 *
 * If a header is added to or removed from `staticwebapp.config.json`,
 * three places must be kept in sync:
 *   1. `staticwebapp.config.json` `globalHeaders` (the source).
 *   2. `scripts/check-swa-config.mjs` `checkGlobalHeaders()` (source lint).
 *   3. This spec (deployed-response check).
 */

const baseUrl = process.env['PLAYWRIGHT_BASE_URL']?.trim();

test.describe('Deployed SWA globalHeaders reach the browser', () => {
  test.skip(
    !baseUrl,
    'security-headers.spec.ts requires PLAYWRIGHT_BASE_URL to point at a ' +
      'deployed SWA host. Skipping when targeting the local dist/ serve, ' +
      'which does not apply globalHeaders.',
  );

  test('GET / response carries all 7 SWA globalHeaders', async ({ request }) => {
    const response = await request.get('/');
    expect(response.status()).toBe(200);

    const headers = response.headers();

    expect(headers['x-content-type-options'], 'X-Content-Type-Options').toBe('nosniff');
    expect(headers['x-frame-options'], 'X-Frame-Options').toBe('SAMEORIGIN');
    expect(headers['x-xss-protection'], 'X-XSS-Protection').toBe('0');
    expect(headers['referrer-policy'], 'Referrer-Policy').toBe('strict-origin-when-cross-origin');

    const hsts = headers['strict-transport-security'];
    expect(hsts, 'Strict-Transport-Security present').toBeTruthy();
    const maxAgeMatch = /(?:^|;|\s)\s*max-age\s*=\s*(\d+)/i.exec(hsts ?? '');
    expect(maxAgeMatch, 'Strict-Transport-Security has max-age=...').not.toBeNull();
    expect(
      Number(maxAgeMatch?.[1]),
      'Strict-Transport-Security max-age >= 1 year',
    ).toBeGreaterThanOrEqual(31_536_000);
    expect(
      /(?:^|;|\s)\s*includeSubDomains\b/i.test(hsts ?? ''),
      'Strict-Transport-Security has includeSubDomains',
    ).toBe(true);

    const permissionsPolicy = headers['permissions-policy'];
    expect(permissionsPolicy, 'Permissions-Policy present').toBeTruthy();
    expect(permissionsPolicy, 'Permissions-Policy declares clipboard-read').toMatch(
      /\bclipboard-read\s*=/,
    );
    expect(permissionsPolicy, 'Permissions-Policy declares clipboard-write').toMatch(
      /\bclipboard-write\s*=/,
    );

    expect(headers['content-security-policy'], 'Content-Security-Policy present').toBeTruthy();
  });
});
