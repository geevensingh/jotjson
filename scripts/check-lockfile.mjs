#!/usr/bin/env node
// Verifies that both workspace lockfiles (root and `api/`) are in sync with
// their respective `package.json` files. Catches the class of bug introduced
// by `npm install --legacy-peer-deps` or `--force` overrides that omit
// transitive optional-peer entries which `npm ci` on Linux later rejects.
//
// Implementation: runs `npm ci --dry-run --no-audit --no-fund` against each
// workspace. `npm ci` errors if the lockfile and manifest disagree, and
// `--dry-run` does not skip that sanity check; it just doesn't write to
// `node_modules` or the working tree. ~2s per workspace on a clean tree.
//
// Two failure modes:
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
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const WORKSPACES = [
  { name: 'root', prefix: null, lockfile: 'package-lock.json' },
  { name: 'api/', prefix: 'api', lockfile: 'api/package-lock.json' },
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

const NPM_CLI = findNpmCli();
if (!NPM_CLI) {
  console.error(
    'check-lockfile: cannot locate npm-cli.js relative to process.execPath. Ensure npm is installed alongside node.',
  );
  process.exit(2);
}

function runDryRun(workspace) {
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

let firstFailure = null;

for (const workspace of WORKSPACES) {
  if (!existsSync(workspace.lockfile)) {
    console.error(
      `check-lockfile: missing lockfile for workspace '${workspace.name}': ${workspace.lockfile}`,
    );
    process.exit(2);
  }

  process.stdout.write(`check-lockfile: validating workspace '${workspace.name}' ... `);
  const result = runDryRun(workspace);

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
  process.exit(1);
}

console.log('check-lockfile: OK (root + api/ lockfiles match their manifests)');
process.exit(0);
