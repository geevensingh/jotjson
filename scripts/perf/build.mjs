// Builds the perf bench pipeline:
//   1. Runs `tsc -p tsconfig.perf.json` to compile the pure modules,
//      fixture generator, and bench harnesses to `dist-perf/`.
//   2. Rewrites extensionless relative imports in the emit to add a
//      `.js` suffix, so Node ESM can resolve them.
//   3. Drops `dist-perf/package.json` with `{ "type": "module" }` so
//      Node ESM treats every emitted `.js` as a module.
//   4. Runs a self-test: imports each compiled bench's `selfTest()`
//      export and runs it once. Fails loud on import error, runtime
//      error, or generator hash drift.
//
// Why the rewrite (step 2): the pure modules under `src/app/core/json/`
// + `src/app/shared/components/json-tree/build-tree.ts` are shared
// with the SPA build, which uses Webpack/esbuild and rejects
// `.js`-suffix specifiers in source. They must therefore be
// extensionless in source. Node ESM, however, requires explicit
// suffixes on relative specifiers in `.js` files. We tried TS 5.7+
// `rewriteRelativeImportExtensions` + `.ts`-suffix source on
// 2026-04-XX, but Angular's Karma plugin re-rewrites the `.ts` -> `.js`
// during its own compile step and Webpack's resolver does not reverse
// it, so the spike broke `ng test`. The post-emit fixer below is the
// resulting compromise.
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
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
  {
    shape: 'mixed-d10',
    approxNodes: 1000,
    hash: '6e681d878b13ea9b5d2e55efee79952e9f6ff1005337fb1a0ff1a6e279ea8052',
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
 * Source files use extensionless relative imports (SPA-friendly), but
 * Node ESM requires explicit suffixes. This rewrites the emit by
 * walking `dist-perf/` and adding `.js` to every relative specifier
 * that doesn't already carry a recognized extension.
 *
 * Matched specifiers MUST start with `./` or `../`.
 *
 * Three rewrite forms are handled:
 *   - `import x from './foo'`              (static, named/default)
 *   - `import './foo'`                     (static, side-effect)
 *   - `import('./foo')` / `await import('./foo')` (dynamic)
 *
 * Specifiers already ending in a known asset extension are skipped:
 *   `.js`, `.mjs`, `.cjs`, `.json`, `.css`, `.wasm`, `.svg`. These are
 *   either already valid for Node ESM or would be mangled into a
 *   missing file by appending `.js`.
 *
 * Processing is line-by-line so the regex cannot accidentally bridge
 * a JSDoc comment that mentions `import` with a real `from './x'`
 * line below it. Lines whose first non-whitespace content is `//`,
 * `/*`, or `*` (JSDoc continuation) are skipped entirely so doc text
 * about imports is left alone.
 */
function fixRelativeImportExtensions() {
  const skipExt = /\.(json|css|wasm|svg|[mc]?js)$/;
  const staticPattern = /(\bfrom\s+|\bimport\s+)(['"])(\.{1,2}\/[^'"\r\n]+)(['"])/g;
  const dynamicPattern = /(\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"\r\n]+)(['"])/g;

  /** @param {string} line */
  function rewriteLine(line) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      return line;
    }
    const rewriter = (
      /** @type {string} */ _match,
      /** @type {string} */ leading,
      /** @type {string} */ openQuote,
      /** @type {string} */ specifier,
      /** @type {string} */ closeQuote,
    ) =>
      skipExt.test(specifier)
        ? `${leading}${openQuote}${specifier}${closeQuote}`
        : `${leading}${openQuote}${specifier}.js${closeQuote}`;
    return line.replace(staticPattern, rewriter).replace(dynamicPattern, rewriter);
  }

  /** @param {string} dir */
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (full.endsWith('.js')) {
        const original = readFileSync(full, 'utf8');
        const next = original.split('\n').map(rewriteLine).join('\n');
        if (next !== original) {
          writeFileSync(full, next);
        }
      }
    }
  }

  walk(DIST_DIR);
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
  process.stdout.write('perf:build  step 1/4  tsc -p tsconfig.perf.json\n');
  runTsc();
  process.stdout.write('perf:build  step 2/4  rewrite relative imports to add .js\n');
  fixRelativeImportExtensions();
  process.stdout.write('perf:build  step 3/4  dist-perf/package.json -> { type: module }\n');
  writeDistPackageJson();
  process.stdout.write('perf:build  step 4/4  self-test\n');
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
