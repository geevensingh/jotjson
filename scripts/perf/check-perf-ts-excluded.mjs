// Asserts that no `*.perf.ts` files are included in the Karma test set.
// Used as a prestep of `perf:l2` so the perf-bench files do not get
// pulled into `verify:fast` / `npm test` and balloon Karma runtimes.
//
// Implementation: parse `tsconfig.spec.json` for an `exclude` entry
// matching `src/**/*.perf.ts` (or equivalent). This is empirical: the
// glob actually appears in the file. We do NOT try to introspect ng
// test's resolved file set -- that requires booting Angular CLI,
// which is too expensive for a prestep.
//
// `tsconfig.spec.json` is JSONC (comments + trailing commas), so we
// parse with `jsonc-parser` rather than `JSON.parse`. Per AGENTS.md s2,
// jsonc-parser is the canonical JSON/JSONC reader in this repo.

import { parse as parseJsonc } from 'jsonc-parser';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const REQUIRED_EXCLUDE_GLOBS = ['src/**/*.perf.ts'];

/**
 * @param {string} text
 * @returns {string[]}
 */
export function parseExcludeGlobs(text) {
  /** @type {{ exclude?: string[] } | undefined} */
  const parsed = parseJsonc(text, [], { allowTrailingComma: true, disallowComments: false });
  if (!parsed || typeof parsed !== 'object') return [];
  return parsed.exclude ?? [];
}

/**
 * @param {string[]} actual
 * @param {string[]} required
 * @returns {string[]} missing globs
 */
export function findMissingGlobs(actual, required) {
  return required.filter((needed) => !actual.includes(needed));
}

async function main() {
  const tsconfigPath = join(REPO_ROOT, 'tsconfig.spec.json');
  const text = readFileSync(tsconfigPath, 'utf8');
  const excludes = parseExcludeGlobs(text);
  const missing = findMissingGlobs(excludes, REQUIRED_EXCLUDE_GLOBS);
  if (missing.length > 0) {
    process.stderr.write(
      `check-perf-ts-excluded FAILED\n` +
        `${tsconfigPath} is missing these "exclude" entries:\n` +
        missing.map((entry) => `  - ${entry}`).join('\n') +
        '\nAdd them so *.perf.ts files do not run in Karma unit tests.\n',
    );
    process.exit(1);
  }
  process.stdout.write('check-perf-ts-excluded  OK\n');
}

const invokedFromCli = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedFromCli) {
  main().catch((cause) => {
    process.stderr.write(
      `check-perf-ts-excluded FAILED\n${/** @type {Error} */ (cause).message}\n`,
    );
    process.exit(1);
  });
}
