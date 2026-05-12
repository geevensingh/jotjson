// Node bench for `parse(): ParseResult` -- the extracted pure function
// from `JsonParserService`. Imported by `scripts/perf/run-bench.mjs`
// after compilation by `tsc -p tsconfig.perf.json`.
//
// File layout:
//   - Imports use `.js` extensions so the emit loads under Node ESM
//     unchanged (the dist-perf/package.json sets type=module).
//   - `selfTest()` runs ONE tiny iteration; called by build.mjs to
//     catch import errors before a 5-minute bench run starts.
//   - `run()` is the bench harness entrypoint, invoked by
//     run-bench.mjs with a `BenchContext`.
//
// Mechanics (matches the perf plan):
//   - 3 warmup iterations, N=20 timed iterations per fixture.
//   - Per-iteration allocation: `gc()` before + after each iter,
//     report deltas via `process.memoryUsage().heapUsed`.
//   - Two heap metrics per iter:
//       heapWorkingSet     = heapAfterWork - heapBefore (peak working set)
//       heapRetainedDelta  = heapAfter (post-second-gc) - heapBefore
//   - Output: `{ scenario, fixture, size, run } -> { wallNs, heapRetainedDelta, heapWorkingSet }`
//     for run-bench.mjs to aggregate into median + IQR.

import { parse } from '../../src/app/core/json/parse.js';
import { FIXTURE_CATALOG } from '../fixtures/catalog.js';
import { generate } from '../fixtures/generate.js';

const WARMUP_ITERS = 3;
const TIMED_ITERS = 20;

export interface BenchRow {
  scenario: string;
  fixture: string;
  size: string;
  approxNodes: number;
  bytes: number;
  iters: number;
  wallNsMedian: number;
  wallNsIqrLow: number;
  wallNsIqrHigh: number;
  wallNsStddev: number;
  heapRetainedDeltaMedian: number;
  heapRetainedDeltaIqrLow: number;
  heapRetainedDeltaIqrHigh: number;
  heapWorkingSetMedian: number;
  heapWorkingSetMax: number;
}

function quantile(sortedValues: number[], q: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = (sortedValues.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo]!;
  return sortedValues[lo]! + (sortedValues[hi]! - sortedValues[lo]!) * (idx - lo);
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function requireGc(): () => void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') {
    throw new Error('parse.bench: globalThis.gc is undefined. Run Node with --expose-gc.');
  }
  return gc;
}

/**
 * Runs N timed iterations of `parse(input)` with per-iter alloc
 * bracketing. Returns a single `BenchRow`.
 */
function measure(
  scenario: string,
  fixture: string,
  size: string,
  approxNodes: number,
  input: string,
): BenchRow {
  const gc = requireGc();
  for (let i = 0; i < WARMUP_ITERS; i++) {
    parse(input);
  }
  const wallNs: number[] = [];
  const heapRetainedDelta: number[] = [];
  const heapWorkingSet: number[] = [];
  for (let i = 0; i < TIMED_ITERS; i++) {
    gc();
    const beforeHeap = process.memoryUsage().heapUsed;
    const t0 = process.hrtime.bigint();
    parse(input);
    const t1 = process.hrtime.bigint();
    const afterWorkHeap = process.memoryUsage().heapUsed;
    gc();
    const afterHeap = process.memoryUsage().heapUsed;
    wallNs.push(Number(t1 - t0));
    heapRetainedDelta.push(Math.max(0, afterHeap - beforeHeap));
    heapWorkingSet.push(Math.max(0, afterWorkHeap - beforeHeap));
  }
  const wallSorted = [...wallNs].sort((a, b) => a - b);
  const retainedSorted = [...heapRetainedDelta].sort((a, b) => a - b);
  const workingSorted = [...heapWorkingSet].sort((a, b) => a - b);
  return {
    scenario,
    fixture,
    size,
    approxNodes,
    bytes: input.length,
    iters: TIMED_ITERS,
    wallNsMedian: quantile(wallSorted, 0.5),
    wallNsIqrLow: quantile(wallSorted, 0.25),
    wallNsIqrHigh: quantile(wallSorted, 0.75),
    wallNsStddev: stddev(wallNs),
    heapRetainedDeltaMedian: quantile(retainedSorted, 0.5),
    heapRetainedDeltaIqrLow: quantile(retainedSorted, 0.25),
    heapRetainedDeltaIqrHigh: quantile(retainedSorted, 0.75),
    heapWorkingSetMedian: quantile(workingSorted, 0.5),
    heapWorkingSetMax: workingSorted[workingSorted.length - 1] ?? 0,
  };
}

/**
 * Bench entrypoint. Invoked by `scripts/perf/run-bench.mjs`. Returns
 * one row per catalog fixture.
 */
export async function run(): Promise<BenchRow[]> {
  const rows: BenchRow[] = [];
  for (const entry of FIXTURE_CATALOG) {
    const input = generate({ shape: entry.shape, approxNodes: entry.approxNodes });
    rows.push(measure('parse', entry.shape, entry.size, entry.approxNodes, input));
  }
  return rows;
}

/**
 * Tiny smoke run, executed by `scripts/perf/build.mjs` after compile.
 * Verifies that imports resolve and the parser/generator pair works
 * end-to-end without taking time.
 */
export function selfTest(): void {
  const input = generate({ shape: 'deep25', approxNodes: 100 });
  const result = parse(input);
  if (result.errors.length > 0) {
    throw new Error(
      `parse.bench selfTest: parse() returned ${result.errors.length} error(s) on a generated fixture`,
    );
  }
}
