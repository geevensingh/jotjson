// Runs the L2 perf-bench harness (Karma by default, or Vitest with
// `--vitest`), captures `@@PERF_L2@@<json>@@END@@` sentinels emitted
// by `*.perf.ts` specs from stdout AND stderr, and writes a
// `perf-results/<utc>/layer-2.jsonl`.
//
// Invoked as:
//   npm run perf:l2          (Karma; `ng test --configuration perf`)
//   npm run perf:l2:vitest   (Vitest; `vitest run --config vitest.perf.config.mts`)
//
// Both stdout and stderr are scanned for sentinels because Vitest
// browser mode occasionally interleaves provider/dev-server output
// across the two streams. The Karma path historically only emitted
// to stdout, but scanning both is safe.

import { execSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suggestMachineLabel } from './machine-label.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function utcStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function codeSha() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const SENTINEL_RE = /@@PERF_L2@@(.*?)@@END@@/g;

/**
 * @param {string} text
 * @returns {object[]}
 */
export function extractRows(text) {
  /** @type {object[]} */
  const rows = [];
  let match;
  // Reset lastIndex for safety.
  SENTINEL_RE.lastIndex = 0;
  while ((match = SENTINEL_RE.exec(text)) !== null) {
    try {
      rows.push(JSON.parse(match[1]));
    } catch {
      // Ignore malformed sentinels; the spec writer is in-tree.
    }
  }
  return rows;
}

/**
 * Resolve the spawn command + args for the requested harness.
 *
 * @param {{ vitest: boolean }} opts
 * @returns {{ runnerLabel: string, cmd: string, args: string[] }}
 */
export function resolveRunner(opts) {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'npx.cmd' : 'npx';
  if (opts.vitest) {
    return {
      runnerLabel: 'vitest',
      cmd,
      args: ['vitest', 'run', '--config', 'vitest.perf.config.mts'],
    };
  }
  return {
    runnerLabel: 'ng test',
    cmd,
    args: ['ng', 'test', '--configuration', 'perf'],
  };
}

async function main() {
  const useVitest = process.argv.includes('--vitest');
  const machineLabel = process.env['PERF_MACHINE'] ?? suggestMachineLabel();
  const sha = codeSha();
  const capturedAtUtc = new Date().toISOString();
  const outDir = resolve(
    REPO_ROOT,
    process.env['PERF_RESULTS_DIR'] ?? join('perf-results', utcStamp()),
  );
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'layer-2.jsonl');

  const { runnerLabel, cmd, args } = resolveRunner({ vitest: useVitest });
  const isWin = process.platform === 'win32';

  const child = spawn(cmd, args, { cwd: REPO_ROOT, shell: isWin });
  let bufferedStdout = '';
  let bufferedStderr = '';

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    bufferedStdout += text;
    process.stdout.write(text);
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    bufferedStderr += text;
    process.stderr.write(text);
  });

  const exitCode = await /** @type {Promise<number>} */ (
    new Promise((resolve) => child.on('close', (code) => resolve(code ?? 1)))
  );

  // Scan stdout and stderr independently to avoid splicing sentinels
  // across stream boundaries (a sentinel split between streams was
  // already broken in the source spec; we cannot recover from that).
  const rows = [...extractRows(bufferedStdout), ...extractRows(bufferedStderr)];
  const lines = rows.map((row) =>
    JSON.stringify({ machineLabel, codeSha: sha, capturedAtUtc, ...row }),
  );
  writeFileSync(outFile, lines.length > 0 ? lines.join('\n') + '\n' : '', 'utf8');
  process.stdout.write(`perf:l2  wrote ${lines.length} rows to ${outFile}\n`);

  if (exitCode !== 0) {
    process.stderr.write(`perf:l2  ${runnerLabel} exited ${exitCode}\n`);
    process.exit(exitCode);
  }
  if (rows.length === 0) {
    const allowEmpty = process.env['PERF_ALLOW_EMPTY'] === '1';
    const level = allowEmpty ? 'WARN' : 'ERROR';
    process.stderr.write(
      `perf:l2  ${level}: no @@PERF_L2@@ rows captured. Did the perf specs run?\n`,
    );
    if (!allowEmpty) {
      process.exit(2);
    }
  }
}

const invokedFromCli = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedFromCli) {
  main().catch((cause) => {
    process.stderr.write(`perf:l2 FAILED\n${/** @type {Error} */ (cause).message}\n`);
    process.exit(1);
  });
}
