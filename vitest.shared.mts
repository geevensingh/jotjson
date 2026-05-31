/// <reference types="vitest" />
//
// Shared Vitest configuration substrate for JotJSON. Consumed by both
// the unit-test config (`vitest.config.mts`) and the L2 perf-bench
// config (`vitest.perf.config.mts`) so the two stay in sync on the
// asset/polyfill surface they both need (Angular plugin, fixtures
// mount, Monaco mount, zone.js polyfills, monaco inline).
//
// Architectural note (issue #417): we factor out *named exports*
// rather than a single mergeable config object. Vitest's
// `mergeConfig` performs deep-merge with array concatenation, which
// silently breaks for singleton fields like `browser.provider` (the
// second config's value replaces the first's, but the user has to
// know that). Explicit named exports let each consumer compose
// deliberately.

import angular from '@analogjs/vite-plugin-angular';
import { playwright } from '@vitest/browser-playwright';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginOption } from 'vite';
import type { BrowserConfigOptions } from 'vitest/node';
import { staticMount } from './scripts/static-mount.mjs';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

/**
 * Chromium launch flags shared by every Vitest harness in this repo.
 *
 * Historical note: PR #418 attempted to pass these via
 * `instances[].launch.args`, but `@vitest/browser-playwright`
 * silently ignores that field. The launch options are only read
 * from the `playwright({ launchOptions: { args: [...] } })` factory
 * argument (verified in
 * `node_modules/@vitest/browser-playwright/dist/index.js` lines
 * 867-872). All callers must funnel launch args through the
 * `makeBrowserConfig()` helper below.
 */
export const COMMON_LAUNCH_ARGS: readonly string[] = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
];

export const sharedPlugins: PluginOption[] = [
  angular(),
  staticMount('/fixtures', join(projectRoot, 'src/testing/fixtures')),
  staticMount('/vs', join(projectRoot, 'node_modules/monaco-editor/min/vs')),
];

/**
 * Common `test` block fields shared by unit + perf configs. Caller
 * spreads this and adds its own `include`, `exclude`, `reporters`,
 * `coverage`, `browser`, etc.
 */
export const sharedTestBase = {
  globals: true,
  setupFiles: ['src/test-setup.ts'],
  server: {
    deps: {
      inline: ['monaco-editor'],
    },
  },
  optimizeDeps: {
    include: [
      '@angular/localize/init',
      'zone.js',
      'zone.js/testing',
      'zone.js/plugins/proxy',
      'zone.js/plugins/sync-test',
    ],
  },
} as const;

/**
 * Build a `browser` config block for Vitest. Funneling all
 * provider creation through this helper guarantees launch args
 * actually reach Chromium (see `COMMON_LAUNCH_ARGS` comment).
 *
 * @param extraArgs Additional Chromium launch flags appended to
 *   `COMMON_LAUNCH_ARGS`. The L2 perf bench adds
 *   `--js-flags=--expose-gc`; the unit suite passes `[]`.
 * @param overrides Optional extra browser-block fields (e.g.,
 *   `fileParallelism: false`, `onConsoleLog`). Merged shallow on
 *   top of the returned object.
 */
export function makeBrowserConfig(
  extraArgs: readonly string[] = [],
  overrides: Partial<BrowserConfigOptions> = {},
): BrowserConfigOptions {
  return {
    enabled: true,
    headless: true,
    provider: playwright({
      launchOptions: {
        args: [...COMMON_LAUNCH_ARGS, ...extraArgs],
      },
    }),
    instances: [{ browser: 'chromium' }],
    ...overrides,
  };
}
