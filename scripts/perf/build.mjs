// Builds the perf bench pipeline:
//   1. Runs `tsc -p tsconfig.perf.json` to compile the pure modules,
//      fixture generator, and bench harnesses to `dist-perf/`.
//   2. Drops `dist-perf/package.json` with `{ "type": "module" }` so
//      Node ESM treats every emitted `.js` as a module.
//   3. Runs a self-test: imports each compiled bench's `selfTest()`
//      export and runs it once. Fails loud on import error, runtime
//      error, or generator hash drift.
//
// Invoked as:
//   npm run perf:build
//
// Self-test motive: tsc + Node ESM has subtle resolution quirks
// (extensionless imports, module type, package.json hints). A bench
// that imports a missing relative path is a CI flake risk; the self-
// test fires the dependency graph end-to-end so import errors fail
// here, not midway through a 5-minute bench run.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_DIR = join(REPO_ROOT, 'dist-perf');

/**
 * Golden hashes for deterministic generator output. These are baked
 * in on the first run. If the seed, shape, or random-number
 * generator ever drifts, this self-test fails loud.
 *
 * To re-seed (after an intentional generator change):
 *   1. Run `npm run perf:build` (this script logs the actual hashes).
 *   2. Copy the new hashes into the array below.
 *   3. Re-run to confirm the build is green.
 *
 * @type {ReadonlyArray<{ shape: string; approxNodes: number; hash: string }>}
 */
const GENERATOR_GOLDEN_HASHES = [
  {
    shape: 'deep25',
    approxNodes: 1000,
    hash: '0fe63d9617bd6e3b9bcab9967da522f613c250b22f62635c2949764358aefd13',
  },
  {
    shape: 'wide-aoo',
    approxNodes: 1000,
    hash: '9731a3439a0f1ade92c2d83355fc9ae5ed2b25b46a8c89bd727489b85ce1b22f',
  },
];

const SEED_HASHES = process.env['PERF_BUILD_SEED_HASHES'] === '1';

function runTsc() {
  const isWin = process.platform === 'win32';
  // On Windows, npm shims (.cmd) require shell:true to be invocable
  // via spawn. We construct a single command string for the shell.
  const result = isWin
    ? spawnSync('npx.cmd tsc -p tsconfig.perf.json', {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        shell: true,
      })
    : spawnSync('npx', ['tsc', '-p', 'tsconfig.perf.json'], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      });
  if (result.error) {
    throw new Error(`tsc -p tsconfig.perf.json failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`tsc -p tsconfig.perf.json failed (exit ${result.status})`);
  }
}

function writeDistPackageJson() {
  writeFileSync(join(DIST_DIR, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');
}

/**
 * Imports the compiled generator and verifies the golden hashes.
 * When `PERF_BUILD_SEED_HASHES=1` is set, prints the actual hashes
 * instead of asserting them. Use this to seed the array above on a
 * deliberate generator change.
 */
async function selfTestGenerator() {
  const generatePath = join(DIST_DIR, 'perf', 'fixtures', 'generate.js');
  if (!existsSync(generatePath)) {
    throw new Error(`Compiled generator missing: ${generatePath}`);
  }
  const { generate } = await import(pathToFileURL(generatePath).href);
  /** @type {string[]} */
  const errors = [];
  for (const golden of GENERATOR_GOLDEN_HASHES) {
    const json = generate({ shape: golden.shape, approxNodes: golden.approxNodes });
    const actual = createHash('sha256').update(json).digest('hex');
    if (SEED_HASHES) {
      process.stdout.write(`  ${golden.shape} x ${golden.approxNodes} -> ${actual}\n`);
      continue;
    }
    if (actual !== golden.hash) {
      errors.push(
        `Generator hash drift: shape=${golden.shape} approxNodes=${golden.approxNodes}\n` +
          `  expected ${golden.hash}\n` +
          `  actual   ${actual}`,
      );
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n\n'));
  }
}

/**
 * Imports each compiled bench's `selfTest()` export and runs it once.
 * Benches are discovered by enumerating `dist-perf/perf/bench/*.bench.js`.
 */
async function selfTestBenches() {
  const benchDir = join(DIST_DIR, 'perf', 'bench');
  if (!existsSync(benchDir)) {
    process.stdout.write('  (no benches compiled yet -- first build)\n');
    return;
  }
  const benchFiles = readdirSync(benchDir).filter((f) => f.endsWith('.bench.js'));
  if (benchFiles.length === 0) {
    process.stdout.write('  (no benches compiled yet -- first build)\n');
    return;
  }
  for (const file of benchFiles) {
    const full = join(benchDir, file);
    /** @type {{ selfTest?: () => unknown | Promise<unknown> }} */
    const mod = await import(pathToFileURL(full).href);
    if (typeof mod.selfTest === 'function') {
      try {
        await mod.selfTest();
        process.stdout.write(`  ${file}: ok\n`);
      } catch (cause) {
        throw new Error(`${file} selfTest failed: ${/** @type {Error} */ (cause).message}`);
      }
    } else {
      process.stdout.write(`  ${file}: (no selfTest export)\n`);
    }
  }
}

async function main() {
  process.stdout.write('perf:build  step 1/3  tsc -p tsconfig.perf.json\n');
  runTsc();
  process.stdout.write('perf:build  step 2/3  dist-perf/package.json -> { type: module }\n');
  writeDistPackageJson();
  process.stdout.write('perf:build  step 3/3  self-test\n');
  await selfTestGenerator();
  await selfTestBenches();
  process.stdout.write('perf:build  OK\n');
}

const invokedFromCli = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedFromCli) {
  main().catch((cause) => {
    process.stderr.write(`perf:build FAILED\n${/** @type {Error} */ (cause).message}\n`);
    process.exit(1);
  });
}
