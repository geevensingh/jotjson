// Generates and prints the machine label used to namespace perf
// baselines. Output is intended to be assigned to PERF_MACHINE:
//
//     export PERF_MACHINE=$(node scripts/perf/machine-label.mjs --suggest)
//     setx PERF_MACHINE (node scripts/perf/machine-label.mjs --suggest)   # PowerShell
//
// The suggested label is `<platform>-<arch>-<hostname>` -- e.g.
// `linux-x64-build-runner-01`, `win32-x64-geeven-laptop`. The hostname
// segment is sanitized (any char outside `[A-Za-z0-9_-]` is replaced
// with `-`, runs of `-` are collapsed, leading/trailing `-` trimmed)
// so the result always satisfies `isValidMachineLabel`'s character
// class and 64-char cap.
//
// Privacy note: hostnames sometimes contain personal names ("GEEVENS-
// LAPTOP", "alex-mbp"). The repo convention is that the suggested
// label is a starting point, and contributors who want anonymity
// override PERF_MACHINE with a non-PII value (a CPU-hash form, a
// project-issued anonymous label, etc.) before running perf scripts.
//
// PERF_MACHINE is **optional** for `perf:diff` and `perf:baseline`.
// If unset, the scripts fall back to `suggestMachineLabel()` (same
// shape as below). Set PERF_MACHINE explicitly when running on a
// known reference machine so the baseline filename is stable across
// distinct hosts. Failure messages link `docs/perf.md` and suggest
// this command for that case.

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
  const host = sanitizeHostnameForLabel(hostname(), prefix.length);
  return `${prefix}${host}`;
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
