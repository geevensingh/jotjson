// Validates that perf/fixtures/real/*.json contains no obvious leaks
// from a real document: only deterministic-placeholder UUIDs, only
// `lorem-*` string values, only `lorem@example.com` emails, only the
// canonical timestamp substitutes.
//
// Run as:
//   node scripts/perf/check-fixture-redaction.mjs perf/fixtures/real/cosmos-doc-sample.json
//
// The recipe is documented in perf/fixtures/real/README.md.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER_UUID_RE = /^00000000-0000-0000-0000-\d{12}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LOREM_RE = /^lorem-/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const CANONICAL_TIMESTAMP = '2000-01-01T00:00:00Z';

// Identifier-like (programming token): letters/digits/underscore/hyphen/dot.
// Length cap is the safety knob: long free-form strings should be lorem-*.
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
// MIME-type-like: e.g. application/pdf, image/png, text/plain.
const MIME_RE = /^[A-Za-z][A-Za-z0-9_.+-]{0,31}\/[A-Za-z][A-Za-z0-9_.+-]{0,63}$/;
// Locale-like: en, en-US, zh-Hans-CN. ASCII letters + hyphen, short.
const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;
// Version-like: v1, v1.2.3, 2.0.
const VERSION_RE = /^v?\d+(\.\d+){0,3}$/;

/**
 * Returns true when `value` looks like a structural token (programming
 * identifier, enum, MIME type, locale, version) that carries SHAPE,
 * not user content. The check rejects sentence-like long lowercase
 * strings and strings with embedded whitespace.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isAcceptableShapeToken(value) {
  if (value.length === 0) return true;
  if (value.length > 96) return false;
  if (/\s/.test(value)) return false;
  if (LOREM_RE.test(value)) return true;
  if (value === CANONICAL_TIMESTAMP) return true;
  if (PLACEHOLDER_UUID_RE.test(value)) return true;
  if (value === 'lorem@example.com') return true;
  if (IDENTIFIER_RE.test(value)) return true;
  if (MIME_RE.test(value)) return true;
  if (LOCALE_RE.test(value)) return true;
  if (VERSION_RE.test(value)) return true;
  return false;
}

/**
 * Walks an arbitrary JSON value and yields every string leaf with its
 * dotted JSON pointer path.
 *
 * @param {unknown} value
 * @param {string} path
 * @returns {Generator<{ path: string; value: string }>}
 */
function* stringLeaves(value, path = '$') {
  if (typeof value === 'string') {
    yield { path, value };
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      yield* stringLeaves(value[i], `${path}[${i}]`);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      yield* stringLeaves(v, `${path}.${k}`);
    }
  }
}

/**
 * @param {string} fixturePath
 * @returns {string[]} list of violation messages (empty when clean)
 */
export function checkRedaction(fixturePath) {
  const raw = readFileSync(fixturePath, 'utf8');
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return [`${fixturePath}: invalid JSON: ${/** @type {Error} */ (cause).message}`];
  }
  /** @type {string[]} */
  const violations = [];
  for (const { path, value } of stringLeaves(parsed)) {
    if (UUID_RE.test(value) && !PLACEHOLDER_UUID_RE.test(value)) {
      violations.push(`${fixturePath} ${path}: real-looking UUID "${value}"`);
      continue;
    }
    if (EMAIL_RE.test(value) && value !== 'lorem@example.com') {
      violations.push(`${fixturePath} ${path}: real-looking email "${value}"`);
      continue;
    }
    if (ISO_TIMESTAMP_RE.test(value) && value !== CANONICAL_TIMESTAMP) {
      violations.push(`${fixturePath} ${path}: non-canonical timestamp "${value}"`);
      continue;
    }
    // Path-like: split on `/` and check each segment as a shape token.
    if (value.startsWith('/') && value.includes('/')) {
      const segments = value.split('/').filter(Boolean);
      if (segments.length > 0 && segments.every((seg) => isAcceptableShapeToken(seg))) {
        continue;
      }
    }
    if (isAcceptableShapeToken(value)) continue;
    violations.push(`${fixturePath} ${path}: unredacted free-form string "${value}"`);
  }
  return violations;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write(
      'Usage: node scripts/perf/check-fixture-redaction.mjs <path-to-json> [...]\n',
    );
    process.exit(2);
  }
  /** @type {string[]} */
  const allViolations = [];
  for (const arg of args) {
    for (const violation of checkRedaction(arg)) {
      allViolations.push(violation);
    }
  }
  if (allViolations.length > 0) {
    for (const violation of allViolations) {
      process.stderr.write(violation + '\n');
    }
    process.stderr.write(
      `\n${allViolations.length} violation(s). See perf/fixtures/real/README.md for the redaction recipe.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`OK: ${args.length} fixture(s) checked\n`);
}

const invokedFromCli = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedFromCli) {
  main();
}
