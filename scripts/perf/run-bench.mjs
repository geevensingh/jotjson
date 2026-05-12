// Runs the compiled L1 perf benches under `node --expose-gc`, captures
// per-(scenario,fixture,size) rows, and writes JSONL output to
// `perf-results/<utc>/layer-1.jsonl`.
//
// Invoked as:
//   npm run perf:l1
//
// Mechanics:
//   - Calls `node scripts/perf/build.mjs` first to ensure dist-perf/
//     is fresh (cheap when nothing changed; tsc is incremental).
//   - Spawns one child Node per bench under `--expose-gc`, then
//     dynamic-imports the compiled bench module and runs its `run()`
//     entrypoint. (We spawn separately so per-bench heap profiles
//     stay independent.)
//   - Aggregates rows into `perf-results/<utc>/layer-1.jsonl`.
//
// JSONL row schema (also documented in docs/perf.md):
//   { layer, scenario, fixture, size, approxNodes, bytes, iters,
//     wallNsMedian, wallNsIqrLow, wallNsIqrHigh, wallNsStddev,
//     heapRetainedDeltaMedian, heapRetainedDeltaIqrLow, heapRetainedDeltaIqrHigh,
//     heapWorkingSetMedian, heapWorkingSetMax,
//     machineLabel, codeSha, capturedAtUtc }

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { suggestMachineLabel } from './machine-label.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_DIR = join(REPO_ROOT, 'dist-perf');
const BENCH_DIR = join(DIST_DIR, 'perf', 'bench');

function utcStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function codeSha() {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) return 'unknown';
  return result.stdout.trim();
}

/**
 * Spawns a worker process that imports the compiled bench and writes
 * its rows to stdout as a single JSON array. We use stdout-as-IPC
 * rather than `--require` shenanigans so the child runs under
 * `--expose-gc` cleanly.
 *
 * @param {string} benchPath absolute path to a compiled .bench.js
 * @returns {unknown[]}
 */
function runBenchWorker(benchPath) {
  const result = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--max-old-space-size=12288',
      '--input-type=module',
      '-e',
      `import('${pathToFileURL(benchPath).href}').then(async (mod) => { ` +
        `const rows = await mod.run(); ` +
        `process.stdout.write('\\n@@PERF_ROWS@@' + JSON.stringify(rows) + '@@END@@\\n'); ` +
        `}).catch((err) => { ` +
        `process.stderr.write('bench worker error: ' + (err && err.stack || err) + '\\n'); ` +
        `process.exit(1); });`,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr || '');
    throw new Error(`bench worker for ${benchPath} failed (exit ${result.status})`);
  }
  // Stream the worker's stdout (any bench progress lines) to ours.
  const match = result.stdout.match(/@@PERF_ROWS@@([\s\S]*?)@@END@@/);
  if (!match) {
    process.stderr.write(result.stdout);
    throw new Error(`bench worker for ${benchPath} did not emit a row payload`);
  }
  // Strip the payload markers from stdout before forwarding.
  const passthrough = result.stdout.replace(/\n?@@PERF_ROWS@@[\s\S]*?@@END@@\n?/, '');
  if (passthrough.length > 0) process.stdout.write(passthrough);
  return JSON.parse(match[1]);
}

function discoverBenches() {
  /** @type {string[]} */
  const benches = [];
  try {
    for (const entry of readdirSync(BENCH_DIR)) {
      if (entry.endsWith('.bench.js')) benches.push(join(BENCH_DIR, entry));
    }
  } catch (cause) {
    throw new Error(
      `dist-perf/perf/bench is missing. Run \`npm run perf:build\` first. (${/** @type {Error} */ (cause).message})`,
    );
  }
  benches.sort();
  return benches;
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
  const outFile = join(outDir, 'layer-1.jsonl');
  const benches = discoverBenches();
  if (benches.length === 0) {
    throw new Error('No compiled benches in dist-perf/perf/bench. Run `npm run perf:build` first.');
  }
  /** @type {string[]} */
  const lines = [];
  for (const benchPath of benches) {
    process.stdout.write(`perf:l1  ${benchPath}\n`);
    const rows = runBenchWorker(benchPath);
    for (const row of rows) {
      const enriched = {
        layer: 1,
        machineLabel,
        codeSha: sha,
        capturedAtUtc,
        .../** @type {Record<string, unknown>} */ (row),
      };
      lines.push(JSON.stringify(enriched));
    }
  }
  writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
  process.stdout.write(`perf:l1  wrote ${lines.length} rows to ${outFile}\n`);
}

const invokedFromCli = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedFromCli) {
  main().catch((cause) => {
    process.stderr.write(`perf:l1 FAILED\n${/** @type {Error} */ (cause).message}\n`);
    process.exit(1);
  });
}

export { main as runLayer1 };
