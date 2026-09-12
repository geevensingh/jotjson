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
//   - testTimeout (env-gated; see resolution priority below):
//       - `JOTJSON_PERF_L2_TIMEOUT_MS=<ms>` (escape hatch) takes
//         priority over both defaults; values must match `^\d+$`
//         (rejects scientific notation, units, whitespace) or are
//         ignored with a one-shot warn.
//       - `JOTJSON_PERF_L2_FORCE_1M=1` defaults to 4 hours
//         (conservative upper bound until #437's measurement
//         tightens it).
//       - Otherwise: 15 minutes (sized for the default 10K + 100K
//         tiers; well under per-iter wall-clock at those sizes).
//     The escape hatch emits a one-time console.warn when set so a
//     downstream timeout failure can be attributed (mirrors
//     `api/src/shared/auth.ts` dev-auth-bypass precedent).
//   - 1M-node fixture opt-in: `JOTJSON_PERF_L2_FORCE_1M=1` adds
//     `src/testing/perf-l2-force-1m.ts` to setupFiles. The setupFile
//     sets `window.__perfL2Force1M = true` in the browser context
//     before `json-tree.component.perf.ts` loads, so the spec's
//     module-level `defaultFixtures()` includes the 1M tier. See
//     `docs/perf.md` "Layer 2 -- vitest perf bench" for invocation
//     and re-measurement-trigger discussion.
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

// Env-var names (mirrors `vitest.config.mts:17 SEED_ENV_VAR` pattern).
// Both follow the `JOTJSON_*` first-party prefix convention from
// AGENTS.md S4, established by issue #436's JOTJSON_TEST_SEED rename.
const FORCE_1M_ENV_VAR = 'JOTJSON_PERF_L2_FORCE_1M' as const;
const TIMEOUT_OVERRIDE_ENV_VAR = 'JOTJSON_PERF_L2_TIMEOUT_MS' as const;

// Boolean-parse convention follows the L3 PERF_FORCE_* family
// (perf/browser/scenarios/paste-large.spec.ts:92, :173;
// expand-all.spec.ts:42; scroll-after-expand.spec.ts:47). The L2/L3
// perf tiers use strict `=== '1'`; this intentionally diverges from
// `JOTJSON_DEV_AUTH_BYPASS` (api/src/shared/auth.ts) which uses
// `=== 'true'` and explicitly rejects `'1'`. The perf-tier convention
// is independent from the dev-auth-bypass convention.
const force1M = process.env[FORCE_1M_ENV_VAR] === '1';

// Strict integer-string match. `Number()` silently coerces
// `'15min'`, `' 15 '`, `'1e308'`, etc.; we reject anything that
// isn't pure digits so a typo can't masquerade as a tiny or
// infinite timeout.
const rawTimeoutOverride = process.env[TIMEOUT_OVERRIDE_ENV_VAR];
const timeoutOverride =
  rawTimeoutOverride && /^\d+$/.test(rawTimeoutOverride) ? Number(rawTimeoutOverride) : Number.NaN;

if (Number.isFinite(timeoutOverride) && timeoutOverride > 0) {
  // eslint-disable-next-line no-console -- intentional one-shot operator warn
  console.warn(
    `[vitest.perf.config] ${TIMEOUT_OVERRIDE_ENV_VAR}=${timeoutOverride} ` +
      `overriding per-test timeout. If a test times out under this ` +
      `override, re-check the override value before declaring a perf ` +
      `regression.`,
  );
} else if (rawTimeoutOverride && !Number.isFinite(timeoutOverride)) {
  // eslint-disable-next-line no-console -- intentional one-shot operator warn
  console.warn(
    `[vitest.perf.config] ${TIMEOUT_OVERRIDE_ENV_VAR}=${rawTimeoutOverride} ` +
      `is not a positive integer string; ignored. Use plain milliseconds, ` +
      `e.g. ${TIMEOUT_OVERRIDE_ENV_VAR}=3600000 for 1 hour.`,
  );
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

// Resolution priority: explicit override > 1M default > base 15 min.
// The 4-hour 1M default is a conservative upper bound until #437's
// Phase 2 measurement provides per-iter wall-clock numbers; with
// (warmup_iters + timed_iters) = 7 it allows ~30 min/iter before a
// real run trips the cap.
const testTimeoutMs =
  Number.isFinite(timeoutOverride) && timeoutOverride > 0
    ? timeoutOverride
    : force1M
      ? FOUR_HOURS_MS
      : FIFTEEN_MINUTES_MS;

// `sharedTestBase.setupFiles` is a readonly tuple (`as const`).
// Spread on BOTH branches so we never share-by-reference with the
// frozen tuple and never trip a `readonly`-variance compile error.
const perfSetupFiles: string[] = force1M
  ? [...sharedTestBase.setupFiles, 'src/testing/perf-l2-force-1m.ts']
  : [...sharedTestBase.setupFiles];

export default defineConfig(() => ({
  plugins: sharedPlugins,
  test: {
    ...sharedTestBase,
    setupFiles: perfSetupFiles,
    include: ['src/**/*.perf.ts'],
    exclude: ['src/**/*.test.ts', 'node_modules/**', 'dist/**'],
    reporters: ['default'],
    coverage: { enabled: false },
    sequence: { shuffle: false },
    testTimeout: testTimeoutMs,
    hookTimeout: testTimeoutMs,
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
