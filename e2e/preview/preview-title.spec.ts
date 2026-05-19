import { expect, test } from '@playwright/test';

/**
 * Deployed-only spec: validates that the document title on a SWA
 * preview environment is prefixed with `[pr-<number>] `, where
 * `<number>` is the GitHub PR number Azure SWA encoded in the
 * preview hostname slug.
 *
 * This is the CI gate against the regex-vs-cd-preview.yml contract:
 *
 *   - `src/app/core/env/env-label.ts` PREVIEW_PR_RE = `^${stem}-(\d+)\.`
 *   - `.github/workflows/cd-preview.yml:95` sets
 *     `PREVIEW_ENV: pr-${{ pull_request.number }}` and passes it to
 *     Azure as `deployment_environment`. Azure strips the `pr-`
 *     prefix and emits hostnames like
 *     `<stem>-332.<region>.azurestaticapps.net`.
 *
 * If either side of that contract drifts (Azure changes the
 * slug-stripping rule, or cd-preview.yml renames PREVIEW_ENV) the
 * SPA silently regresses to plain `[preview]`. The
 * `previewHasPrNumber` dimension on the `app.boot` telemetry event
 * is the in-flight observability signal; this spec is the
 * pre-merge gate.
 *
 * Skipped when `PLAYWRIGHT_BASE_URL` is unset (i.e. CI `e2e` job or
 * any local `npm run test:e2e` against the locally-served `dist/`).
 * The local `serve --single` runs on `localhost` -> envLabel ===
 * 'dev' -> title prefix is `[dev] `, not `[pr-N] `.
 */

const baseUrl = process.env['PLAYWRIGHT_BASE_URL']?.trim();

test.describe('Preview environment per-PR title prefix', () => {
  test.skip(
    !baseUrl,
    'preview-title.spec.ts requires PLAYWRIGHT_BASE_URL to point at a ' +
      'deployed SWA preview host (where the hostname slug carries the ' +
      'GitHub PR number). Skipping when targeting the local dist/ serve.',
  );

  test('GET / document title is prefixed with [pr-<number>]', async ({ page }) => {
    await page.goto('/');
    // Wait for the inline boot script + Angular bootstrap to settle.
    // The inline script in src/index.html sets document.title
    // synchronously before first paint; Angular's
    // EnvPrefixedTitleStrategy then re-applies on route resolution.
    // Either way the final title carries the prefix.
    await expect(page).toHaveTitle(/^\[pr-\d+\] /);
  });
});
