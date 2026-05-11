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
//   - Output: `{ scenario, fixture, size, run } -> { wallNs, bytesAlloc }`
//     for run-bench.mjs to aggregate into median + IQR.

import { parse } from '../../src/app/core/json/parse.js';
import { generate, type FixtureShape } from '../fixtures/generate.js';

const WARMUP_ITERS = 3;
const TIMED_ITERS = 20;

interface FixtureEntry {
  shape: FixtureShape;
  approxNodes: number;
  label: string;
}

const FIXTURE_MATRIX: readonly FixtureEntry[] = [
  { shape: 'deep25', approxNodes: 10_000, label: '10K' },
  { shape: 'deep25', approxNodes: 100_000, label: '100K' },
  { shape: 'deep25', approxNodes: 1_000_000, label: '1M' },
  { shape: 'wide-aoo', approxNodes: 10_000, label: '10K' },
  { shape: 'wide-aoo', approxNodes: 100_000, label: '100K' },
  { shape: 'wide-aoo', approxNodes: 1_000_000, label: '1M' },
];

const FIVE_M_FIXTURES: readonly FixtureEntry[] = [
  { shape: 'deep25', approxNodes: 5_000_000, label: '5M' },
  { shape: 'wide-aoo', approxNodes: 5_000_000, label: '5M' },
];

const MIN_5M_TOTAL_MEM_BYTES = 8 * 1024 * 1024 * 1024;

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
  bytesAllocMedian: number;
  bytesAllocIqrLow: number;
  bytesAllocIqrHigh: number;
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
  label: string,
  approxNodes: number,
  input: string,
): BenchRow {
  const gc = requireGc();
  for (let i = 0; i < WARMUP_ITERS; i++) {
    parse(input);
  }
  const wallNs: number[] = [];
  const bytesAlloc: number[] = [];
  for (let i = 0; i < TIMED_ITERS; i++) {
    gc();
    const beforeHeap = process.memoryUsage().heapUsed;
    const t0 = process.hrtime.bigint();
    parse(input);
    const t1 = process.hrtime.bigint();
    gc();
    const afterHeap = process.memoryUsage().heapUsed;
    wallNs.push(Number(t1 - t0));
    bytesAlloc.push(Math.max(0, afterHeap - beforeHeap));
  }
  const wallSorted = [...wallNs].sort((a, b) => a - b);
  const bytesSorted = [...bytesAlloc].sort((a, b) => a - b);
  return {
    scenario,
    fixture,
    size: label,
    approxNodes,
    bytes: input.length,
    iters: TIMED_ITERS,
    wallNsMedian: quantile(wallSorted, 0.5),
    wallNsIqrLow: quantile(wallSorted, 0.25),
    wallNsIqrHigh: quantile(wallSorted, 0.75),
    wallNsStddev: stddev(wallNs),
    bytesAllocMedian: quantile(bytesSorted, 0.5),
    bytesAllocIqrLow: quantile(bytesSorted, 0.25),
    bytesAllocIqrHigh: quantile(bytesSorted, 0.75),
  };
}

/**
 * Bench entrypoint. Invoked by `scripts/perf/run-bench.mjs`. Returns
 * one row per (fixture, size). 5M-node fixtures are skipped on hosts
 * with < 8 GB total memory unless `PERF_FORCE_5M=1`.
 */
export async function run(): Promise<BenchRow[]> {
  const os = await import('node:os');
  const rows: BenchRow[] = [];
  for (const entry of FIXTURE_MATRIX) {
    const input = generate({ shape: entry.shape, approxNodes: entry.approxNodes });
    rows.push(measure('parse', entry.shape, entry.label, entry.approxNodes, input));
  }
  const force5m = process.env['PERF_FORCE_5M'] === '1';
  if (os.totalmem() >= MIN_5M_TOTAL_MEM_BYTES || force5m) {
    for (const entry of FIVE_M_FIXTURES) {
      const input = generate({ shape: entry.shape, approxNodes: entry.approxNodes });
      rows.push(measure('parse', entry.shape, entry.label, entry.approxNodes, input));
    }
  } else {
    process.stdout.write(
      'parse.bench: skipping 5M-node fixtures (totalmem < 8 GB; set PERF_FORCE_5M=1 to override)\n',
    );
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
