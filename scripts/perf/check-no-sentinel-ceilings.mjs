// Asserts that `perf-targets.json` does not contain any sentinel
// placeholder ceilings (i.e., negative `ceiling_ms` values). The
// schema allows negative values so that draft PRs can land with
// `ceiling_ms: -1` sentinels under a `reason: "TODO(F-2): replace
// with measured ceiling"` placeholder; this lint then blocks the PR
// from merging until the sentinels are replaced with measured values
// (typically captured on the v1 reference machine and computed via
// the §7-D5 formula: `min(2 * measured median, 500ms)` rounded up to
// 50 ms).
//
// `perf-targets.json` is plain JSON (no comments / trailing commas
// at root level for `rows`; `_comment` is a top-level string field
// instead). Parse with `JSON.parse`.
//
// Per AGENTS.md s7 #1 the script is wired into `npm run lint` via
// `scripts/check-prod-patterns.mjs`-style chaining so a sentinel
// cannot land on `main`.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @typedef {{ ceiling_ms: number, reason: string }} MetricEntry
 * @typedef {{ [metric: string]: MetricEntry }} RowEntry
 * @typedef {{ schemaVersion: number, rows: { [rowKey: string]: RowEntry } }} PerfTargets
 */

/**
 * @param {PerfTargets} doc
 * @returns {Array<{ rowKey: string, metric: string, ceiling_ms: number, reason: string }>}
 */
export function findSentinelCeilings(doc) {
  /** @type {Array<{ rowKey: string, metric: string, ceiling_ms: number, reason: string }>} */
  const offenders = [];
  if (!doc || typeof doc !== 'object' || !doc.rows || typeof doc.rows !== 'object') {
    return offenders;
  }
  for (const [rowKey, row] of Object.entries(doc.rows)) {
    if (!row || typeof row !== 'object') continue;
    for (const [metric, entry] of Object.entries(row)) {
      if (!entry || typeof entry !== 'object') continue;
      const value = /** @type {{ ceiling_ms?: unknown, reason?: unknown }} */ (entry).ceiling_ms;
      const reason = /** @type {{ ceiling_ms?: unknown, reason?: unknown }} */ (entry).reason;
      if (typeof value === 'number' && value < 0) {
        offenders.push({
          rowKey,
          metric,
          ceiling_ms: value,
          reason: typeof reason === 'string' ? reason : '',
        });
      }
    }
  }
  return offenders;
}

async function main() {
  const targetsPath = join(REPO_ROOT, 'perf-targets.json');
  const text = readFileSync(targetsPath, 'utf8');
  /** @type {PerfTargets} */
  const doc = JSON.parse(text);
  const offenders = findSentinelCeilings(doc);
  if (offenders.length > 0) {
    process.stderr.write(
      `check-no-sentinel-ceilings FAILED\n` +
        `${targetsPath} contains ${offenders.length} sentinel ceiling(s):\n` +
        offenders
          .map(
            (offender) =>
              `  - rows.${offender.rowKey}.${offender.metric}: ceiling_ms=${offender.ceiling_ms} ` +
              `(reason: ${offender.reason || '<missing>'})`,
          )
          .join('\n') +
        '\n' +
        'Sentinel ceilings (ceiling_ms < 0) must be replaced with measured values before merge.\n' +
        'Capture on the v1 reference machine via `npm run perf:all` then compute ceilings as\n' +
        '`min(2 * measured median, 500ms)` rounded UP to 50 ms (AGENTS.md s7 / plan D5).\n',
    );
    process.exit(1);
  }
  process.stdout.write('check-no-sentinel-ceilings  OK\n');
}

const invokedFromCli = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedFromCli) {
  main().catch((cause) => {
    process.stderr.write(
      `check-no-sentinel-ceilings FAILED\n${/** @type {Error} */ (cause).message}\n`,
    );
    process.exit(1);
  });
}
