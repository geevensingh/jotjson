// Generates and prints the machine label used to namespace perf
// baselines. Output is intended to be assigned to PERF_MACHINE:
//
//     export PERF_MACHINE=$(node scripts/perf/machine-label.mjs --suggest)
//     setx PERF_MACHINE (node scripts/perf/machine-label.mjs --suggest)   # PowerShell
//
// Default shape is `<platform>-<arch>-h<8 hex>` -- e.g.,
// `linux-x64-h3f7a92b1`, `win32-x64-h7c1d05ef`. The hex segment is the
// first 8 chars of SHA-256(hostname), so:
// - Same machine -> same label across runs (stable for baseline lookup).
// - Different machines -> different labels with overwhelming probability
//   (8 hex = 4.3B buckets).
// - No personal data in the label: the hostname itself does not appear.
//
// Privacy note: this default is PII-safe by construction. Earlier
// revisions embedded the raw sanitized hostname (e.g.
// `win32-x64-GEEVENS-LAPTOP`); that leaked names into baseline
// filenames and committed JSON. The hashed form avoids that without
// losing the per-machine uniqueness baseline lookup needs.
//
// Hostname-based labels are still available as opt-in: set PERF_MACHINE
// explicitly to a self-documenting value -- e.g.
// `PERF_MACHINE=win32-x64-team-runner-01` -- when you want a
// recognizable filename. Run a hostname through `sanitizeHostnameForLabel`
// (still exported below) if you need help shaping it.
//
// PERF_MACHINE is **optional** for `perf:diff` and `perf:baseline`.
// If unset, the scripts fall back to `suggestMachineLabel()`. Set
// PERF_MACHINE explicitly to point at a specific baseline file (e.g.
// `PERF_MACHINE=win32-x64-v1-reference` to diff against the repo's
// committed reference baseline). Failure messages link `docs/perf.md`.

import { createHash } from 'node:crypto';
import { arch, hostname, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Sanitizes a raw hostname so it satisfies `isValidMachineLabel`.
 * Replaces any character outside `[A-Za-z0-9_-]` with `-`, collapses
 * runs of `-`, trims leading/trailing `-`, and truncates so that the
 * final `<platform>-<arch>-<hostname>` label stays within the 64-char
 * cap enforced by `isValidMachineLabel`. Returns `'unknown-host'` if
 * the input is empty or sanitizes down to nothing.
 *
 * Exported for tests; not part of the public API.
 *
 * @param {string} raw
 * @param {number} reservedPrefixLength how many chars `<platform>-<arch>-` will take
 * @returns {string}
 */
export function sanitizeHostnameForLabel(raw, reservedPrefixLength = 0) {
  if (typeof raw !== 'string' || raw.length === 0) return 'unknown-host';
  let sanitized = raw
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (sanitized.length === 0) return 'unknown-host';
  const budget = Math.max(1, 64 - reservedPrefixLength);
  if (sanitized.length > budget) sanitized = sanitized.slice(0, budget).replace(/-+$/g, '');
  return sanitized.length === 0 ? 'unknown-host' : sanitized;
}

/** @returns {string} */
export function suggestMachineLabel() {
  const prefix = `${platform()}-${arch()}-`;
  const hash = createHash('sha256').update(hostname()).digest('hex').slice(0, 8);
  return `${prefix}h${hash}`;
}

/**
 * Validates a user-provided PERF_MACHINE value. Allowed characters
 * keep us safe across Windows / Linux / macOS filename rules: ASCII
 * letters, digits, hyphen, underscore, and dot. Length cap is 64.
 *
 * @param {string} label
 * @returns {boolean}
 */
export function isValidMachineLabel(label) {
  return /^[A-Za-z0-9._-]{1,64}$/.test(label);
}

/**
 * Reads PERF_MACHINE from the environment and validates it. Returns
 * the label on success, or throws an `Error` whose message tells the
 * caller exactly what to run.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function requireMachineLabel(env = process.env) {
  const raw = env['PERF_MACHINE'];
  if (!raw || raw.trim().length === 0) {
    const suggestion = suggestMachineLabel();
    throw new Error(
      [
        'PERF_MACHINE env var is required when --require is used.',
        '',
        '(The perf:diff and perf:baseline scripts do NOT call this',
        'function; they fall back to suggestMachineLabel() when',
        'PERF_MACHINE is unset. This stricter form is for callers that',
        'want a fail-loud guarantee, e.g. future CI workflows.)',
        '',
        'Run one of:',
        `  PowerShell:  $env:PERF_MACHINE = "${suggestion}"`,
        `  bash/zsh:    export PERF_MACHINE=${suggestion}`,
        '',
        'See docs/perf.md for the per-machine baseline convention.',
      ].join('\n'),
    );
  }
  if (!isValidMachineLabel(raw)) {
    throw new Error(
      [
        `PERF_MACHINE=${JSON.stringify(raw)} is not a valid machine label.`,
        'Allowed: ASCII letters, digits, hyphen, underscore, dot. Max 64 chars.',
        '',
        'See docs/perf.md for the per-machine baseline convention.',
      ].join('\n'),
    );
  }
  return raw;
}

function main() {
  const arg = process.argv[2];
  if (arg === '--suggest' || arg === undefined) {
    process.stdout.write(suggestMachineLabel() + '\n');
    return;
  }
  if (arg === '--require') {
    try {
      process.stdout.write(requireMachineLabel() + '\n');
    } catch (cause) {
      process.stderr.write(`${/** @type {Error} */ (cause).message}\n`);
      process.exit(1);
    }
    return;
  }
  process.stderr.write(
    [
      'Usage:',
      '  node scripts/perf/machine-label.mjs --suggest   # prints suggested label',
      '  node scripts/perf/machine-label.mjs --require   # prints PERF_MACHINE or fails',
    ].join('\n') + '\n',
  );
  process.exit(2);
}

const invokedFromCli = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedFromCli) {
  main();
}
