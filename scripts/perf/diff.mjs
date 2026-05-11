// Compares the latest `perf-results/<utc>/layer-*.jsonl` run against
// the per-machine baseline at `perf-baselines/<PERF_MACHINE>.json`,
// emitting an ASCII table of deltas and exiting non-zero if any row
// is flagged.
//
// Invoked as:
//   npm run perf:diff
//
// Flag rule:
//   |delta_median| > max(thresholdPct, 2 * pooledStddev)
//
// where `thresholdPct` is 15% for layers 1 and 2, 20% for layer 3, per
// the plan. The pooled-stddev term cannot be evaluated without a
// stddev field in the baseline (the baseline records IQR, not stddev),
// so v1 of `diff.mjs` uses the percentage threshold alone and treats
// the pooled-stddev term as informational. This is documented in
// docs/perf.md as a v1 simplification.
//
// Output: top-K largest deltas (K = 20) by absolute percent change.
// Non-zero exit on flagged rows so the script is gateable in a
// follow-up CI step.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLatestResultsDir, readRunRows } from './baseline.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINES_DIR = join(REPO_ROOT, 'perf-baselines');
const TOP_K = 20;

/**
 * @typedef {Object} DiffRow
 * @property {string} key
 * @property {number} layer
 * @property {number} baselineMedianNs
 * @property {number} currentMedianNs
 * @property {number} deltaPct
 * @property {boolean} flagged
 */

function thresholdPctFor(layer) {
  return layer === 3 ? 20 : 15;
}

/**
 * Computes diff rows from a baseline file and a list of current rows.
 *
 * @param {import('./baseline.mjs').BaselineFile} baseline
 * @param {import('./baseline.mjs').JsonlRow[]} currentRows
 * @returns {DiffRow[]}
 */
export function computeDiffs(baseline, currentRows) {
  /** @type {DiffRow[]} */
  const out = [];
  for (const row of currentRows) {
    const key = `${row.layer}.${row.scenario}.${row.fixture}.${row.size}`;
    const baselineEntry = baseline.rows[key];
    if (!baselineEntry) continue;
    const deltaPct =
      baselineEntry.wallNsMedian === 0
        ? 0
        : ((row.wallNsMedian - baselineEntry.wallNsMedian) / baselineEntry.wallNsMedian) * 100;
    const threshold = thresholdPctFor(row.layer);
    out.push({
      key,
      layer: row.layer,
      baselineMedianNs: baselineEntry.wallNsMedian,
      currentMedianNs: row.wallNsMedian,
      deltaPct,
      flagged: Math.abs(deltaPct) > threshold,
    });
  }
  return out;
}

/**
 * Formats nanoseconds as a compact human string (ASCII only).
 *
 * @param {number} ns
 * @returns {string}
 */
export function formatNs(ns) {
  if (ns < 1_000) return `${ns.toFixed(0)}ns`;
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(1)}us`;
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(1)}ms`;
  return `${(ns / 1_000_000_000).toFixed(2)}s`;
}

/**
 * @param {DiffRow[]} diffs
 * @returns {string}
 */
export function formatDiffTable(diffs) {
  if (diffs.length === 0) {
    return '(no overlapping (key) rows between current run and baseline)\n';
  }
  const sorted = [...diffs].sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
  const top = sorted.slice(0, TOP_K);
  const header = ['flag', 'L', 'key', 'baseline', 'current', 'delta%'];
  const rows = top.map((diff) => [
    diff.flagged ? '[!]' : '   ',
    String(diff.layer),
    diff.key,
    formatNs(diff.baselineMedianNs),
    formatNs(diff.currentMedianNs),
    `${diff.deltaPct >= 0 ? '+' : ''}${diff.deltaPct.toFixed(1)}%`,
  ]);
  const widths = header.map((heading, i) =>
    Math.max(heading.length, ...rows.map((row) => row[i].length)),
  );
  const fmt = (row) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  const lines = [fmt(header), fmt(widths.map((w) => '-'.repeat(w)))];
  for (const row of rows) lines.push(fmt(row));
  return lines.join('\n') + '\n';
}

/**
 * @param {{ machineLabel: string, resultsDir?: string, baselinesDir?: string }} opts
 * @returns {{ diffs: DiffRow[], output: string, flaggedCount: number, baselinePath: string }}
 */
export function diffLatestRun({ machineLabel, resultsDir, baselinesDir }) {
  const usedBaselinesDir = baselinesDir ?? BASELINES_DIR;
  const baselinePath = join(usedBaselinesDir, `${machineLabel}.json`);
  if (!existsSync(baselinePath)) {
    throw new Error(
      `No baseline at ${baselinePath}. Run \`npm run perf:baseline\` after a clean run, then re-bench.`,
    );
  }
  const baseline = /** @type {import('./baseline.mjs').BaselineFile} */ (
    JSON.parse(readFileSync(baselinePath, 'utf8'))
  );
  const runDir = findLatestResultsDir(resultsDir);
  const currentRows = readRunRows(runDir);
  const diffs = computeDiffs(baseline, currentRows);
  const output = formatDiffTable(diffs);
  const flaggedCount = diffs.filter((diff) => diff.flagged).length;
  return { diffs, output, flaggedCount, baselinePath };
}

async function main() {
  const machineLabel = process.env['PERF_MACHINE'];
  if (!machineLabel) {
    process.stderr.write(
      'perf:diff FAILED\nPERF_MACHINE is unset. See docs/perf.md or run:\n  node scripts/perf/machine-label.mjs --suggest\n',
    );
    process.exit(1);
  }
  const { output, flaggedCount, baselinePath } = diffLatestRun({ machineLabel });
  process.stdout.write(`perf:diff  comparing latest run vs ${baselinePath}\n`);
  process.stdout.write(output);
  if (flaggedCount > 0) {
    process.stderr.write(`perf:diff  ${flaggedCount} flagged row(s) exceeded threshold\n`);
    process.exit(2);
  }
  process.stdout.write('perf:diff  OK (no flagged rows)\n');
}

const invokedFromCli = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedFromCli) {
  main().catch((cause) => {
    process.stderr.write(`perf:diff FAILED\n${/** @type {Error} */ (cause).message}\n`);
    process.exit(1);
  });
}
