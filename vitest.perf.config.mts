/// <reference types="vitest" />
//
// Vitest configuration for the JotJSON L2 perf bench
// (`npm run perf:l2`). Picks up `src/**/*.perf.ts`, runs
// under Chromium with `--js-flags=--expose-gc`, and writes
// `@@PERF_L2@@<json>@@END@@` sentinel rows to stdout for
// `scripts/perf/run-l2.mjs` to parse.
//
// Deltas vs `vitest.config.mts`:
//   - include perf files, exclude unit files
//   - testTimeout: 15 minutes (sized for the default 10K + 100K
//     tiers; the opt-in 1M tier may need more headroom -- see #437)
//   - browser launch args add `--js-flags=--expose-gc` so the spec's
//     `ensureGc()` precondition holds
//   - browser `fileParallelism: false` so benches are not racing
//     each other for CPU (the only perf file today is JsonTree, but
//     this is the explicit invariant for the future)
//   - browser `onConsoleLog` forwards `[reporter.stdout]`-flavored
//     payloads as raw bytes on stdout so the wrapper's sentinel
//     regex sees them unmodified by Vitest reporter formatting
//   - no coverage (perf runs are measurement, not coverage)
//   - no shuffle (perf runs should be deterministic across reruns)
//   - no restoreMocks/unstubGlobals/unstubEnvs (perf specs neither
//     spy nor stub; the unit-config hardening is dead weight here
//     and may interfere with cross-iteration state)
//   - reporters: just `default` (no junit, no SeedReporter -- perf
//     output is the sentinel stream and the human spec summary)

import { defineConfig } from 'vitest/config';
import { makeBrowserConfig, sharedPlugins, sharedTestBase } from './vitest.shared.mts';

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

export default defineConfig(() => ({
  plugins: sharedPlugins,
  test: {
    ...sharedTestBase,
    include: ['src/**/*.perf.ts'],
    exclude: ['src/**/*.test.ts', 'node_modules/**', 'dist/**'],
    reporters: ['default'],
    coverage: { enabled: false },
    sequence: { shuffle: false },
    testTimeout: FIFTEEN_MINUTES_MS,
    hookTimeout: FIFTEEN_MINUTES_MS,
    restoreMocks: false,
    unstubGlobals: false,
    unstubEnvs: false,
    browser: makeBrowserConfig(['--js-flags=--expose-gc'], {
      fileParallelism: false,
      // Forward browser-side `console.log` lines as raw stdout bytes
      // so `scripts/perf/run-l2.mjs`'s `@@PERF_L2@@...@@END@@`
      // sentinel regex sees them verbatim. Returning `false`
      // suppresses Vitest's own `stdout | <file>` reporter wrapping.
      onConsoleLog: (log: string) => {
        process.stdout.write(log);
        if (!log.endsWith('\n')) process.stdout.write('\n');
        return false;
      },
    }),
  },
}));
