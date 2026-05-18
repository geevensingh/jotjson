#!/usr/bin/env node
// Verifies that both workspace lockfiles (root and `api/`) are in sync with
// their respective `package.json` files. Catches two classes of bug:
//
//   (a) Dependency-tree drift (e.g., `npm install --legacy-peer-deps` /
//       `--force` overrides that omit transitive optional-peer entries
//       which `npm ci` on Linux later rejects). Detected by running
//       `npm ci --dry-run` per workspace.
//
//   (b) Root `version` field drift (e.g., a bump of `package.json` that
//       forgot `package-lock.json`). `npm ci --dry-run` does NOT catch
//       this case because the dependency tree is still consistent --
//       npm validates the deps but treats the root `version` as
//       metadata. PR #286 was the second occurrence; this gate
//       prevents the third. Detected by parsing both JSON files and
//       comparing `pkg.version === lock.version === lock.packages[""].version`.
//
// Implementation: runs (b) first (fast, pure JSON parse, ~5ms); if both
// workspaces pass, runs (a) (slower, ~2s per workspace).
//
// Two failure modes for (a):
//
//   Lockfile drift (the case we care about) - npm output contains the
//                  substring "lock file" (case-insensitive), e.g.
//                  "Missing: X from lock file" or "Invalid: lock file's X
//                  does not satisfy Y". We print a friendly fix message.
//
//   Other npm failures (network, registry, npm config, transient issues) -
//                  we print a generic "see npm output above" message so a
//                  blip isn't misclassified as drift.
//
// Runs with zero dependencies on Node 24+. Invoke directly or via:
//   npm run lint:lockfile

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const WORKSPACES = [
  { name: 'root', prefix: null, lockfile: 'package-lock.json', manifest: 'package.json' },
  {
    name: 'api/',
    prefix: 'api',
    lockfile: 'api/package-lock.json',
    manifest: 'api/package.json',
  },
];

// Locate npm-cli.js relative to the running node binary so we can invoke it
// directly with `process.execPath`, bypassing the platform shell wrappers
// (`npm.cmd` on Windows; cmd.exe banners can leak into stdout under some
// AutoRun configurations).
function findNpmCli() {
  const nodeDir = dirname(process.execPath);
  const candidates = [
    // Windows: <nodeDir>\node_modules\npm\bin\npm-cli.js
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // POSIX: <nodeDir>/../lib/node_modules/npm/bin/npm-cli.js
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Pure function: compares the root `version` field in package.json against
 * the two places it is mirrored in package-lock.json (`lock.version` and
 * `lock.packages[""].version`). Returns null on match, or a short
 * single-line message describing the drift on mismatch.
 *
 * Exported for unit-testing under `scripts/check-lockfile.test.mjs`.
 *
 * @param {unknown} pkg - parsed package.json contents
 * @param {unknown} lock - parsed package-lock.json contents
 * @returns {string | null}
 */
export function checkVersionInSync(pkg, lock) {
  if (typeof pkg !== 'object' || pkg === null) {
    return 'package.json did not parse to an object';
  }
  if (typeof lock !== 'object' || lock === null) {
    return 'package-lock.json did not parse to an object';
  }
  const pkgVersion = /** @type {Record<string, unknown>} */ (pkg).version;
  if (typeof pkgVersion !== 'string') {
    return 'package.json is missing a string `version` field';
  }
  const lockVersion = /** @type {Record<string, unknown>} */ (lock).version;
  const lockPackages = /** @type {Record<string, unknown>} */ (lock).packages;
  if (typeof lockVersion !== 'string') {
    return 'package-lock.json is missing a top-level string `version` field';
  }
  if (typeof lockPackages !== 'object' || lockPackages === null) {
    return 'package-lock.json is missing the `packages` map';
  }
  const rootPkg = /** @type {Record<string, unknown>} */ (lockPackages)[''];
  if (typeof rootPkg !== 'object' || rootPkg === null) {
    return 'package-lock.json is missing the root `packages[""]` entry';
  }
  const rootPkgVersion = /** @type {Record<string, unknown>} */ (rootPkg).version;
  if (typeof rootPkgVersion !== 'string') {
    return 'package-lock.json `packages[""]` is missing a string `version` field';
  }
  if (pkgVersion !== lockVersion || pkgVersion !== rootPkgVersion) {
    return (
      `version drift: package.json=${pkgVersion}, ` +
      `package-lock.json=${lockVersion}, ` +
      `package-lock.json packages[""]=${rootPkgVersion}`
    );
  }
  return null;
}

function printVersionDriftMessage(workspace, detail) {
  const cdHint = workspace.prefix ? `cd ${workspace.prefix}; ` : '';
  console.error('');
  console.error(`check-lockfile: FAILED for workspace '${workspace.name}' (version drift)`);
  console.error(`  ${detail}`);
  console.error('  Common cause: bumped package.json `version` without syncing the lockfile.');
  console.error('  Fix (hand-edit, avoids transitive churn):');
  console.error(
    `    Edit ${workspace.lockfile} so both top-level \`version\` and \`packages[""].version\``,
  );
  console.error(
    `    match the new \`${workspace.manifest}\` \`version\`. \`npm ci --dry-run\` does NOT`,
  );
  console.error('    catch this case, so the gate above is the only repo-wide signal.');
  console.error(`    git add ${workspace.lockfile}`);
}

function runDryRun(NPM_CLI, workspace) {
  const args = [NPM_CLI];
  if (workspace.prefix) {
    args.push('--prefix', workspace.prefix);
  }
  args.push('ci', '--dry-run', '--no-audit', '--no-fund');

  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    shell: false,
  });

  if (result.error) {
    return {
      ok: false,
      kind: 'spawn',
      stdout: '',
      stderr: result.error.message,
      status: null,
    };
  }

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const combined = `${stdout}\n${stderr}`;

  if (result.status === 0) {
    return { ok: true, stdout, stderr, status: 0 };
  }

  // Drift signature: npm prints "lock file" in messages like
  //   "Missing: foo@1.0 from lock file"
  //   "Invalid: lock file's bar@2 does not satisfy baz@3"
  //   "npm error `npm ci` can only install packages when your package.json
  //    and package-lock.json or npm-shrinkwrap.json are in sync."
  const isDrift = /lock\s*file/i.test(combined);

  return {
    ok: false,
    kind: isDrift ? 'drift' : 'other',
    stdout,
    stderr,
    status: result.status,
  };
}

function printDriftMessage(workspace) {
  const cdHint = workspace.prefix ? `cd ${workspace.prefix}; ` : '';
  console.error('');
  console.error(`check-lockfile: FAILED for workspace '${workspace.name}'`);
  console.error('  Lockfile is out of sync with package.json. Common causes:');
  console.error('    - Used `npm install --legacy-peer-deps` or `--force`');
  console.error('      (forbidden by AGENTS.md without explicit user approval)');
  console.error('    - Hand-edited the lockfile');
  console.error('    - Bad merge of package*.json');
  console.error('  Fix:');
  console.error(`    ${cdHint}Remove-Item ${workspace.lockfile.split('/').pop()}`);
  console.error(`    ${cdHint}npm install --package-lock-only`);
  console.error(`    git add ${workspace.lockfile}`);
}

function printOtherFailureMessage(workspace, status) {
  console.error('');
  console.error(
    `check-lockfile: 'npm ci --dry-run' failed for workspace '${workspace.name}' (exit ${status}); see npm output above`,
  );
}

export function main() {
  const NPM_CLI = findNpmCli();
  if (!NPM_CLI) {
    console.error(
      'check-lockfile: cannot locate npm-cli.js relative to process.execPath. Ensure npm is installed alongside node.',
    );
    return 2;
  }

  let firstFailure = null;

  // Phase 1 (fast): version-drift gate. Pure JSON parse, no subprocess.
  // Catches PR #286-class bugs that `npm ci --dry-run` does not.
  for (const workspace of WORKSPACES) {
    if (!existsSync(workspace.manifest) || !existsSync(workspace.lockfile)) {
      console.error(
        `check-lockfile: missing manifest or lockfile for workspace '${workspace.name}'`,
      );
      return 2;
    }
    let pkg;
    let lock;
    try {
      pkg = JSON.parse(readFileSync(workspace.manifest, 'utf8'));
      lock = JSON.parse(readFileSync(workspace.lockfile, 'utf8'));
    } catch (err) {
      console.error(
        `check-lockfile: failed to parse JSON for workspace '${workspace.name}': ${err instanceof Error ? err.message : String(err)}`,
      );
      return 2;
    }
    const detail = checkVersionInSync(pkg, lock);
    if (detail !== null) {
      process.stdout.write(`check-lockfile: validating workspace '${workspace.name}' ... FAIL\n`);
      printVersionDriftMessage(workspace, detail);
      firstFailure = { kind: 'version-drift' };
    }
  }
  if (firstFailure) {
    return 1;
  }

  // Phase 2 (slow): dependency-tree gate via `npm ci --dry-run`.
  for (const workspace of WORKSPACES) {
    process.stdout.write(`check-lockfile: validating workspace '${workspace.name}' ... `);
    const result = runDryRun(NPM_CLI, workspace);

    if (result.ok) {
      process.stdout.write('OK\n');
      continue;
    }

    process.stdout.write('FAIL\n');
    // Stream npm's own output verbatim so the user sees the actual error first.
    if (result.stdout) {
      process.stdout.write(result.stdout);
      if (!result.stdout.endsWith('\n')) process.stdout.write('\n');
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
      if (!result.stderr.endsWith('\n')) process.stderr.write('\n');
    }

    if (result.kind === 'drift') {
      printDriftMessage(workspace);
    } else if (result.kind === 'spawn') {
      console.error('');
      console.error(
        `check-lockfile: failed to spawn npm for workspace '${workspace.name}': ${result.stderr}`,
      );
    } else {
      printOtherFailureMessage(workspace, result.status);
    }

    if (!firstFailure) {
      firstFailure = result;
    }
    // Continue to the next workspace so the user sees both reports in one run.
  }

  if (firstFailure) {
    return 1;
  }

  console.log('check-lockfile: OK (root + api/ lockfiles match their manifests)');
  return 0;
}

// Only invoke main() when this file is executed directly. Importers
// (the test file at scripts/check-lockfile.test.mjs) load the module
// solely for its exports; they must not trigger the CLI side effects
// (spawnSync npm, process.exit).
const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exit(main());
}
