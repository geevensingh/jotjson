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

## Running the full suite

`npm run perf:all` runs the three layers into a single results dir:

```text
perf-results/<utc>/layer-1.jsonl
perf-results/<utc>/layer-2.jsonl
perf-results/<utc>/layer-3.jsonl
```

The orchestrator generates one UTC stamp and exports it as
`PERF_RESULTS_DIR` so each layer writes into the same dir. Standalone
`npm run perf:l1` (or `perf:l2` / `perf:l3`) still works -- each layer
falls back to its own UTC stamp when `PERF_RESULTS_DIR` is unset.

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

`PERF_MACHINE` is **optional**: if unset, the perf scripts fall back to
the deterministic label produced by `suggestMachineLabel()` (same shape
as `<platform>-<arch>-<6-char-cpu-hash>`). Set it explicitly when you
want a stable name across machines with similar hardware fingerprints,
or when you intentionally want to compare runs from different hosts
against a single shared baseline file. Print the suggested label any
time with:

```bash
node scripts/perf/machine-label.mjs --suggest
```

Baselines live at `perf-baselines/<label>.json` and are gitignored by
default (each machine's numbers are noise to other machines). Commit
the file only if your team agrees on a shared "reference" machine for
cross-PR comparison.

### Baseline file format

```jsonc
{
  "schemaVersion": 1,
  "machineLabel": "win32-x64-1f4d3a",
  "lastUpdatedUtc": "2026-05-11T19:00:00.000Z",
  "codeShaAtBaseline": "8c3d826",
  "rows": {
    "1.parse.deep25.10k": {
      "wallNsMedian": 12387700,
      "wallNsIqrLow": 12317350,
      "wallNsIqrHigh": 12750750,
      "iters": 20,
      "approxNodes": 10000,
      "heapRetainedDeltaMedian": 0,
      "heapWorkingSetMedian": 0
    }
    // ... more rows ...
  }
}
```

The `schemaVersion` field is mandatory; readers fail loud on mismatch.
The L3-only `longestTaskMsMedian` field is present on rows captured by
`scripts/perf/run-l3.mjs`. One canonical shape, used by both
`perf:baseline` (writer) and `perf:diff` (reader). Per-row key is
`<layer>.<scenario>.<fixture>.<size>`.

### Heap memory semantics (L1 benches)

The L1 benches capture two complementary heap deltas per timed
iteration:

- `heapRetainedDelta` = `heapUsed` after the second `gc()` minus
  `heapUsed` before the first `gc()`. With both GCs honored this is
  the **retained** allocation from one iteration to the next - the
  closest thing Node exposes to "memory the bench leaks per call".
  Should sit near zero for pure functions; large deltas signal
  reference retention.
- `heapWorkingSet` = `heapUsed` immediately after `doWork()` minus
  `heapBefore`. This is the **working-set peak** that the function
  needed during the run, before GC reclaims it. Useful for sizing
  worst-case memory pressure (e.g., for the parse + tree-build path
  on a 1M-node fixture).

Both metrics are reported as median (and stddev/IQR where applicable)
across the timed iterations. `bytesAlloc*` columns from earlier
revisions are gone; readers should use `heapRetainedDelta*` and the
new `heapWorkingSet*` columns.

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

Both run against the catalog matrix in `perf/fixtures/catalog.ts`:
deep25 + wide-aoo fixtures at 10K, 100K, and 1M nodes.

Mechanics:

- `tsconfig.perf.json` compiles the pure modules + bench
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
  heapAfterWork = process.memoryUsage().heapUsed;
  gc(); heapAfter = process.memoryUsage().heapUsed;
  ```
- Stats reported: median, IQR (25th/75th), stddev,
  `heapRetainedDelta` (post-second-gc - pre-first-gc) and
  `heapWorkingSet` (post-work - pre-first-gc) medians + maxes.

### Generator determinism

`perf/fixtures/catalog.ts` defines the canonical fixture matrix.
`perf/fixtures/generate.ts` exports a mulberry32-seeded generator. The
build script asserts SHA-256 hashes of generator output for
`approxNodes=1000` on both shapes (see `GENERATOR_GOLDEN_HASHES` in
`scripts/perf/build.mjs`), and `perf/fixtures/generate.test.mjs`
asserts the wide-aoo 10K + 100K hashes under `npm run test:scripts`.

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
  call `globalThis.gc()` between iterations, and bumps the Jasmine
  per-test timeout (`timeoutInterval`) to 15 minutes.

### L2 scenarios

- `initial-render` -- mount `JsonTreeComponent` with a fresh fixture,
  run `detectChanges()` + double-rAF, and time the lot. Runs at every
  enabled fixture size (10K by default; 100K/1M opt-in).
- `scroll-after-expand` -- initial-render, then call the component's
  `expandAll()`, then drive 7 programmatic `scrollTop` steps through
  the `.tree-body` container (each followed by a double-rAF). The
  emitted `wallNs` covers the entire post-expand scroll session, not
  the scroll alone; diff comparisons are still valid because every
  iteration runs the same fixed sequence. **10K only** in L2 --
  mat-tree is not virtualized in v1, so 100K/1M scroll would OOM
  Karma. L3's `scroll-after-expand.spec.ts` runs the larger sizes in
  a real browser.

Default fixture matrix: deep25 + wide-aoo at 10K. Set
`window.__perfL2Force100K = true` (or `?force100k=1`) to also bench
at 100K, and `window.__perfL2Force1M = true` (or `?force1m=1`) to add
1M. Each 100K iter is ~50s; the 1M iter is multiple minutes. Karma's
watchdog timeouts (`browserNoActivityTimeout`,
`browserDisconnectTimeout`) are likewise bumped to 15 minutes so
opt-in runs have room.

The L2 spec writes rows to `console.log` with the sentinel
`@@PERF_L2@@<json>@@END@@`; `scripts/perf/run-l2.mjs` harvests those
into `perf-results/<utc>/layer-2.jsonl`. If zero rows are captured,
`run-l2.mjs` exits non-zero unless `PERF_ALLOW_EMPTY=1` is set
(parity with `run-bench.mjs`).

L2 is **never** in `verify:fast` / `npm test`. The
`scripts/perf/check-perf-ts-excluded.mjs` script asserts
`tsconfig.spec.json` excludes `src/**/*.perf.ts`; it runs as a
prestep of `perf:l2`.

## Layer 3: Playwright + CDP flame-graph

Three scenarios under `perf/browser/scenarios/`:

1. `paste-large.spec.ts` -- programmatic Monaco `setValue` of 10K /
   100K / 1M wide-aoo JSON; waits for first tree row.
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
`page.addInitScript` BEFORE the SPA loads. After
`bootstrapApplication` resolves, `src/main.ts` checks for the shim
and, if present, calls `LoggerService.__attachPerfHarnessForTesting`
with it. This is the only path that ever attaches a perf sink; in
normal production (no shim) the sink stays `null` and the harness
seam is a no-op. We never add new DOM markers; existing telemetry
events (`paste.handle`, `paste.handle.editor`, `monaco.loaded`)
carry the relevant timing and are read back via the harness.

## Perf targets

`perf-targets.json` records *operationalizable* NFR ceilings (not soft
regressions). `perf:diff` enforces these ceilings on top of the baseline
delta check: any current-run row whose value strictly exceeds a configured
`ceiling_ms` adds to the non-zero exit count.

The file is schema-validated on every read (`perf-targets.schema.json`,
JSON Schema draft-07). `schemaVersion: 1` is mandatory; readers fail loud
on mismatch.

### NFR-anchor gap (v1)

The only enforced row in v1 is `3.paste-large.wide-aoo.1m` with a
500 ms ceiling on `longestTaskMsMedian`. This is a **v1 stress check**
on the 24 MB synthetic wide-aoo fixture; it does **not** directly anchor
the DESIGN_SPEC NFR #1 ("open a 5 MB JSON file without freezing").

F-2 (filed as a follow-up issue) tracks adding the NFR-faithful ~5 MB
fixture and a matching ceiling so the 5 MB no-freeze NFR is testable
directly. Until then, the 1M row exercises the same paste/render stress
path at a larger size and acts as a coarse proxy.

### Missing-row contract (warn-only)

If `perf-targets.json` references a row the current run did not capture
(e.g., the contributor ran `perf:l1` only and skipped `perf:l3`),
`perf:diff` prints a `WARN: perf-targets row "<key>" has no current-run
data; skipping` line and proceeds with exit 0 for that row. SK-008 / F-3
may revisit this contract once we have stable baselines, to decide
whether CI should hard-fail instead.

### Other deferred NFRs

Other DESIGN_SPEC NFRs (TTI<2s on 4G; api/ p95<200ms) are deferred to
follow-up issues; they require CI infra (4G throttling, api-side load
testing) not in scope for v1.

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
  timeouts. The L2 spec gates 100K behind `?force100k=1` (the
  Karma config sets a 15-min watchdog so the opt-in still works).
  1M is gated similarly behind `?force1m=1`.
- **NFR-faithful ~5 MB fixture deferred**: the 1M synthetic wide-aoo
  case exercises the same paste/render stress path, while F-2 tracks a
  fixture that maps directly to DESIGN_SPEC NFR #1.

See `plan.md` -> "Out of scope" in the session for the full
follow-up issue list.
