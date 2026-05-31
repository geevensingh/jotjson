# Perf benches

Local-only, three-layer perf measurement suite for JotJSON. Pre-v1
baseline tooling: every contributor seeds and refreshes their own
per-machine baseline; CI does not yet enforce perf thresholds.

## TL;DR

```bash
# One-time setup: pick your machine label.
node scripts/perf/machine-label.mjs --suggest
# -> e.g., win32-x64-h7c1d05ef (hashed hostname; PII-safe by default)
$env:PERF_MACHINE = "win32-x64-h7c1d05ef"   # PowerShell
# export PERF_MACHINE=win32-x64-h7c1d05ef   # bash

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
the deterministic label produced by `suggestMachineLabel()` (shape:
`<platform>-<arch>-h<8 hex>`, e.g. `win32-x64-h7c1d05ef`). The hex
segment is the first 8 chars of `SHA-256(os.hostname())` so the label
is (a) stable for a given machine, (b) different across machines with
overwhelming probability, and (c) PII-safe -- the hostname itself
never appears in the label, only its hash. Set `PERF_MACHINE`
explicitly when you want a self-documenting filename
(e.g. `win32-x64-team-runner-01`), when you want to share a single
baseline file across machines that should be treated as equivalent, or
when you want to diff against the repo's committed reference
(`PERF_MACHINE=win32-x64-v1-reference`). Print the suggested label any
time with:

```bash
node scripts/perf/machine-label.mjs --suggest
```

Baselines live at `perf-baselines/<label>.json` and are gitignored by
default (each machine's numbers are noise to other machines). The
**v1 reference baseline** for this repo is committed as a single
whitelisted exception in `.gitignore`; see "v1 reference machine"
below.

### Baseline file format

```jsonc
{
  "schemaVersion": 2,
  "machineLabel": "win32-x64-h7c1d05ef",
  "lastUpdatedUtc": "2026-05-12T19:00:00.000Z",
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
    },
    "3.paste-large.wide-aoo.10k": {
      "wallNsMedian": 480000000,
      "wallNsIqrLow": 460000000,
      "wallNsIqrHigh": 510000000,
      "iters": 7,
      "approxNodes": 10000,
      "longestTaskMsMedian": 42,
      "pasteMethod": "setvalue"
    }
    // ... more rows ...
  }
}
```

The `schemaVersion` field is mandatory; readers fail loud on mismatch.
The L3-only `longestTaskMsMedian` field is present on rows captured by
`scripts/perf/run-l3.mjs`. The `pasteMethod` field is present on L3
`paste-large` rows only (added in schemaVersion 2). One canonical shape,
used by both
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

### v1 reference machine

The repository commits one whitelisted baseline at
`perf-baselines/win32-x64-v1-reference.json` as the **v1 reference
baseline**. This is the only `perf-baselines/*.json` file tracked in
git; every other machine's baseline stays gitignored.

Hardware snapshot (the machine that produced the v1 reference baseline):

| Component | Value |
|---|---|
| CPU | AMD EPYC 7763 64-Core Processor |
| Cores | 8 physical, 16 logical |
| RAM | 64 GB |
| OS | Windows 11 Enterprise (10.0.26200) |
| Node | v24.15.0 |
| Chrome | 148.0.7778.96 |
| Machine label | `win32-x64-v1-reference` |

The reference baseline is **CI-dormant**: `npm run perf:all` does not
run in CI today, so the committed numbers are referenced only by local
invocations of `npm run perf:diff`. Expect drift between your local
runs and the reference (different CPU model + thermals + background
load); the +/-15% delta threshold absorbs most of that. F-3 tracks the
CI-enforcement decision.

The reference baseline is regenerated when the v1 hardware ages out or
the schema shifts (next bump after schemaVersion 2). For routine
contributor work, a non-reference contributor:

1. Captures their own local baseline with their own `PERF_MACHINE`.
2. Tracks regressions vs. their own baseline (gitignored, not
   committed).
3. Cross-references the committed reference baseline only to sanity-check
   "is my machine in the same ballpark as the reference."

**v1 reference: L2 default-matrix gap.** As of `codeShaAtBaseline:
3114d56`, the committed reference baseline contains L1 + L3 rows but
no L2 (`2.*`) rows. The previous reference baseline (at
`codeShaAtBaseline: d380114`) carried 3 L2 entries
(`2.scroll-after-expand.deep25.10k`, `2.initial-render.deep25.10k`,
`2.initial-render.wide-aoo.10k`), but those values were captured
against the pre-virtualization mat-tree implementation. Issue #95
(tree virtualization, landed in #236 / commit `d21acbd`) rewrote the
L2 scenario harness to drive `cdk-virtual-scroll-viewport` instead of
the outer wrapper; carrying the pre-virtualization numbers forward
under the post-virtualization SHA would misrepresent the baseline
file's per-row provenance. Fresh L2 captures against `3114d56` (and
forward) are tracked by the L2 baseline reseed follow-up. Until
that lands, an L2 capture has no committed reference to diff against;
`perf:diff` compares only rows the current run AND the baseline both
have, so L2 rows in a current run simply don't contribute to any
ratio (and L2 rows aren't in `perf-targets.json` either, so no ceiling
gate fires for them today).

### Paste mechanism (L3 paste-large)

`paste-large.spec.ts` varies the paste path by fixture size to balance
realism against Chromium's clipboard limits. **v1 ships setvalue-only**
for all sizes (see `pickPasteMethod()` in the spec); the table below
reflects v1 reality, and the `pasteMethod` row field plus the right-most
column document the forward-compat plan for re-enabling keyboard paste
at the smaller sizes.

| Size | Bytes (~) | v1 path | Forward-compat plan |
|---|---|---|---|
| 10K | 240 KB | `monaco.editor.setValue()` | Switch to `Ctrl+V` against pre-loaded clipboard to exercise Monaco's `onPaste` handler + `home.onEditorPaste` end-to-end. |
| 100K | 2.4 MB | `monaco.editor.setValue()` | Same as 10K, contingent on #218 (cross-iter cliff) being resolved. Will require a readback assertion (`navigator.clipboard.readText().length === json.length`) to catch silent truncation. |
| 1M | 24 MB | `monaco.editor.setValue()` | Stays on `setValue()` permanently: 24 MB exceeds Chromium's silent clipboard cap; keyboard paste would truncate. The stress-test path emits no `paste.handle.editor` event. |

Each row carries an additive `pasteMethod: "keyboard" | "setvalue"`
field so `perf:diff` can match like-with-like across runs. `computeDiffs`
treats two rows as comparable only when both have the same `pasteMethod`
value (or both omit it, for the legacy v1 case). The field lives on the
JSONL row + `BaselineEntry`, NOT in the 4-tuple rowKey: the rowKey
convention is `<layer>.<scenario>.<fixture>.<size>` and harness variants
live as optional row fields per the schema convention documented in
`scripts/perf/baseline.mjs`.

If the 100K keyboard tier is ever re-enabled and flakes consistently
on your hardware, see F-5 (#218) for the follow-up plan (options
range from longer timeouts to leaving 100K on `setValue` indefinitely).

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
asserts the wide-aoo 10K + 100K hashes under `npm run test:perf-scripts`
(a dedicated script kept out of `verify:fast` because it auto-runs
`npm run perf:build` -- a ~20s tsc compile -- when `dist-perf/` is
missing). CI runs it as the "Perf script tests" gate alongside the
lint chain.

When you intentionally change the generator:

```bash
$env:PERF_BUILD_SEED_HASHES = "1"
node scripts/perf/build.mjs
# Copy the printed hashes into GENERATOR_GOLDEN_HASHES in build.mjs.
Remove-Item Env:\PERF_BUILD_SEED_HASHES
node scripts/perf/build.mjs    # confirm green
```

## Layer 2: Karma component bench

> **Note:** Layer 2 is the only remaining consumer of Karma+Jasmine in
> the repo. The unit-test suite was migrated to Vitest browser mode
> (issue #47). Issue #417 tracks migrating the perf bench off Karma;
> the GC-exposure / synchronous-iteration constraints documented below
> are why it wasn't included in #47.

`src/app/shared/components/json-tree/json-tree.component.perf.ts` runs
under a perf-only Angular `test` configuration:

- `tsconfig.perf-l2.json` includes `*.perf.ts` and excludes `*.test.ts`.
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

`scroll-after-expand: wide-aoo @ 10k` is additionally gated behind
`window.__perfL2ForceWideAooScroll = true` (or `?forcewideaooscroll=1`).
`expandAll` materializes all 910 sibling nodes at depth 1
synchronously and each iter takes ~12 minutes on the v1 reference
machine; without the gate, default `npm run perf:all` would hit the
15-min Jasmine timeout. `initial-render: wide-aoo @ 10k` and
`scroll-after-expand: deep25 @ 10k` continue to run by default.
Tracked in issue #219; the underlying fix is mat-tree virtualization.

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

1. `paste-large.spec.ts` -- pastes 10K / 100K / 1M wide-aoo JSON into
   the editor and waits for the first tree row. Paste mechanism in v1:
   - **All sizes** use programmatic `monaco.editor.setValue()`. The
     spec is wired for real `Ctrl+V` keyboard paste at 10K + 100K, but
     v1 commits to `setvalue` everywhere pending issue #218: 10K hit
     intermittent `paste.handle.editor` harness-event misses and 100K
     timed out the editor `waitFor` on the v1 reference machine. The
     keyboard helper (`performKeyboardPaste`) is intentionally retained
     in the spec; re-enabling it once #218 lands is a one-line change
     in `pickPasteMethod`.
   - The 24 MB 1M payload also exceeds Chromium's silent clipboard cap,
     so it would stay on the `setvalue` path even after #218.
   - Each row carries a `pasteMethod: "keyboard" | "setvalue"` field.
     v1 baseline rows all read `setvalue`; the field exists so future
     keyboard rows can coexist without changing the rowKey shape. See
     `scripts/perf/baseline.mjs` for the additive-field convention.
2. `expand-all.spec.ts` -- 1M-node fixture, click "Expand all".
3. `scroll-after-expand.spec.ts` -- 1M-node fixture, expand-all, then
   50 wheel events at ~60Hz over the tree pane.

**L3 1m + 100k tiers gated by default**: `paste-large @ 1m`, all
`expand-all` tests, and all `scroll-after-expand` tests skip themselves
unless `PERF_FORCE_1M=1` is set. `paste-large @ 100k` skips itself
unless `PERF_FORCE_100K=1` is set. Each Playwright test has a 10-min
timeout; 1m wide-aoo paths frequently exceed that on the v1 reference
machine, and at 100k the cross-iteration renderer state accumulates
across the 8 `page.goto` -> 100k-render iters until the
`editor.waitFor` post-`goto` exceeds even a 60s timeout. Opt in with
`$env:PERF_FORCE_1M = "1"` / `$env:PERF_FORCE_100K = "1"` (PowerShell)
or `PERF_FORCE_1M=1` / `PERF_FORCE_100K=1` (bash) before invoking
`npm run perf:l3` or `npm run perf:all`. Tracked in issues #217 (1m)
and #218 (100k). The default `paste-large` matrix is 10k only;
`expand-all`, `scroll-after-expand`, and `paste-large @ 100k` produce
no rows by default.

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

### NFR-anchor coverage

The `mixed-d10 @ 380k` fixture in `perf/fixtures/catalog.ts` is the
NFR-anchor fixture: an empirically-tuned ~5 MB UTF-8 minified JSON
with mixed object/array/leaf content and realized depth 10, anchoring
DESIGN_SPEC.md NFR #1 ("open a 5 MB JSON file without freezing").
See `perf/fixtures/generate.ts` `buildMixedD10` for shape details.

Coverage per layer:

- **L1** (`parse` + `build-tree` Node microbenches): ceiling-enforced
  default-on. Adding the catalog entry surfaces the row in
  `1.parse.mixed-d10.380k` and `1.build-tree.mixed-d10.380k` without
  any opt-in.
- **L2** (Karma in-browser benches): opt-in via `?force5mb=1` URL
  query string or `window.__perfL2Force5MB = true`. A 380K-node
  fixture is heavier than the default 100K cap and would risk Karma's
  `browserNoActivityTimeout` watchdog on unattended runs. Both the
  `initial-render` and `scroll-after-expand` paths participate when
  the flag is set.
- **L3** (Playwright + CDP `paste-large`): ceiling-enforced default-on.
  The F-2 v1-reference trial confirmed all 8 page.goto iters (1 warmup +
  7 timed, per the `WARMUP_ITERS` + `TIMED_ITERS` constants in
  `paste-large.spec.ts`) of `paste-large: mixed-d10 @ 380k` complete
  well within the per-test `test.setTimeout(10 * 60 * 1000)` budget.
  The `#218` cross-iter cliff that gates `wide-aoo @ 100k` behind
  `PERF_FORCE_L3_HEAVY=1` does NOT manifest at 5 MB on the v1
  reference, so the NFR row runs every L3 capture.

Status: **L1 default-on; L3 default-on. NFR-anchor coverage: closed.**

### Sentinel ceilings (draft-PR workflow)

`perf-targets.json` may contain `ceiling_ms: -1` placeholders during
the draft-PR phase of a perf-target change. These rows mean "ceiling
to be measured on the v1 reference machine before merge." The
`scripts/perf/check-no-sentinel-ceilings.mjs` lint script (chained
into `npm run lint`) rejects any negative `ceiling_ms`, so a draft
PR cannot merge with sentinels intact. Once measured, ceilings follow
the formula `min(2 * measured median, 500ms)` rounded UP to 50 ms
(500 ms = Web Vitals INP "poor" threshold; the 2x cushion provides
regression headroom).

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
- **L2 `scroll-after-expand: wide-aoo` gated by default**: on a
  910-node depth-1 fan-out, `JsonTreeComponent.expandAll` triggers
  one synchronous CD cycle that materializes every sibling at once,
  taking ~12 minutes per iter on the v1 reference machine. Opt in
  with `?forcewideaooscroll=1` or `window.__perfL2ForceWideAooScroll
  = true`. Tracked in issue #219; the long-term fix is mat-tree
  virtualization or chunked `expandAll`.
- **L3 1m tier gated behind `PERF_FORCE_1M=1`**: `paste-large @ 1m`,
  all `expand-all` tests, and all `scroll-after-expand` tests skip
  themselves by default. The Playwright per-test timeout is 10 min;
  1m wide-aoo `expand-all` ran 10.1 min on the v1 reference machine
  and timed out. The bypass env var lets contributors run the full
  matrix on faster hardware. Tracked in issue #217.
- **L3 heavy tier gated behind `PERF_FORCE_L3_HEAVY=1`** (one-window
  alias: `PERF_FORCE_100K=1`): `paste-large @ 100k` skips itself by
  default. The bench runs 8 iters per fixture (1 warmup + 7 timed)
  with a fresh `page.goto('/')` per iter. At this size the renderer
  accumulates state across iters until the post-`goto` `editor.waitFor`
  exceeds even a 60s timeout (observed at iter 7-8 of 8 on the v1
  reference machine, both keyboard and setvalue paths). The bypass env
  var lets contributors run the heavy tier on faster hardware or for
  one-off centerpiece snapshots. Tracked in issue #218; the long-term
  fix is per-iter fresh-context isolation or CDP
  `HeapProfiler.collectGarbage` between iters. The NFR-anchor
  `paste-large @ mixed-d10/380k` row is NOT subject to this gate ---
  the F-2 v1-reference trial confirmed all iters complete cleanly at
  5 MB (`docs/perf.md` "NFR-anchor coverage").
- **L3 paste path uses `setValue` at every size in v1**: the
  `paste-large.spec.ts` keyboard helper is wired but disabled in
  `pickPasteMethod` -- 10K hit intermittent `paste.handle.editor`
  harness misses and 100K timed out the editor `waitFor` on the v1
  reference machine. The bench measures the post-paste render path
  (model update -> Angular CD -> tree render), not Monaco's
  `onDidPaste`. Tracked in issue #218; re-enabling is a one-line
  change in `pickPasteMethod` once #218 lands.
- **L2 `mixed-d10 @ 380k` opt-in**: the F-2 NFR-anchor fixture is
  ~5 MB / ~380K nodes. At Karma's default settings the
  `initial-render` and `scroll-after-expand` scenarios at this size
  risk the `browserNoActivityTimeout` watchdog. The L2 spec gates
  this fixture behind `?force5mb=1` or
  `window.__perfL2Force5MB = true` (mirrors the existing `?force1m=1`
  pattern). L1 and L3 enforce on this fixture default-on; only L2
  needs the opt-in.

See `plan.md` -> "Out of scope" in the session for the full
follow-up issue list.
