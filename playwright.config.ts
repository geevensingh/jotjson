import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for JotJSON's anonymous-flow smoke e2e suite.
 *
 * Default: builds the SPA and serves it locally with `serve --single` so
 * SPA fallback routing works for nested routes like `/profile`, then runs
 * Chromium against `http://localhost:4173`.
 *
 * Deployed-URL override: set `PLAYWRIGHT_BASE_URL` (e.g.
 * `https://<host>.azurestaticapps.net/`) to skip the local build/serve and
 * target an already-deployed environment instead. Used by Phase 1's manual
 * verification against `nonprod` and by Phase 2's per-PR preview smoke.
 *
 * Determinism guardrails (per zero-flake-tolerance norm):
 * - retries: 0 - any flake is a P0 bug, not absorbed by retries.
 * - workers: 1 - removes parallel-test contention surface
 *   (Monaco, service worker, localStorage) for the initial 2-spec smoke.
 * - reducedMotion: 'reduce' - eliminates animation timing as a flake source.
 * - bounded action/navigation/expect timeouts.
 * - No waitForLoadState('networkidle') in specs; service worker, telemetry,
 *   and lazy chunks make it a poor readiness signal.
 *
 * See e2e/README.md for how to add a spec, run locally, and debug failures.
 */
const previewBaseUrl = process.env['PLAYWRIGHT_BASE_URL']?.replace(/\/$/, '');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  workers: 1,
  reporter: process.env['CI']
    ? [
        ['list'],
        ['html', { open: 'never' }],
        ['junit', { outputFile: 'test-results/e2e/junit.xml' }],
      ]
    : [['list'], ['html', { open: 'never' }]],
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: previewBaseUrl ?? 'http://localhost:4173',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // When PLAYWRIGHT_BASE_URL is set we are targeting a deployed environment
  // (nonprod, preview env, etc.) and must NOT spin up a local serve - doing
  // so would race against the build cache and possibly serve stale assets.
  webServer: previewBaseUrl
    ? undefined
    : {
        command: 'npm run build && npx serve --single dist/jotjson/browser -l 4173',
        url: 'http://localhost:4173',
        reuseExistingServer: !process.env['CI'],
        timeout: 180_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
