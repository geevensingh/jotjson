import { expect, test } from '@playwright/test';

/**
 * Deployed-only spec: validates that the document title on a SWA
 * preview environment is prefixed with `[pr-<EXPECTED_PR_NUMBER>] `,
 * where `<EXPECTED_PR_NUMBER>` is the ground-truth GitHub PR number
 * injected into the e2e job from the workflow's
 * `github.event.pull_request.number` (see `.github/workflows/cd-preview.yml`
 * `EXPECTED_PR_NUMBER` env var).
 *
 * This is the workflow-to-SPA contract check:
 *
 *   GitHub PR number
 *     -> `cd-preview.yml:95` `PREVIEW_ENV: pr-<n>`
 *     -> Azure SWA strips `pr-` prefix
 *     -> hostname slug `<stem>-<n>.<region>.azurestaticapps.net`
 *     -> SPA `EnvLabelService.prNumber`
 *     -> `EnvLabelService.withPrefix` rendering
 *     -> `document.title` `[pr-<n>] ...`
 *
 * Why ground-truth-from-workflow (not derive-from-URL):
 *   Deriving the expected PR number from the preview URL hostname
 *   would be self-confirming. A typo in `PREVIEW_ENV` at
 *   `cd-preview.yml:95` (e.g., off-by-one, wrong template literal)
 *   would emit a wrong slug AND a wrong expected value -- both
 *   sides of the regex contract drift in lockstep and the test
 *   false-passes. With the workflow-injected env var, the spec
 *   catches the typo end-to-end.
 *
 * Skip conditions:
 *   - `PLAYWRIGHT_BASE_URL` unset (local `npm run test:e2e`
 *     against the locally-served `dist/` runs on `localhost` ->
 *     envLabel === 'dev' -> `[dev]` prefix, not `[pr-N]`).
 *   - `EXPECTED_PR_NUMBER` unset (e.g., local `npm run test:e2e`
 *     against a manually-targeted preview URL without the
 *     workflow context). The deployed cd-preview.yml job always
 *     sets both; missing one of the two is an explicit local
 *     scenario.
 *   - Preview slot reached via CNAME (e.g., a hypothetical
 *     `pr-332.preview.jotjson.com` alias): the SPA still renders
 *     `[pr-332]` because `EnvLabelService` runs against the
 *     Azure-emitted preview hostname, but this spec skips when
 *     either env var is missing. CNAMEs are not currently in use;
 *     re-evaluate this docblock if one is added.
 */

const baseUrl = process.env['PLAYWRIGHT_BASE_URL']?.trim();
const expectedPrRaw = process.env['EXPECTED_PR_NUMBER']?.trim();
const expectedPr = expectedPrRaw ? Number.parseInt(expectedPrRaw, 10) : NaN;
const expectedPrValid = Number.isInteger(expectedPr) && expectedPr > 0;

test.describe('Preview environment per-PR title prefix', () => {
  test.skip(
    !baseUrl || !expectedPrValid,
    'preview-title.spec.ts requires both PLAYWRIGHT_BASE_URL (the ' +
      'deployed SWA preview host) and EXPECTED_PR_NUMBER (a positive ' +
      'integer; injected by cd-preview.yml from ' +
      'github.event.pull_request.number). Skipping when either is ' +
      'unset or invalid -- this is the local-run path.',
  );

  test('GET / document title is prefixed with [pr-<EXPECTED_PR_NUMBER>]', async ({ page }) => {
    await page.goto('/');
    // The inline boot script in `src/index.html` sets document.title
    // synchronously before first paint; Angular's
    // EnvPrefixedTitleStrategy then re-applies on route resolution.
    // Either way the final title carries the prefix. Regex form
    // (not exact literal) because the title also carries the route's
    // own title text after the prefix.
    const expectedPrefix = new RegExp(`^\\[pr-${expectedPr}\\] `);
    await expect(page).toHaveTitle(expectedPrefix);
  });
});
