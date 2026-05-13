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
import { assertBaselineSchema, findLatestResultsDir, readRunRows } from './baseline.mjs';
import { suggestMachineLabel } from './machine-label.mjs';
import { readPerfTargets } from './perf-targets.mjs';
import { perfRowKey } from './row-key.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINES_DIR = join(REPO_ROOT, 'perf-baselines');
const PERF_TARGETS_PATH = join(REPO_ROOT, 'perf-targets.json');
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

/**
 * @typedef {Object} PasteMethodMismatch
 * @property {string} key
 * @property {('keyboard'|'setvalue'|undefined)} currentPasteMethod
 * @property {('keyboard'|'setvalue'|undefined)} baselinePasteMethod
 */

function thresholdPctFor(layer) {
  return layer === 3 ? 20 : 15;
}

/**
 * Finds rows whose key matches a baseline entry but whose `pasteMethod`
 * disagrees. `computeDiffs` silently drops these rows so it never
 * compares keyboard-vs-setvalue measurements as if they were the same
 * row; that silence can mask harness changes (e.g. an accidental
 * `pickPasteMethod` tweak that wipes out an entire L3 paste-large
 * stratum from the diff). This function surfaces the dropped rows so
 * the CLI can print explicit WARN lines.
 *
 * Conservative semantics: a mismatch is informational only -- it does
 * NOT flag the row as a regression and does NOT change `perf:diff`'s
 * exit code. Mirrors the missing-row WARN style used by
 * `checkAgainstTargets`.
 *
 * @param {import('./baseline.mjs').BaselineFile} baseline
 * @param {import('./baseline.mjs').JsonlRow[]} currentRows
 * @returns {PasteMethodMismatch[]}
 */
export function findPasteMethodMismatches(baseline, currentRows) {
  /** @type {PasteMethodMismatch[]} */
  const out = [];
  for (const row of currentRows) {
    const key = perfRowKey(row);
    const baselineEntry = baseline.rows[key];
    if (!baselineEntry) continue;
    if (row.pasteMethod !== baselineEntry.pasteMethod) {
      out.push({
        key,
        currentPasteMethod: row.pasteMethod,
        baselinePasteMethod: baselineEntry.pasteMethod,
      });
    }
  }
  return out;
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
    const key = perfRowKey(row);
    const baselineEntry = baseline.rows[key];
    if (!baselineEntry) continue;
    // Harness-variant matching: drop the row when the current run and
    // baseline differ on `pasteMethod` (both must be the same value,
    // or both must be omitted for the legacy v1 case). Conservative:
    // a dropped row is not flagged as a regression -- it just doesn't
    // appear in the diff. Per the convention documented in baseline.mjs.
    if (row.pasteMethod !== baselineEntry.pasteMethod) continue;
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
 * Checks current-run rows against the perf-targets.json ceilings.
 *
 * Contract:
 * - Each target row references a perfRowKey + metric. If the current
 *   run has no row for that key, emit a `WARN:` message and skip
 *   (no flag). SK-008 may revisit this once baselines are stable.
 * - If the row exists but the named metric is missing or non-numeric,
 *   warn and skip.
 * - Otherwise compare `metric_value` against `ceiling_ms`. Strictly
 *   greater is a flag; equal-or-less is a pass. `longestTaskMsMedian`
 *   is already in milliseconds, matching `ceiling_ms` directly.
 *
 * @param {import('./baseline.mjs').JsonlRow[]} currentRows
 * @param {import('./perf-targets.mjs').PerfTargetsFile} targets
 * @param {(row: import('./baseline.mjs').JsonlRow) => string} [rowKeyFn]
 * @returns {{ flaggedCount: number, messages: string[] }}
 */
export function checkAgainstTargets(currentRows, targets, rowKeyFn = perfRowKey) {
  const byKey = new Map(currentRows.map((row) => [rowKeyFn(row), row]));
  /** @type {string[]} */
  const messages = [];
  let flaggedCount = 0;
  for (const [targetKey, metricMap] of Object.entries(targets.rows)) {
    const row = byKey.get(targetKey);
    if (!row) {
      messages.push(`WARN: perf-targets row "${targetKey}" has no current-run data; skipping`);
      continue;
    }
    for (const [metric, spec] of Object.entries(metricMap)) {
      const rawValue = /** @type {Record<string, unknown>} */ (row)[metric];
      if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
        messages.push(
          `WARN: perf-targets row "${targetKey}" metric "${metric}" has no numeric value in current run; skipping`,
        );
        continue;
      }
      if (rawValue > spec.ceiling_ms) {
        flaggedCount += 1;
        messages.push(
          `[!] perf-targets row "${targetKey}" metric "${metric}" = ${rawValue.toFixed(1)} ms exceeds ceiling ${spec.ceiling_ms} ms (${spec.reason})`,
        );
      }
    }
  }
  return { flaggedCount, messages };
}

/**
 * @param {{ machineLabel: string, resultsDir?: string, baselinesDir?: string, targetsPath?: string }} opts
 * @returns {{ diffs: DiffRow[], output: string, flaggedCount: number, targetFlaggedCount: number, targetMessages: string[], methodMismatches: PasteMethodMismatch[], baselinePath: string, targetsPath: string }}
 */
export function diffLatestRun({ machineLabel, resultsDir, baselinesDir, targetsPath }) {
  const usedBaselinesDir = baselinesDir ?? BASELINES_DIR;
  const usedTargetsPath = targetsPath ?? PERF_TARGETS_PATH;
  const baselinePath = join(usedBaselinesDir, `${machineLabel}.json`);
  if (!existsSync(baselinePath)) {
    throw new Error(
      `No baseline at ${baselinePath}. Run \`npm run perf:baseline\` after a clean run, then re-bench.`,
    );
  }
  const baseline = assertBaselineSchema(
    JSON.parse(readFileSync(baselinePath, 'utf8')),
    baselinePath,
  );
  const runDir = findLatestResultsDir(resultsDir);
  const currentRows = readRunRows(runDir);
  const diffs = computeDiffs(baseline, currentRows);
  const methodMismatches = findPasteMethodMismatches(baseline, currentRows);
  const output = formatDiffTable(diffs);
  const flaggedCount = diffs.filter((diff) => diff.flagged).length;
  const targets = readPerfTargets(usedTargetsPath);
  const { flaggedCount: targetFlaggedCount, messages: targetMessages } = checkAgainstTargets(
    currentRows,
    targets,
  );
  return {
    diffs,
    output,
    flaggedCount,
    targetFlaggedCount,
    targetMessages,
    methodMismatches,
    baselinePath,
    targetsPath: usedTargetsPath,
  };
}

async function main() {
  const machineLabel = process.env['PERF_MACHINE'] ?? suggestMachineLabel();
  const {
    output,
    flaggedCount,
    targetFlaggedCount,
    targetMessages,
    methodMismatches,
    baselinePath,
    targetsPath,
  } = diffLatestRun({ machineLabel });
  process.stdout.write(`perf:diff  comparing latest run vs ${baselinePath}\n`);
  process.stdout.write(output);
  if (methodMismatches.length > 0) {
    process.stdout.write(
      `perf:diff  ${methodMismatches.length} row(s) dropped from diff due to pasteMethod mismatch (harness change?):\n`,
    );
    for (const mm of methodMismatches) {
      process.stdout.write(
        `WARN: row "${mm.key}" dropped: current pasteMethod=${JSON.stringify(mm.currentPasteMethod)}, baseline pasteMethod=${JSON.stringify(mm.baselinePasteMethod)}\n`,
      );
    }
  }
  if (targetMessages.length > 0) {
    process.stdout.write(`perf:diff  checking perf-targets at ${targetsPath}\n`);
    for (const msg of targetMessages) {
      process.stdout.write(`${msg}\n`);
    }
  }
  const totalFlagged = flaggedCount + targetFlaggedCount;
  if (totalFlagged > 0) {
    if (flaggedCount > 0) {
      process.stderr.write(`perf:diff  ${flaggedCount} flagged row(s) exceeded threshold\n`);
    }
    if (targetFlaggedCount > 0) {
      process.stderr.write(
        `perf:diff  ${targetFlaggedCount} perf-targets row(s) exceeded ceiling\n`,
      );
    }
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
