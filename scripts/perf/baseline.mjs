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
//     "schemaVersion": 1,
//     "machineLabel": "<PERF_MACHINE>",
//     "lastUpdatedUtc": "<iso>",
//     "codeShaAtBaseline": "<short sha>",
//     "rows": {
//       "<layer>.<scenario>.<fixture>.<size>": {
//         "wallNsMedian": number,
//         "wallNsIqrLow": number,
//         "wallNsIqrHigh": number,
//         "iters": number,
//         "approxNodes": number,
//         "heapRetainedDeltaMedian"?: number,
//         "heapWorkingSetMedian"?: number,
//         "longestTaskMsMedian"?: number
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
import { suggestMachineLabel } from './machine-label.mjs';
import { perfRowKey } from './row-key.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESULTS_DIR = join(REPO_ROOT, 'perf-results');
const BASELINES_DIR = join(REPO_ROOT, 'perf-baselines');

export const BASELINE_SCHEMA_VERSION = 1;

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
 * @property {number} [heapRetainedDeltaMedian]
 * @property {number} [heapWorkingSetMedian]
 * @property {number} [heapWorkingSetMax]
 * @property {number} [longestTaskMsMedian]
 * @property {string} codeSha
 */

/**
 * @typedef {Object} BaselineEntry
 * @property {number} wallNsMedian
 * @property {number} wallNsIqrLow
 * @property {number} wallNsIqrHigh
 * @property {number} iters
 * @property {number} approxNodes
 * @property {number} [heapRetainedDeltaMedian]
 * @property {number} [heapWorkingSetMedian]
 * @property {number} [heapWorkingSetMax]
 * @property {number} [longestTaskMsMedian]
 */

/**
 * @typedef {Object} BaselineFile
 * @property {number} schemaVersion
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
    const key = perfRowKey(row);
    /** @type {BaselineEntry} */
    const entry = {
      wallNsMedian: row.wallNsMedian,
      wallNsIqrLow: row.wallNsIqrLow,
      wallNsIqrHigh: row.wallNsIqrHigh,
      iters: row.iters,
      approxNodes: row.approxNodes,
    };
    if (typeof row.heapRetainedDeltaMedian === 'number') {
      entry.heapRetainedDeltaMedian = row.heapRetainedDeltaMedian;
    }
    if (typeof row.heapWorkingSetMedian === 'number') {
      entry.heapWorkingSetMedian = row.heapWorkingSetMedian;
    }
    if (typeof row.heapWorkingSetMax === 'number') {
      entry.heapWorkingSetMax = row.heapWorkingSetMax;
    }
    if (typeof row.longestTaskMsMedian === 'number') {
      entry.longestTaskMsMedian = row.longestTaskMsMedian;
    }
    out[key] = entry;
  }
  return out;
}

/**
 * Validates a parsed baseline file against the schemaVersion contract.
 * Throws with a clear message on mismatch or missing field.
 *
 * @param {unknown} parsed
 * @param {string} sourcePath
 * @returns {BaselineFile}
 */
export function assertBaselineSchema(parsed, sourcePath) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Baseline at ${sourcePath} is not an object`);
  }
  const obj = /** @type {Record<string, unknown>} */ (parsed);
  if (typeof obj['schemaVersion'] !== 'number') {
    throw new Error(
      `Baseline at ${sourcePath} is missing "schemaVersion". Expected ${BASELINE_SCHEMA_VERSION}. Recapture via \`npm run perf:baseline\`.`,
    );
  }
  if (obj['schemaVersion'] !== BASELINE_SCHEMA_VERSION) {
    throw new Error(
      `Baseline at ${sourcePath} has schemaVersion=${String(obj['schemaVersion'])}, expected ${BASELINE_SCHEMA_VERSION}. Recapture via \`npm run perf:baseline\`.`,
    );
  }
  return /** @type {BaselineFile} */ (parsed);
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
      'snapshotBaseline requires a machineLabel. Pass it explicitly or set PERF_MACHINE; otherwise the CLI falls back to suggestMachineLabel().',
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
    schemaVersion: BASELINE_SCHEMA_VERSION,
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
  const machineLabel = process.env['PERF_MACHINE'] ?? suggestMachineLabel();
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
