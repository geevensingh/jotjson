// Orchestrates a full L1+L2+L3 perf run into a single results directory.
//
// Generates one UTC stamp, exports it as PERF_RESULTS_DIR, and shells through
// `npm run perf:l1`, `npm run perf:l2`, and `npm run perf:l3` as separate
// spawns so each layer's preperf hook still fires.
//
// Each layer script reads process.env.PERF_RESULTS_DIR; if unset, it falls
// back to its own utcStamp() call so standalone layer runs still work.
//
// Fail-fast on any non-zero exit.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PERF_LAYERS = ['l1', 'l2', 'l3'];

function utcStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * @param {string} layer
 */
function runStep(layer) {
  const isWin = process.platform === 'win32';
  const result = spawnSync(isWin ? 'npm.cmd' : 'npm', ['run', `perf:${layer}`], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: isWin,
    env: process.env,
  });

  if (result.error) {
    process.stderr.write(`perf:${layer} failed to spawn: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.stderr.write(`perf:${layer} failed (exit ${result.status})\n`);
    process.exit(result.status ?? 1);
  }
}

function printUsage() {
  process.stdout.write('Usage: npm run perf:all\n');
  process.stdout.write(
    'Runs perf:l1, perf:l2, and perf:l3 into one perf-results/<utc> directory.\n',
  );
}

function main() {
  if (process.argv.includes('--help')) {
    printUsage();
    return;
  }

  const stamp = utcStamp();
  const resultsDir = join('perf-results', stamp);
  process.env['PERF_RESULTS_DIR'] = resultsDir;
  process.stdout.write(`perf:all  results dir: ${resultsDir}\n`);

  for (const layer of PERF_LAYERS) {
    process.stdout.write(`perf:all  step ${layer}\n`);
    runStep(layer);
  }

  process.stdout.write('perf:all  OK\n');
}

const invokedFromCli = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedFromCli) {
  main();
}

export { main as runAllPerfLayers };
