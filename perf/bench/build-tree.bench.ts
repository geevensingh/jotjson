// Node bench for `buildTree(value, path, counter)` -- the extracted pure
// function from `JsonTreeComponent`. Imported by
// `scripts/perf/run-bench.mjs` after compilation by
// `tsc -p tsconfig.perf.json`.
//
// File mirrors the structure of `parse.bench.ts`. See that file for
// rationale on the .js-extensioned imports, gc bracketing, and the
// build.mjs selfTest discovery contract.

import { buildTree } from '../../src/app/shared/components/json-tree/build-tree.js';
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
    throw new Error('build-tree.bench: globalThis.gc is undefined. Run Node with --expose-gc.');
  }
  return gc;
}

function measure(
  scenario: string,
  fixture: string,
  label: string,
  approxNodes: number,
  value: unknown,
  bytes: number,
): BenchRow {
  const gc = requireGc();
  for (let i = 0; i < WARMUP_ITERS; i++) {
    buildTree(value);
  }
  const wallNs: number[] = [];
  const bytesAlloc: number[] = [];
  for (let i = 0; i < TIMED_ITERS; i++) {
    gc();
    const beforeHeap = process.memoryUsage().heapUsed;
    const t0 = process.hrtime.bigint();
    buildTree(value);
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
    bytes,
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

export async function run(): Promise<BenchRow[]> {
  const os = await import('node:os');
  const rows: BenchRow[] = [];
  for (const entry of FIXTURE_MATRIX) {
    const json = generate({ shape: entry.shape, approxNodes: entry.approxNodes });
    const value: unknown = JSON.parse(json);
    rows.push(
      measure('build-tree', entry.shape, entry.label, entry.approxNodes, value, json.length),
    );
  }
  const force5m = process.env['PERF_FORCE_5M'] === '1';
  if (os.totalmem() >= MIN_5M_TOTAL_MEM_BYTES || force5m) {
    for (const entry of FIVE_M_FIXTURES) {
      const json = generate({ shape: entry.shape, approxNodes: entry.approxNodes });
      const value: unknown = JSON.parse(json);
      rows.push(
        measure('build-tree', entry.shape, entry.label, entry.approxNodes, value, json.length),
      );
    }
  } else {
    process.stdout.write(
      'build-tree.bench: skipping 5M-node fixtures (totalmem < 8 GB; set PERF_FORCE_5M=1 to override)\n',
    );
  }
  return rows;
}

export function selfTest(): void {
  const json = generate({ shape: 'wide-aoo', approxNodes: 100 });
  const value: unknown = JSON.parse(json);
  const result = buildTree(value);
  if (!result.root) {
    throw new Error('build-tree.bench selfTest: buildTree() did not return a root');
  }
}
