// Wraps `npx playwright test --config=perf/browser/playwright.perf.config.ts`,
// captures `@@PERF_L3@@<json>@@END@@` sentinels from stdout, and writes
// `perf-results/<utc>/layer-3.jsonl`. Sets `PERF_RESULTS_DIR` so the
// specs write `.cpuprofile` / `.trace.json` files into the same run dir.
//
// Invoked as:
//   npm run perf:l3

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

const SENTINEL_RE = /@@PERF_L3@@(.*?)@@END@@/g;

/**
 * @param {string} text
 * @returns {object[]}
 */
export function extractRows(text) {
  /** @type {object[]} */
  const rows = [];
  let match;
  SENTINEL_RE.lastIndex = 0;
  while ((match = SENTINEL_RE.exec(text)) !== null) {
    try {
      rows.push(JSON.parse(match[1]));
    } catch {
      // Ignore malformed sentinels.
    }
  }
  return rows;
}

async function main() {
  const machineLabel = process.env['PERF_MACHINE'] ?? suggestMachineLabel();
  const sha = codeSha();
  const capturedAtUtc = new Date().toISOString();
  const outDir = resolve(
    REPO_ROOT,
    process.env['PERF_RESULTS_DIR'] ?? join('perf-results', utcStamp()),
  );
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, 'traces'), { recursive: true });
  const outFile = join(outDir, 'layer-3.jsonl');

  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'npx.cmd' : 'npx';
  const args = [
    'playwright',
    'test',
    '--config=perf/browser/playwright.perf.config.ts',
    ...process.argv.slice(2),
  ];

  const child = spawn(cmd, args, {
    cwd: REPO_ROOT,
    shell: isWin,
    env: {
      ...process.env,
      PERF_RESULTS_DIR: outDir,
    },
  });

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
  process.stdout.write(`perf:l3  wrote ${lines.length} rows to ${outFile}\n`);

  if (exitCode !== 0) {
    process.stderr.write(`perf:l3  playwright exited ${exitCode}\n`);
    process.exit(exitCode);
  }
  if (rows.length === 0) {
    process.stderr.write(
      'perf:l3  WARN: no @@PERF_L3@@ rows captured. Did the perf scenarios run?\n',
    );
  }
}

const invokedFromCli = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedFromCli) {
  main().catch((cause) => {
    process.stderr.write(`perf:l3 FAILED\n${/** @type {Error} */ (cause).message}\n`);
    process.exit(1);
  });
}
