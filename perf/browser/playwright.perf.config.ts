import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Layer-3 perf bench Playwright config.
 *
 * Differs from the smoke `playwright.config.ts` at the repo root:
 *   - testDir points at `./scenarios/`.
 *   - workers: 1, retries: 0 (any flake is a P0; perf has no retry).
 *   - per-test timeout 10 minutes (the 1M-node browser scenarios are heavy).
 *   - reuses the same webServer (build + serve) so this config can run
 *     standalone without a manual server start.
 *
 * Invoked as:
 *   npm run perf:l3
 *
 * Env vars consumed by specs (documented in docs/perf.md):
 *   - PERF_MACHINE=...    machine label baked into output rows
 */
export default defineConfig({
  testDir: './scenarios',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 10 * 60 * 1000,
  expect: {
    timeout: 30_000,
  },
  use: {
    baseURL: 'http://localhost:4173',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    reducedMotion: 'reduce',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'chromium-perf',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run build && npx serve --single dist/jotjson/browser -l 4173',
    cwd: REPO_ROOT,
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env['CI'],
    timeout: 240_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
