import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for JotJSON's anonymous-flow smoke e2e suite.
 *
 * Runs Chromium-only against an anonymous-config production-built bundle.
 * The webServer command builds the SPA and serves it with `serve --single`
 * so SPA fallback routing works for nested routes like `/profile`.
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
    baseURL: 'http://localhost:4173',
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
  webServer: {
    command: 'npm run build && npx serve --single dist/jotjson/browser -l 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
