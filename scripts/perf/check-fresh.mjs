// Informational baseline-freshness check (skeptic r2 #10): warns but
// does NOT fail when the per-machine baseline is older than 30 days.
// Does NOT inspect git history or the working tree for perf-sensitive
// file changes; freshness is purely an age check against the baseline
// `lastUpdatedUtc` timestamp.
//
// Exit code is 0 in all cases. This script is documented in
// docs/perf.md as a contributor-norm reminder, not a CI gate.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINES_DIR = join(REPO_ROOT, 'perf-baselines');
const STALE_THRESHOLD_DAYS = 30;

/**
 * @param {string} machineLabel
 * @param {string} [baselinesDir]
 * @returns {{ baselinePath: string, ageDays: number | null }}
 */
export function readBaselineAge(machineLabel, baselinesDir = BASELINES_DIR) {
  const baselinePath = join(baselinesDir, `${machineLabel}.json`);
  if (!existsSync(baselinePath)) return { baselinePath, ageDays: null };
  /** @type {{ lastUpdatedUtc?: string }} */
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
  if (!parsed.lastUpdatedUtc) return { baselinePath, ageDays: null };
  const ageMs = Date.now() - new Date(parsed.lastUpdatedUtc).getTime();
  return { baselinePath, ageDays: ageMs / 86_400_000 };
}

/**
 * @param {number | null} ageDays
 * @param {number} threshold
 * @returns {boolean}
 */
export function isStale(ageDays, threshold = STALE_THRESHOLD_DAYS) {
  if (ageDays === null) return false;
  return ageDays > threshold;
}

async function main() {
  const machineLabel = process.env['PERF_MACHINE'];
  if (!machineLabel) {
    process.stdout.write('perf:check-fresh  PERF_MACHINE unset; skipping freshness check.\n');
    return;
  }
  const { baselinePath, ageDays } = readBaselineAge(machineLabel);
  if (ageDays === null) {
    process.stdout.write(
      `perf:check-fresh  no baseline at ${baselinePath} yet (run \`npm run perf:baseline\`)\n`,
    );
    return;
  }
  if (isStale(ageDays)) {
    process.stdout.write(
      `perf:check-fresh  WARN: baseline at ${baselinePath} is ${ageDays.toFixed(1)} days old (>${STALE_THRESHOLD_DAYS}); consider re-benching.\n`,
    );
    return;
  }
  process.stdout.write(`perf:check-fresh  OK (baseline is ${ageDays.toFixed(1)} days old)\n`);
}

const invokedFromCli = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedFromCli) {
  main().catch((cause) => {
    process.stderr.write(`perf:check-fresh FAILED\n${/** @type {Error} */ (cause).message}\n`);
    process.exit(1);
  });
}
