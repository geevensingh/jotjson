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
 * silently ignores that field. Launch options are read *only* from
 * the `playwright({ launchOptions: { args: [...] } })` factory
 * argument, which the provider spreads into the object it hands to
 * Playwright's `.launch()`. All callers must funnel launch args
 * through the `makeBrowserConfig()` helper below.
 *
 * Re-verified against `@vitest/browser-playwright@4.1.11` (issue
 * #533): still no read of `instances[].launch`. This note
 * deliberately cites the package version rather than line numbers in
 * `node_modules` -- the previous wording pinned specific dist lines,
 * which are gitignored, unversioned, and renumber on every patch
 * release (they moved by ~14 lines between 4.1.7 and 4.1.11).
 *
 * The composition itself is enforced by
 * `scripts/check-launch-args.mjs` in the `lint` chain, and proven at
 * runtime by `ensureGc()` in `json-tree.component.perf.ts`, which
 * throws if `--js-flags=--expose-gc` failed to reach Chromium.
 *
 * Dependabot keeps this family in lockstep via the `vitest` group in
 * `.github/dependabot.yml`.
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
 * Fields `makeBrowserConfig` refuses to let a caller replace.
 *
 * `provider` carries the launch-args funnel; `instances` is where the
 * PR #418 `launch` shape would re-enter. `enabled`/`headless` ride along
 * because a browser block that is off or headed is not the harness the
 * rest of this file describes.
 */
type ProtectedBrowserFields = 'enabled' | 'headless' | 'provider' | 'instances';

/**
 * Build a `browser` config block for Vitest. Funneling all
 * provider creation through this helper guarantees launch args
 * actually reach Chromium (see `COMMON_LAUNCH_ARGS` comment).
 *
 * @param extraArgs Additional Chromium launch flags appended to
 *   `COMMON_LAUNCH_ARGS`. The L2 perf bench adds
 *   `--js-flags=--expose-gc`; the unit suite passes `[]`.
 * @param overrides Optional extra browser-block fields (e.g.,
 *   `fileParallelism: false`, `onConsoleLog`). Spread *below* the
 *   protected fields, so it can add but never replace them.
 */
export function makeBrowserConfig(
  extraArgs: readonly string[] = [],
  overrides: Omit<Partial<BrowserConfigOptions>, ProtectedBrowserFields> = {},
): BrowserConfigOptions {
  // `overrides` is spread FIRST so the protected fields below always win.
  //
  // It used to be spread last, which silently defeated the guarantee this
  // helper exists to provide: a caller could pass a replacement `provider`
  // (dropping COMMON_LAUNCH_ARGS) or an `instances` array carrying the
  // ignored `launch` field, and `check-launch-args` -- which validates the
  // literal written here -- would still pass. The `Omit` above makes that
  // a compile error; the spread order makes it impossible at runtime even
  // from untyped callers.
  return {
    ...overrides,
    enabled: true,
    headless: true,
    provider: playwright({
      launchOptions: {
        args: [...COMMON_LAUNCH_ARGS, ...extraArgs],
      },
    }),
    instances: [{ browser: 'chromium' }],
  };
}
