// Node bench for `buildTree(value, path, counter)` -- the extracted pure
// function from `JsonTreeComponent`. Imported by
// `scripts/perf/run-bench.mjs` after compilation by
// `tsc -p tsconfig.perf.json`.
//
// File mirrors the structure of `parse.bench.ts`. See that file for
// rationale on the .js-extensioned imports, gc bracketing, and the
// build.mjs selfTest discovery contract.

import { buildTree } from '../../src/app/shared/components/json-tree/build-tree.js';
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
    throw new Error('build-tree.bench: globalThis.gc is undefined. Run Node with --expose-gc.');
  }
  return gc;
}

function measure(
  scenario: string,
  fixture: string,
  size: string,
  approxNodes: number,
  value: unknown,
  bytes: number,
): BenchRow {
  const gc = requireGc();
  for (let i = 0; i < WARMUP_ITERS; i++) {
    buildTree(value);
  }
  const wallNs: number[] = [];
  const heapRetainedDelta: number[] = [];
  const heapWorkingSet: number[] = [];
  for (let i = 0; i < TIMED_ITERS; i++) {
    gc();
    const beforeHeap = process.memoryUsage().heapUsed;
    const t0 = process.hrtime.bigint();
    buildTree(value);
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
    bytes,
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

export async function run(): Promise<BenchRow[]> {
  const rows: BenchRow[] = [];
  for (const entry of FIXTURE_CATALOG) {
    const json = generate({ shape: entry.shape, approxNodes: entry.approxNodes });
    const value: unknown = JSON.parse(json);
    rows.push(
      measure(
        'build-tree',
        entry.shape,
        entry.size,
        entry.approxNodes,
        value,
        Buffer.byteLength(json, 'utf8'),
      ),
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
