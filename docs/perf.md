# Perf benches

Local-only, three-layer perf measurement suite for JotJSON. Pre-v1
baseline tooling: every contributor seeds and refreshes their own
per-machine baseline; CI does not yet enforce perf thresholds.

## TL;DR

```bash
# One-time setup: pick your machine label.
node scripts/perf/machine-label.mjs --suggest
# -> e.g., win32-x64-1f4d3a
$env:PERF_MACHINE = "win32-x64-1f4d3a"   # PowerShell
# export PERF_MACHINE=win32-x64-1f4d3a   # bash

# First-time baseline:
npm run perf:all
npm run perf:baseline

# After your change:
npm run perf:all
npm run perf:diff
```

`perf:diff` exits non-zero on flagged rows.

## Why three layers

| Layer | What it measures           | Tooling                                          | Output                                             |
| ----- | -------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| 1     | Pure functions (no DOM)    | `node --expose-gc` against compiled `.bench.js`  | `perf-results/<utc>/layer-1.jsonl`                 |
| 2     | Angular components in DOM  | `ng test --configuration perf` + headless Chrome | `perf-results/<utc>/layer-2.jsonl`                 |
| 3     | Full browser, user actions | Playwright + CDP                                 | `perf-results/<utc>/layer-{3.jsonl,traces/*}.json` |

L1 isolates algorithmic perf (parse, build-tree). L2 catches Angular
change-detection and template costs. L3 measures user-perceived
latency end-to-end and captures `.cpuprofile` flame-graphs you can
open directly in Chrome DevTools (`Performance` panel ->
`Load profile...`).

## Per-machine baselines

`PERF_MACHINE` is **mandatory** for `perf:l1`, `perf:l2`, `perf:l3`,
`perf:baseline`, and `perf:diff`. Use the canonical label format
`<platform>-<arch>-<6-char-cpu-hash>` produced by:

```bash
node scripts/perf/machine-label.mjs --suggest
```

Baselines live at `perf-baselines/<PERF_MACHINE>.json` and are
gitignored by default (each machine's numbers are noise to other
machines). Commit the file only if your team agrees on a shared
"reference" machine for cross-PR comparison.

### Baseline file format

```jsonc
{
  "machineLabel": "win32-x64-1f4d3a",
  "lastUpdatedUtc": "2026-05-11T19:00:00.000Z",
  "codeShaAtBaseline": "8c3d826",
  "rows": {
    "1.parse.deep25.10K": {
      "wallNsMedian": 12387700,
      "wallNsIqrLow": 12317350,
      "wallNsIqrHigh": 12750750,
      "iters": 20,
      "approxNodes": 10000
    }
    // ... more rows ...
  }
}
```

One canonical shape, used by both `perf:baseline` (writer) and
`perf:diff` (reader). Per-row key is
`<layer>.<scenario>.<fixture>.<size>`.

### Freshness

`perf:check-fresh` warns when your baseline is more than 30 days old.
This is informational (exit code 0); CI does not enforce it. The
contributor norm is: **if you touched a perf-sensitive file (`parse.ts`,
`build-tree.ts`, `json-tree.component.ts`, the Monaco editor wrapper,
the formatting/highlight engines), re-bench before merging.**

## Layer 1: Node microbench

Two benches run today:

- `perf/bench/parse.bench.ts` -- the extracted pure
  `parse()` function in `src/app/core/json/parse.ts`.
- `perf/bench/build-tree.bench.ts` -- the extracted pure
  `buildTree()` function in
  `src/app/shared/components/json-tree/build-tree.ts`.

Both run against deep25 + wide-aoo fixtures at 10K, 100K, 1M nodes.
The 5M variant is gated behind `os.totalmem() >= 8 GB || PERF_FORCE_5M=1`.

Mechanics:

- `tsc -p tsconfig.perf.json` compiles the pure modules + bench
  harness + fixture generator into `dist-perf/` as ESM.
- `dist-perf/package.json` is dropped with `{ "type": "module" }` so
  Node ESM resolves the `.js` emit cleanly.
- Each bench runs in its own Node child process under
  `--expose-gc --max-old-space-size=12288`.
- Per measurement: 3 warmup iterations discarded, then N=20 timed.
- Per iteration:
  ```
  gc(); heapBefore = process.memoryUsage().heapUsed;
  doWork();
  gc(); heapAfter = process.memoryUsage().heapUsed;
  ```
- Stats reported: median, IQR (25th/75th), stddev, bytesAlloc median.

### Generator determinism

`perf/fixtures/generate.ts` exports a mulberry32-seeded generator. The
build script asserts SHA-256 hashes of generator output for
`approxNodes=1000` on both shapes (see `GENERATOR_GOLDEN_HASHES` in
`scripts/perf/build.mjs`).

When you intentionally change the generator:

```bash
$env:PERF_BUILD_SEED_HASHES = "1"
node scripts/perf/build.mjs
# Copy the printed hashes into GENERATOR_GOLDEN_HASHES in build.mjs.
Remove-Item Env:\PERF_BUILD_SEED_HASHES
node scripts/perf/build.mjs    # confirm green
```

## Layer 2: Karma component bench

`src/app/shared/components/json-tree/json-tree.component.perf.ts` runs
under a perf-only Angular `test` configuration:

- `tsconfig.perf-l2.json` includes `*.perf.ts` and excludes `*.spec.ts`.
- `karma.perf.conf.js` adds `--js-flags=--expose-gc` so the spec can
  call `globalThis.gc()` between iterations, and bumps per-test
  timeout to 5 minutes.

Default fixture matrix: deep25 + wide-aoo at 10K. Set
`window.__perfL2Force100K = true` (or `?force100k=1`) to also bench
at 100K, and `window.__perfL2Force1M = true` (or `?force1m=1`) to add
1M. Each 100K iter is ~50s; the 1M iter is multiple minutes. Karma
timeouts (`browserNoActivityTimeout`, `browserDisconnectTimeout`,
Jasmine `timeoutInterval`) are bumped to 15 minutes so opt-in runs
have room.

The L2 spec writes rows to `console.log` with the sentinel
`@@PERF_L2@@<json>@@END@@`; `scripts/perf/run-l2.mjs` harvests those
into `perf-results/<utc>/layer-2.jsonl`.

L2 is **never** in `verify:fast` / `npm test`. The
`scripts/perf/check-perf-ts-excluded.mjs` script asserts
`tsconfig.spec.json` excludes `src/**/*.perf.ts`; it runs as a
prestep of `perf:l2`.

## Layer 3: Playwright + CDP flame-graph

Three scenarios under `perf/browser/scenarios/`:

1. `paste-large.spec.ts` -- programmatic Monaco `setValue` of 10K /
   100K / 1M / (5M, opt-in) wide-aoo JSON; waits for first tree row.
2. `expand-all.spec.ts` -- 1M-node fixture, click "Expand all".
3. `scroll-after-expand.spec.ts` -- 1M-node fixture, expand-all, then
   50 wheel events at ~60Hz over the tree pane.

Each scenario runs N=7 timed (1 warmup) with the FIRST timed
iteration captured to:

- `perf-results/<utc>/traces/<scenario>-<fixture>-<size>-iter0.cpuprofile`
- `perf-results/<utc>/traces/<scenario>-<fixture>-<size>-iter0.trace.json`

Open `.cpuprofile` files in Chrome DevTools: `Performance` panel ->
right-click the timeline area -> `Load profile...`. Select the
`.cpuprofile`. The flame-graph appears in the `Bottom-Up` tree.

`.trace.json` files open in `chrome://tracing` (or the newer
`chrome://inspect` Performance Insights panel).

### Telemetry harness

L3 specs install a window-attached harness shim
(`window.__jotjsonPerfHarness = { events: [] }`) via
`page.addInitScript`. The `LoggerService` honors it via
`__attachPerfHarnessForTesting`, which is null-op in production. We
never add new DOM markers; existing telemetry events
(`paste.handle`, `monaco.loaded`) carry the relevant timing and are
read back via the harness.

## Perf targets

`perf-targets.json` records *operationalizable* NFR ceilings (not
soft regressions). Today the only enforced row is:

```jsonc
{
  "key": "l3.paste-large.cosmos-doc-sample.5m.longestTaskMs",
  "ceiling": 200,
  "ceilingUnit": "ms",
  "anchorsNfr": "DESIGN_SPEC.md NFR #1 (open a 5 MB JSON file without freezing)"
}
```

Other DESIGN_SPEC NFRs (TTI<2s on 4G; api/ p95<200ms) are deferred to
follow-up issues; they require CI infra (4G throttling, api-side
load testing) not in scope for v1.

## Real fixtures

`perf/fixtures/real/cosmos-doc-sample.json` is a hand-anonymized
Aras/Cosmos-shaped document. Provenance, anonymization recipe, and
the verifier mechanism live in `perf/fixtures/real/README.md`.

When you add a new real fixture, run:

```bash
node scripts/perf/check-fixture-redaction.mjs perf/fixtures/real/<file>.json
```

The verifier is **not** wired into `lint:all` -- it is a manual safety
check at fixture-add time.

## Cleanup

```bash
npm run perf:clean             # prune perf-results/ dirs older than 7 days
npm run perf:clean -- --dry-run
```

`perf-results/` and `dist-perf/` are gitignored.

## Known v1 simplifications

- **`perf:diff` uses percentage thresholds only**: the baseline format
  records IQR, not stddev, so the `2 * pooled_stddev` term in the plan
  is informational. Use `wallNsStddev` from the JSONL row when you
  want to interpret a row by hand.
- **No `_reference-range.json`**: the `perf:baseline` file is the
  single source of truth (architect r2 tech-debt #2 adoption).
- **No CI gate**: perf benches do not run in CI yet. Filed as
  follow-up issue (priority:low, requires self-hosted runner).
- **L2 caps default at 10K nodes**: 100K deep25 mat-tree (NOT
  virtualized) takes ~50s per iteration synchronously, and the
  browser thread is blocked during the timed loop so Karma's
  socket-ping watchdog disconnects before completion at the default
  5-min timeouts. The L2 spec gates 100K behind `?force100k=1` (the
  Karma config sets a 15-min watchdog so the opt-in still works).
  1M is gated similarly behind `?force1m=1`.
- **L1 5M fixtures are gated** by `os.totalmem() >= 8 GB ||
  PERF_FORCE_5M=1`; the run-bench worker uses
  `--max-old-space-size=12288` to keep 1M deep25 stable.

See `plan.md` -> "Out of scope" in the session for the full
follow-up issue list.
