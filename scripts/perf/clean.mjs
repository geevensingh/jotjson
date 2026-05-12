// Prunes perf-results/ directories older than 7 days.
//
// Invoked as:  npm run perf:clean
//
// Per the perf plan, perf-results/<utc>/ accumulates one directory per
// run. Without a janitor, large `.cpuprofile` and `.trace.json` files
// build up; the cleaner keeps the recent N days and drops the rest.

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MAX_AGE_DAYS = 7;

/**
 * @typedef {object} CleanOptions
 * @property {string} rootDir
 * @property {number} maxAgeMs
 * @property {(() => number) | undefined} [now]
 * @property {boolean | undefined} [dryRun]
 * @property {boolean | undefined} [verbose]
 */

/**
 * @typedef {object} CleanResult
 * @property {string[]} removed
 * @property {string[]} kept
 */

/**
 * @param {CleanOptions} options
 * @returns {CleanResult}
 */
export function pruneOldRuns(options) {
  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const kept = [];
  if (!existsSync(options.rootDir)) {
    return { removed, kept };
  }
  const now = options.now ? options.now() : Date.now();
  for (const entry of readdirSync(options.rootDir)) {
    const fullPath = join(options.rootDir, entry);
    const stat = statSync(fullPath);
    if (!stat.isDirectory()) continue;
    const ageMs = now - stat.mtimeMs;
    if (ageMs > options.maxAgeMs) {
      if (!options.dryRun) {
        rmSync(fullPath, { recursive: true, force: true });
      }
      removed.push(fullPath);
      if (options.verbose) {
        process.stdout.write(`removed: ${fullPath} (age: ${Math.round(ageMs / 86400000)}d)\n`);
      }
    } else {
      kept.push(fullPath);
      if (options.verbose) {
        process.stdout.write(`kept:    ${fullPath} (age: ${Math.round(ageMs / 86400000)}d)\n`);
      }
    }
  }
  return { removed, kept };
}

function main() {
  const rootDir = join(process.cwd(), 'perf-results');
  const args = new Set(process.argv.slice(2));
  const result = pruneOldRuns({
    rootDir,
    maxAgeMs: DEFAULT_MAX_AGE_DAYS * 86400000,
    dryRun: args.has('--dry-run'),
    verbose: true,
  });
  process.stdout.write(
    `perf:clean ${args.has('--dry-run') ? '(dry-run) ' : ''}removed=${result.removed.length} kept=${result.kept.length}\n`,
  );
}

const invokedFromCli = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedFromCli) {
  main();
}
