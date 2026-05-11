// Asserts that no `*.perf.ts` files are included in the Karma test set.
// Used as a prestep of `perf:l2` so the perf-bench files do not get
// pulled into `verify:fast` / `npm test` and balloon Karma runtimes.
//
// Implementation: parse `tsconfig.spec.json` for an `exclude` entry
// matching `src/**/*.perf.ts` (or equivalent). This is empirical: the
// glob actually appears in the file. We do NOT try to introspect ng
// test's resolved file set -- that requires booting Angular CLI,
// which is too expensive for a prestep.

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
  // tsconfig.spec.json is JSONC. Strip comments but only OUTSIDE string
  // literals -- otherwise globs like `src/**/*.perf.ts` look like
  // block-comment delimiters.
  const stripped = stripJsoncComments(text);
  /** @type {{ exclude?: string[] }} */
  const parsed = JSON.parse(stripped);
  return parsed.exclude ?? [];
}

/**
 * Removes // and /* ... *\/ comments outside of double-quoted strings.
 *
 * @param {string} src
 * @returns {string}
 */
export function stripJsoncComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = i + 1 < n ? src[i + 1] : '';
    if (ch === '"') {
      // Copy a string literal verbatim, including escape sequences.
      out += ch;
      i++;
      while (i < n) {
        const c2 = src[i];
        if (c2 === '\\' && i + 1 < n) {
          out += c2 + src[i + 1];
          i += 2;
          continue;
        }
        out += c2;
        i++;
        if (c2 === '"') break;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i + 1 < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
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
