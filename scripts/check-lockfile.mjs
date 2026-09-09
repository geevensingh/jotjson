#!/usr/bin/env node
// Verifies that both workspace lockfiles (root and `api/`) are in sync with
// their respective `package.json` files. Catches three classes of bug:
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
//   (c) Missing `resolved`/`integrity` metadata. Issue #509: 742 of the
//       root lockfile's 1140 `node_modules/*` entries had lost both
//       fields, so nothing pinned a tarball hash in version control.
//       npm still verifies downloads against the *live* packument, so
//       this is not "no checksum at all" -- but without a committed
//       hash npm cannot detect registry drift or a coordinated
//       packument-plus-artifact substitution. `npm ci --dry-run` does
//       NOT catch this: a lockfile with no integrity fields is still
//       perfectly tree-consistent.
//
// Phase 1 = (b) + (c): pure JSON parse, no subprocess, ~5ms. These are
// exactly the invariants `npm ci` does not enforce, which is why they are
// the ones worth running in CI. Phase 2 = (a): ~2s per workspace, and
// duplicates what CI's own `npm ci` step already does natively.
//
// `--metadata-only` runs Phase 1 alone. CI uses that (see the
// "Lint - Lockfile metadata" step in .github/workflows/ci.yml, which runs
// *before* `npm ci` because it needs no dependencies); the local `lint`
// chain runs the full gate once.
//
// How entries lose their metadata (issue #509 root cause): Arborist takes
// `resolved`/`integrity` from registry packuments. When it builds the ideal
// tree from the on-disk `node_modules` tree instead, nodes carry neither --
// npm >= 7 stopped writing `_resolved`/`_integrity` into installed
// package.json files -- and they get written back stripped. Deleting the
// lockfile while `node_modules` is still present triggers exactly that path
// (`build-ideal-tree.js` falls back to `loadActual()` when no lockfile was
// loaded from disk). Nothing repairs it afterwards: the one code path that
// re-fetches metadata only fires for lockfileVersion < 2. Hence the fix
// messages below insist on removing `node_modules` first.
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
//   npm run lint:lockfile           (full gate: Phase 1 + Phase 2)
//   npm run lint:lockfile-metadata  (Phase 1 only)

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The only tarball host a committed lockfile may name.
 *
 * Corporate npm proxies (Azure DevOps feeds, Artifactory, Verdaccio) rewrite
 * `resolved` to their own URL when they serve a package. That is fine for a
 * local install and poison in a committed lockfile: contributors and CI
 * outside that network cannot resolve it, and the host name itself may be
 * internal. See `checkMetadataFields` for the full failure story (PR #534).
 */
const PUBLIC_REGISTRY_HOST = 'registry.npmjs.org';

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
 * Pure function: verifies that every `node_modules/*` entry in a lockfile
 * carries the metadata that pins what npm will actually download --
 * `resolved` (where the artifact comes from) and `integrity` (its hash).
 *
 * Issue #509: 742 of the root lockfile's 1140 entries had lost both. See
 * the file header for how that happens and why `npm ci --dry-run` cannot
 * detect it.
 *
 * Policy is by artifact type, not by string prefix, so the gate does not
 * false-positive on legitimately hash-less entries:
 *
 *   - `link: true`    -> a symlink to a local path (workspace or `file:`
 *                        dep). There is no tarball, so no hash exists.
 *   - `inBundle: true`-> ships inside the parent package's tarball, which
 *                        is itself hashed. No independent source.
 *   - git sources     -> npm records no registry integrity for these. We
 *                        instead require the ref to be pinned to an
 *                        immutable 40-hex commit SHA; a mutable ref such
 *                        as `#main` is exactly as unverifiable as a
 *                        missing hash, so it fails.
 *   - everything else -> registry, remote tarball, or local tarball. Must
 *                        carry both `resolved` and a non-empty `integrity`.
 *
 * Presence, not grammar: we deliberately do not validate the SRI string
 * beyond non-emptiness. Hash *correctness* is `npm ci`'s job -- it verifies
 * each tarball on download. Re-implementing npm's accepted integrity
 * grammar here would risk false positives for no added signal.
 *
 * Exported for unit-testing under `scripts/check-lockfile.test.mjs`.
 *
 * @param {unknown} lock - parsed package-lock.json contents
 * @returns {{ path: string, reason: string }[]} offenders, sorted by path
 */
export function checkMetadataFields(lock) {
  if (typeof lock !== 'object' || lock === null) {
    return [{ path: '<file>', reason: 'package-lock.json did not parse to an object' }];
  }
  const packages = /** @type {Record<string, unknown>} */ (lock).packages;
  if (typeof packages !== 'object' || packages === null) {
    return [{ path: '<file>', reason: 'package-lock.json is missing the `packages` map' }];
  }

  const nonEmptyString = (value) => typeof value === 'string' && value.length > 0;
  const offenders = [];

  for (const path of Object.keys(packages).sort()) {
    // The root entry ("") and workspace roots have no artifact of their own.
    if (!path.startsWith('node_modules/')) continue;

    const entry = /** @type {Record<string, unknown>} */ (packages)[path];
    if (typeof entry !== 'object' || entry === null) {
      offenders.push({ path, reason: 'entry is not an object' });
      continue;
    }
    const record = /** @type {Record<string, unknown>} */ (entry);
    if (record['link'] === true || record['inBundle'] === true) continue;

    const resolved = record['resolved'];
    const hasIntegrity = nonEmptyString(record['integrity']);
    if (!nonEmptyString(resolved)) {
      // Report both fields when both are gone -- that is the issue #509
      // shape, and naming only `resolved` would send someone off to fix
      // half the problem and re-run into the other half.
      offenders.push({
        path,
        reason: hasIntegrity ? 'missing `resolved`' : 'missing `resolved` and `integrity`',
      });
      continue;
    }

    // Git sources: npm stores no integrity, so an immutable commit SHA is
    // the only thing that pins the content.
    if (/^git(\+|:)/.test(resolved)) {
      if (!/#[0-9a-f]{40}$/.test(resolved)) {
        offenders.push({
          path,
          reason: 'git source is not pinned to a 40-hex commit SHA',
        });
      }
      continue;
    }

    if (!hasIntegrity) {
      offenders.push({ path, reason: 'missing `integrity`' });
      continue;
    }

    // Registry provenance. `npm ci` happily installs whatever host the
    // lockfile names, so a private-mirror URL is silently non-reproducible
    // for anyone who cannot reach that host -- and it can leak internal
    // infrastructure names into a public repo.
    //
    // This is the sibling of the issue #509 shape above: that gate catches
    // metadata that is *missing*, this one catches metadata that is
    // *wrong*. Both are invariants `npm ci` does not enforce.
    //
    // How it happens (observed on PR #534): a contributor or agent whose
    // `npm config get registry` points at a corporate proxy re-resolves
    // part of the tree. npm rewrites `resolved` to the proxy's tarball URL
    // and records whatever digest the proxy advertises -- for an Azure
    // DevOps feed that is the legacy `shasum`, so `integrity` silently
    // degrades from sha512 to sha1. CI still passed, because the proxy was
    // publicly reachable; the damage was reproducibility, provenance, and
    // digest strength, none of which any existing gate checked.
    if (!/^file:/.test(resolved)) {
      let host = null;
      try {
        host = new URL(resolved).host;
      } catch {
        offenders.push({ path, reason: `\`resolved\` is not a parsable URL: ${resolved}` });
        continue;
      }
      if (host !== PUBLIC_REGISTRY_HOST) {
        offenders.push({
          path,
          reason:
            `\`resolved\` points at '${host}', not '${PUBLIC_REGISTRY_HOST}'. ` +
            `Re-resolve with \`--registry=https://${PUBLIC_REGISTRY_HOST}/\`.`,
        });
        continue;
      }
    }

    // Digest strength. npm accepts sha1 for backwards compatibility, but
    // every entry the public registry serves today carries sha512, so a
    // sha1 entry means the metadata came from somewhere else.
    const integrity = String(record['integrity']);
    if (!integrity.startsWith('sha512-')) {
      offenders.push({
        path,
        reason: `\`integrity\` is '${integrity.split('-')[0]}', expected 'sha512'`,
      });
    }
  }

  return offenders;
}

/** Number of offending entries listed before truncating the report. */
const MAX_REPORTED_OFFENDERS = 10;
/**
 * Prints the safe lockfile-regeneration recipe for a workspace.
 *
 * The lines are written to be pasted and run **in sequence from the repo
 * root**. An earlier revision prefixed each line with `cd api; `, which only
 * works for the first line: `cd` persists, so the second would try to enter
 * `api/api` and fail. Root-relative paths plus `npm --prefix` avoid that, and
 * match how the repo drives the api/ workspace elsewhere (CI runs
 * `npm --prefix api ci`).
 *
 * Removing `node_modules` and passing `--ignore-scripts` are both
 * load-bearing -- see the file header for why omitting either is what
 * produced issue #509.
 */
function printRegenerationSteps(workspace) {
  const nodeModules = workspace.prefix ? `${workspace.prefix}/node_modules` : 'node_modules';
  const prefixArg = workspace.prefix ? `--prefix ${workspace.prefix} ` : '';
  console.error(`    Remove-Item -Recurse -Force ${nodeModules}`);
  console.error(`    Remove-Item ${workspace.lockfile}`);
  console.error(`    npm ${prefixArg}install --package-lock-only --ignore-scripts`);
  console.error(`    git add ${workspace.lockfile}`);
}

function printMetadataMessage(workspace, offenders) {
  console.error('');
  console.error(`check-lockfile: FAILED for workspace '${workspace.name}' (missing metadata)`);
  console.error(
    `  ${offenders.length} entr${offenders.length === 1 ? 'y' : 'ies'} lack${offenders.length === 1 ? 's' : ''} the \`resolved\`/\`integrity\` that pin what npm downloads.`,
  );
  const shown = offenders.slice(0, MAX_REPORTED_OFFENDERS);
  for (const offender of shown) {
    console.error(`    ${offender.path} - ${offender.reason}`);
  }
  if (offenders.length > shown.length) {
    console.error(`    ... showing first ${shown.length} of ${offenders.length}`);
  }
  console.error('  Common cause: regenerating the lockfile while `node_modules` was present,');
  console.error('  which makes npm rebuild entries from the on-disk tree (no metadata there).');
  console.error('  Fix (order matters - `node_modules` MUST be absent), from the repo root:');
  printRegenerationSteps(workspace);
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
/**
 * Peer-locked families: sets of packages whose members peer-depend on
 * each other at an EXACT version, so a partial bump cannot resolve.
 *
 * `.github/dependabot.yml` groups each family so Dependabot proposes
 * them together, but a group only constrains Dependabot's
 * version-update output. It cannot constrain a security-update PR, a
 * human, or an agent session. This gate is the detection half: it runs
 * in Phase 1 (pure JSON parse, before `npm ci`) and fails loudly on a
 * partial bump from ANY inbound path.
 *
 * `declared` are the root devDependencies whose ranges must match.
 * `followers` are transitive packages pinned exactly by a declared
 * member -- they are not in `package.json` at all, which is exactly why
 * they need asserting: `@vitest/browser` carried two critical
 * advisories (issue #533) while being invisible on the manifest.
 *
 * See docs/supply-chain.md -> "Peer-locked dependency families".
 */
export const PEER_LOCKED_FAMILIES = [
  {
    name: 'vitest',
    workspace: 'root',
    declared: ['vitest', '@vitest/browser-playwright', '@vitest/coverage-v8'],
    followers: ['@vitest/browser'],
    issue: '#533',
  },
];

/**
 * Verifies every peer-locked family in `pkg`/`lock` moves in lockstep.
 * Returns an array of human-readable problem strings; empty means OK.
 */
export function checkPeerLockedFamilies(pkg, lock, workspaceName) {
  const problems = [];
  const packages = lock?.packages;
  if (typeof packages !== 'object' || packages === null) return problems;

  for (const family of PEER_LOCKED_FAMILIES) {
    if (family.workspace !== workspaceName) continue;

    // 1. Declared ranges must be identical across the family.
    const ranges = new Map();
    for (const name of family.declared) {
      const range = pkg?.devDependencies?.[name] ?? pkg?.dependencies?.[name];
      if (typeof range !== 'string') {
        problems.push(
          `${family.name} family: '${name}' is not declared in package.json. ` +
            `All of [${family.declared.join(', ')}] must be declared together.`,
        );
        continue;
      }
      ranges.set(name, range);
    }
    const distinctRanges = new Set(ranges.values());
    if (distinctRanges.size > 1) {
      const detail = [...ranges].map(([n, r]) => `${n}=${r}`).join(', ');
      problems.push(
        `${family.name} family: declared ranges diverge (${detail}). ` +
          `These packages peer-depend on each other at an exact version, so a ` +
          `partial bump cannot resolve -- npm will ERESOLVE on install (${family.issue}).`,
      );
    }

    // 2. Resolved versions must be identical, across declared AND followers,
    //    and each must appear exactly once (a nested duplicate means one copy
    //    is unwatched -- the shape that hides an open advisory).
    const resolved = new Map();
    for (const name of [...family.declared, ...family.followers]) {
      const suffix = `node_modules/${name}`;
      const entries = Object.keys(packages).filter(
        (key) => key === suffix || key.endsWith(`/${suffix}`),
      );
      if (entries.length === 0) {
        problems.push(`${family.name} family: '${name}' has no entry in the lockfile.`);
        continue;
      }
      if (entries.length > 1) {
        problems.push(
          `${family.name} family: '${name}' resolves to ${entries.length} copies ` +
            `(${entries.join(', ')}). Exactly one is required -- a nested duplicate ` +
            `leaves a second, unwatched copy that can silently carry an advisory (${family.issue}).`,
        );
        continue;
      }
      resolved.set(name, packages[entries[0]]?.version);
    }
    const distinctResolved = new Set(resolved.values());
    if (distinctResolved.size > 1) {
      const detail = [...resolved].map(([n, v]) => `${n}@${v}`).join(', ');
      problems.push(
        `${family.name} family: resolved versions diverge (${detail}). ` +
          `Every member -- including transitives not named in package.json -- ` +
          `must be at the same version (${family.issue}).`,
      );
    }
  }
  return problems;
}

function printPeerLockedFamilyMessage(workspace, problems) {
  console.error('');
  console.error(`check-lockfile: FAILED for workspace '${workspace.name}' (peer-locked family)`);
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  console.error('  Fix: bump every member of the family to the same version in one change.');
  console.error('    See docs/supply-chain.md -> "Peer-locked dependency families".');
}

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
  // `--ignore-scripts` because this is a validation-only dry run: npm still
  // fires root lifecycle scripts (`prepare` -> husky) even under --dry-run,
  // which fails outright in a fresh clone where node_modules does not exist
  // yet. Lifecycle scripts prove nothing about lockfile consistency, and
  // running arbitrary install scripts from inside a lint gate is a
  // supply-chain hazard in its own right.
  args.push('ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund');

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
  console.error('');
  console.error(`check-lockfile: FAILED for workspace '${workspace.name}'`);
  console.error('  Lockfile is out of sync with package.json. Common causes:');
  console.error('    - Used `npm install --legacy-peer-deps` or `--force`');
  console.error('      (forbidden by AGENTS.md without explicit user approval)');
  console.error('    - Hand-edited the lockfile');
  console.error('    - Bad merge of package*.json');
  console.error('  Fix, from the repo root:');
  printRegenerationSteps(workspace);
}

function printOtherFailureMessage(workspace, status) {
  console.error('');
  console.error(
    `check-lockfile: 'npm ci --dry-run' failed for workspace '${workspace.name}' (exit ${status}); see npm output above`,
  );
}

export function main(argv = process.argv.slice(2)) {
  const metadataOnly = argv.includes('--metadata-only');

  let firstFailure = null;

  // Phase 1 (fast): the invariants `npm ci` does NOT enforce -- root
  // `version` drift and `resolved`/`integrity` presence. Pure JSON parse,
  // no subprocess. This is the phase CI runs on its own, before `npm ci`.
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
    // A workspace can fail both sub-gates at once; print its FAIL header
    // once and then every reason under it.
    const versionDrift = checkVersionInSync(pkg, lock);
    const offenders = checkMetadataFields(lock);
    const familyProblems = checkPeerLockedFamilies(pkg, lock, workspace.name);
    if (versionDrift !== null || offenders.length > 0 || familyProblems.length > 0) {
      process.stdout.write(`check-lockfile: validating workspace '${workspace.name}' ... FAIL\n`);
      if (versionDrift !== null) {
        printVersionDriftMessage(workspace, versionDrift);
      }
      if (offenders.length > 0) {
        printMetadataMessage(workspace, offenders);
      }
      if (familyProblems.length > 0) {
        printPeerLockedFamilyMessage(workspace, familyProblems);
      }
      firstFailure = {
        kind:
          versionDrift !== null
            ? 'version-drift'
            : offenders.length > 0
              ? 'metadata'
              : 'peer-locked-family',
      };
    }
  }
  if (firstFailure) {
    return 1;
  }

  if (metadataOnly) {
    console.log(
      'check-lockfile: OK (root + api/ lockfile metadata: version, resolved, integrity; peer-locked families in lockstep)',
    );
    return 0;
  }

  // Phase 2 (slow): dependency-tree gate via `npm ci --dry-run`.
  const NPM_CLI = findNpmCli();
  if (!NPM_CLI) {
    console.error(
      'check-lockfile: cannot locate npm-cli.js relative to process.execPath. Ensure npm is installed alongside node.',
    );
    return 2;
  }

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
