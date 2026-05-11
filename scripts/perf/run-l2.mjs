// Runs `ng test --configuration perf`, captures `@@PERF_L2@@<json>@@END@@`
// sentinels emitted by `*.perf.ts` specs from stdout, and writes a
// `perf-results/<utc>/layer-2.jsonl`.
//
// Invoked as:
//   npm run perf:l2

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suggestMachineLabel } from './machine-label.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESULTS_DIR = join(REPO_ROOT, 'perf-results');

function utcStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function codeSha() {
  try {
    const { execSync } = require('node:child_process');
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

async function main() {
  const machineLabel = process.env['PERF_MACHINE'] ?? suggestMachineLabel();
  const sha = codeSha();
  const capturedAtUtc = new Date().toISOString();
  const outDir = join(RESULTS_DIR, utcStamp());
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'layer-2.jsonl');

  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'npx.cmd' : 'npx';
  const args = ['ng', 'test', '--configuration', 'perf'];

  const child = spawn(cmd, args, { cwd: REPO_ROOT, shell: isWin });
  let buffered = '';

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    buffered += text;
    process.stdout.write(text);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
  });

  const exitCode = await /** @type {Promise<number>} */ (
    new Promise((resolve) => child.on('close', (code) => resolve(code ?? 1)))
  );

  const rows = extractRows(buffered);
  const lines = rows.map((row) =>
    JSON.stringify({ machineLabel, codeSha: sha, capturedAtUtc, ...row }),
  );
  writeFileSync(outFile, lines.length > 0 ? lines.join('\n') + '\n' : '', 'utf8');
  process.stdout.write(`perf:l2  wrote ${lines.length} rows to ${outFile}\n`);

  if (exitCode !== 0) {
    process.stderr.write(`perf:l2  ng test exited ${exitCode}\n`);
    process.exit(exitCode);
  }
  if (rows.length === 0) {
    process.stderr.write('perf:l2  WARN: no @@PERF_L2@@ rows captured. Did the perf specs run?\n');
  }
}

const invokedFromCli = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedFromCli) {
  main().catch((cause) => {
    process.stderr.write(`perf:l2 FAILED\n${/** @type {Error} */ (cause).message}\n`);
    process.exit(1);
  });
}
