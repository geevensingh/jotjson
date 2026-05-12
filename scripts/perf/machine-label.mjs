// Generates and prints the machine label used to namespace perf
// baselines. Output is intended to be assigned to PERF_MACHINE:
//
//     export PERF_MACHINE=$(node scripts/perf/machine-label.mjs --suggest)
//     setx PERF_MACHINE (node scripts/perf/machine-label.mjs --suggest)   # PowerShell
//
// The suggested label is `<platform>-<arch>-<6-char-cpu-hash>` -- e.g.
// `linux-x64-3f9c2a`, `win32-x64-1a2b3c`. The hash is computed over the
// first CPU model string, so two machines with the same CPU model
// produce the same label (typical for fleet machines). The label is
// safe to include in filenames on every OS.
//
// PERF_MACHINE is **optional** for `perf:diff` and `perf:baseline`.
// If unset, the scripts fall back to `suggestMachineLabel()` (same
// shape as below). Set PERF_MACHINE explicitly when running on a
// known reference machine so the baseline filename is stable across
// distinct CPU revisions of the same model. Failure messages link
// `docs/perf.md` and suggest this command for that case.

import { createHash } from 'node:crypto';
import { arch, cpus, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

/** @returns {string} */
export function suggestMachineLabel() {
  const cpuModel = cpus()[0]?.model ?? 'unknown-cpu';
  const hash = createHash('sha256').update(cpuModel).digest('hex').slice(0, 6);
  return `${platform()}-${arch()}-${hash}`;
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
        'PERF_MACHINE env var is required for perf:diff and perf:baseline.',
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
