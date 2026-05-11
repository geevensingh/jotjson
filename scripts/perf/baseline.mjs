// Snapshots the latest `perf-results/<utc>/layer-{1,2,3}.jsonl` run
// into the per-machine baseline at `perf-baselines/<PERF_MACHINE>.json`.
//
// Invoked as:
//   npm run perf:baseline
//
// File-format contract (also documented in docs/perf.md and
// perf-baselines/.gitkeep):
//
//   {
//     "machineLabel": "<PERF_MACHINE>",
//     "lastUpdatedUtc": "<iso>",
//     "codeShaAtBaseline": "<short sha>",
//     "rows": {
//       "<layer>.<scenario>.<fixture>.<size>": {
//         "wallNsMedian": number,
//         "wallNsIqrLow": number,
//         "wallNsIqrHigh": number,
//         "iters": number,
//         "approxNodes": number
//       },
//       ...
//     }
//   }
//
// `perf:diff` reads the same file. Architect r2 tech-debt #2: ONE
// canonical baseline shape, no parallel `_reference-range.json`.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESULTS_DIR = join(REPO_ROOT, 'perf-results');
const BASELINES_DIR = join(REPO_ROOT, 'perf-baselines');

/**
 * @typedef {Object} JsonlRow
 * @property {number} layer
 * @property {string} scenario
 * @property {string} fixture
 * @property {string} size
 * @property {number} approxNodes
 * @property {number} iters
 * @property {number} wallNsMedian
 * @property {number} wallNsIqrLow
 * @property {number} wallNsIqrHigh
 * @property {string} codeSha
 */

/**
 * @typedef {Object} BaselineEntry
 * @property {number} wallNsMedian
 * @property {number} wallNsIqrLow
 * @property {number} wallNsIqrHigh
 * @property {number} iters
 * @property {number} approxNodes
 */

/**
 * @typedef {Object} BaselineFile
 * @property {string} machineLabel
 * @property {string} lastUpdatedUtc
 * @property {string} codeShaAtBaseline
 * @property {Record<string, BaselineEntry>} rows
 */

/**
 * Pure helper: collapses a list of JSONL rows into the baseline-file rows map.
 *
 * @param {JsonlRow[]} rows
 * @returns {Record<string, BaselineEntry>}
 */
export function rowsToBaselineEntries(rows) {
  /** @type {Record<string, BaselineEntry>} */
  const out = {};
  for (const row of rows) {
    const key = `${row.layer}.${row.scenario}.${row.fixture}.${row.size}`;
    out[key] = {
      wallNsMedian: row.wallNsMedian,
      wallNsIqrLow: row.wallNsIqrLow,
      wallNsIqrHigh: row.wallNsIqrHigh,
      iters: row.iters,
      approxNodes: row.approxNodes,
    };
  }
  return out;
}

/**
 * @param {string} text
 * @returns {JsonlRow[]}
 */
export function parseJsonl(text) {
  /** @type {JsonlRow[]} */
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    out.push(/** @type {JsonlRow} */ (JSON.parse(trimmed)));
  }
  return out;
}

/**
 * Returns the latest results directory (UTC-stamped) or throws.
 *
 * @param {string} [resultsDir]
 * @returns {string}
 */
export function findLatestResultsDir(resultsDir = RESULTS_DIR) {
  if (!existsSync(resultsDir)) {
    throw new Error(`perf-results/ does not exist. Run \`npm run perf:l1\` (and l2/l3) first.`);
  }
  const entries = readdirSync(resultsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (entries.length === 0) {
    throw new Error(`perf-results/ contains no run directories. Run \`npm run perf:l1\` first.`);
  }
  const last = entries[entries.length - 1];
  return join(resultsDir, /** @type {string} */ (last));
}

/**
 * Reads any `layer-*.jsonl` files in `runDir` and returns the union of rows.
 *
 * @param {string} runDir
 * @returns {JsonlRow[]}
 */
export function readRunRows(runDir) {
  /** @type {JsonlRow[]} */
  const rows = [];
  for (const entry of readdirSync(runDir)) {
    if (!entry.startsWith('layer-') || !entry.endsWith('.jsonl')) continue;
    const text = readFileSync(join(runDir, entry), 'utf8');
    for (const row of parseJsonl(text)) rows.push(row);
  }
  return rows;
}

/**
 * Snapshot the latest run to the per-machine baseline file.
 *
 * @param {{ machineLabel: string, resultsDir?: string, baselinesDir?: string }} opts
 * @returns {{ baselinePath: string, rowCount: number, lastUpdatedUtc: string }}
 */
export function snapshotBaseline({ machineLabel, resultsDir, baselinesDir }) {
  if (!machineLabel) {
    throw new Error(
      'PERF_MACHINE is required. See docs/perf.md or run `node scripts/perf/machine-label.mjs --suggest`.',
    );
  }
  const usedResultsDir = resultsDir ?? RESULTS_DIR;
  const usedBaselinesDir = baselinesDir ?? BASELINES_DIR;
  const runDir = findLatestResultsDir(usedResultsDir);
  const rows = readRunRows(runDir);
  if (rows.length === 0) {
    throw new Error(`No rows found under ${runDir}. Did the bench fail before writing?`);
  }
  const codeSha = rows[0]?.codeSha ?? 'unknown';
  /** @type {BaselineFile} */
  const baseline = {
    machineLabel,
    lastUpdatedUtc: new Date().toISOString(),
    codeShaAtBaseline: codeSha,
    rows: rowsToBaselineEntries(rows),
  };
  mkdirSync(usedBaselinesDir, { recursive: true });
  const baselinePath = join(usedBaselinesDir, `${machineLabel}.json`);
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  return {
    baselinePath,
    rowCount: rows.length,
    lastUpdatedUtc: baseline.lastUpdatedUtc,
  };
}

async function main() {
  const machineLabel = process.env['PERF_MACHINE'];
  if (!machineLabel) {
    process.stderr.write(
      'perf:baseline FAILED\nPERF_MACHINE is unset. See docs/perf.md or run:\n  node scripts/perf/machine-label.mjs --suggest\n',
    );
    process.exit(1);
  }
  const { baselinePath, rowCount, lastUpdatedUtc } = snapshotBaseline({ machineLabel });
  process.stdout.write(
    `perf:baseline  wrote ${rowCount} rows to ${baselinePath} (${lastUpdatedUtc})\n`,
  );
}

const invokedFromCli = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedFromCli) {
  main().catch((cause) => {
    process.stderr.write(`perf:baseline FAILED\n${/** @type {Error} */ (cause).message}\n`);
    process.exit(1);
  });
}
