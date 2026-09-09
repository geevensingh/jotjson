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
 *   - `file:` sources -> a local path; there is no host to check.
 *   - everything else -> must be a public-registry tarball. Must carry
 *                        both `resolved` and a non-empty `integrity`, and
 *                        must satisfy the provenance rules below.
 *
 * Provenance (PR #534). Presence is not enough: a `resolved` URL must name
 * `registry.npmjs.org` over https, with no userinfo, query string, or
 * fragment, and `integrity` must be sha512.
 *
 * This deliberately forbids **remote tarballs from any other host**, even
 * with valid integrity. An arbitrary HTTPS tarball is a dependency that
 * Dependabot cannot version-update or security-patch and that `npm audit`
 * cannot see -- a package nobody is watching, which is the exact failure
 * class behind issues #514 and #533. The repo has none today (1248/1248
 * root entries are public-registry), so this codifies the existing state.
 * If one is ever genuinely required, relax this gate deliberately and
 * record the justification, the same way root `overrides` are classified
 * in `scripts/check-dependency-overrides.mjs`.
 *
 * Presence, not grammar: we deliberately do not validate the SRI string
 * beyond its algorithm prefix. Hash *correctness* is `npm ci`'s job -- it
 * verifies each tarball on download. Re-implementing npm's accepted
 * integrity grammar here would risk false positives for no added signal.
 *
 * Offenders carry a `kind`: `missing` (issue #509 -- fix by regenerating)
 * or `provenance` (PR #534 -- fix in place; regenerating would float
 * unrelated versions). `printMetadataMessage` reports them separately
 * because the remediations are opposites.
 *
 * Exported for unit-testing under `scripts/check-lockfile.test.mjs`.
 *
 * @param {unknown} lock - parsed package-lock.json contents
 * @returns {{ path: string, kind: 'missing' | 'provenance', reason: string }[]}
 *   offenders, sorted by path
 */
export function checkMetadataFields(lock) {
  if (typeof lock !== 'object' || lock === null) {
    return [
      { path: '<file>', kind: 'missing', reason: 'package-lock.json did not parse to an object' },
    ];
  }
  const packages = /** @type {Record<string, unknown>} */ (lock).packages;
  if (typeof packages !== 'object' || packages === null) {
    return [
      {
        path: '<file>',
        kind: 'missing',
        reason: 'package-lock.json is missing the `packages` map',
      },
    ];
  }

  const nonEmptyString = (value) => typeof value === 'string' && value.length > 0;
  const offenders = [];

  for (const path of Object.keys(packages).sort()) {
    // The root entry ("") and workspace roots have no artifact of their own.
    if (!path.startsWith('node_modules/')) continue;

    const entry = /** @type {Record<string, unknown>} */ (packages)[path];
    if (typeof entry !== 'object' || entry === null) {
      offenders.push({ path, kind: 'missing', reason: 'entry is not an object' });
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
        kind: 'missing',
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
          kind: 'missing',
          reason: 'git source is not pinned to a 40-hex commit SHA',
        });
      }
      continue;
    }

    if (!hasIntegrity) {
      offenders.push({ path, kind: 'missing', reason: 'missing `integrity`' });
      continue;
    }

    // Registry provenance. `npm ci` happily installs whatever host the
    // lockfile names, so a private-mirror URL is silently non-reproducible
    // for anyone who cannot reach that host -- and it can leak internal
    // infrastructure names into a public repo.
    //
    // This is the sibling of the issue #509 shape above: that gate catches
    // metadata that is *missing*, this one catches metadata that is
    // *wrong*. Both are invariants `npm ci` does not enforce. They are
    // tagged with different `kind`s because they need opposite fixes --
    // see `printMetadataMessage`.
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
      let url = null;
      try {
        url = new URL(resolved);
      } catch {
        // Deliberately does NOT echo `resolved`. A malformed value can
        // still contain a token, and this reason string lands in public CI
        // logs. `path` already tells the reader which entry to open.
        offenders.push({
          path,
          kind: 'provenance',
          reason: '`resolved` is not a parsable URL',
        });
        continue;
      }
      if (url.host !== PUBLIC_REGISTRY_HOST) {
        offenders.push({
          path,
          kind: 'provenance',
          reason:
            `\`resolved\` points at '${url.host}', not '${PUBLIC_REGISTRY_HOST}'. ` +
            `If this came from a corporate mirror, re-resolve with ` +
            `\`--registry=https://${PUBLIC_REGISTRY_HOST}/\`. Remote tarballs from ` +
            `other hosts are not allowed: Dependabot and npm audit cannot see them.`,
        });
        continue;
      }
      // Host alone is not provenance. `http://` downgrades the fetch to
      // cleartext, and embedded credentials would be committed in plain
      // text to a public repo -- both while naming the right host.
      if (url.protocol !== 'https:') {
        offenders.push({
          path,
          kind: 'provenance',
          reason: `\`resolved\` uses '${url.protocol}//', expected 'https://'`,
        });
        continue;
      }
      if (url.username !== '' || url.password !== '') {
        offenders.push({
          path,
          kind: 'provenance',
          reason: '`resolved` embeds credentials in the URL; strip the userinfo component',
        });
        continue;
      }
      // A query string or fragment is the other place a token can hide
      // (`...x-1.0.0.tgz?token=...`), and it clears the host, scheme, and
      // userinfo checks above. Registry tarball URLs are plain paths, so
      // anything here is unexpected. The value is not echoed, for the same
      // reason as the parse-failure branch.
      if (url.search !== '' || url.hash !== '') {
        offenders.push({
          path,
          kind: 'provenance',
          reason:
            '`resolved` carries a query string or fragment; registry tarball URLs are ' +
            'plain paths, and these can smuggle a credential',
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
        kind: 'provenance',
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
  // Two failure shapes with OPPOSITE fixes share this reporter, so they are
  // reported separately. Missing metadata (issue #509) is repaired by
  // regenerating the lockfile from scratch. Invalid provenance or a weak
  // digest (PR #534) must NOT be -- the metadata is present, so a full
  // regeneration would re-resolve every range and float versions, turning
  // a metadata fix into an unreviewed dependency bump (AGENTS.md Section 7
  // #13). Printing the regeneration recipe for those would actively cause
  // the harm the supply-chain doc warns about.
  const missing = offenders.filter((offender) => offender.kind !== 'provenance');
  const provenance = offenders.filter((offender) => offender.kind === 'provenance');

  const listOffenders = (list) => {
    const shown = list.slice(0, MAX_REPORTED_OFFENDERS);
    for (const offender of shown) {
      console.error(`    ${offender.path} - ${offender.reason}`);
    }
    if (list.length > shown.length) {
      console.error(`    ... showing first ${shown.length} of ${list.length}`);
    }
  };

  if (missing.length > 0) {
    console.error('');
    console.error(`check-lockfile: FAILED for workspace '${workspace.name}' (missing metadata)`);
    console.error(
      `  ${missing.length} entr${missing.length === 1 ? 'y' : 'ies'} lack${missing.length === 1 ? 's' : ''} the \`resolved\`/\`integrity\` that pin what npm downloads.`,
    );
    listOffenders(missing);
    console.error('  Common cause: regenerating the lockfile while `node_modules` was present,');
    console.error('  which makes npm rebuild entries from the on-disk tree (no metadata there).');
    console.error('  Fix (order matters - `node_modules` MUST be absent), from the repo root:');
    printRegenerationSteps(workspace);
  }

  if (provenance.length > 0) {
    console.error('');
    console.error(
      `check-lockfile: FAILED for workspace '${workspace.name}' (invalid provenance/digest)`,
    );
    console.error(
      `  ${provenance.length} entr${provenance.length === 1 ? 'y' : 'ies'} ${provenance.length === 1 ? 'has' : 'have'} metadata, but it does not name the public registry over https with a sha512 digest.`,
    );
    listOffenders(provenance);
    console.error('  Common cause: your npm registry points at a corporate proxy, so');
    console.error('  re-resolving rewrote `resolved` to the proxy host and recorded the');
    console.error('  legacy sha1 `shasum` it advertises instead of `dist.integrity`.');
    console.error('  Fix: repair these entries IN PLACE - do NOT regenerate the lockfile,');
    console.error('  which would re-resolve every range and float unrelated versions.');
    console.error('  For each entry, take the canonical values from the public registry:');
    console.error(
      `    npm view <name>@<version> dist.tarball dist.integrity --registry=https://${PUBLIC_REGISTRY_HOST}/ --json`,
    );
    console.error('  then write them back as `resolved` and `integrity`. Afterwards confirm');
    console.error("  no entry's `version` changed. See docs/supply-chain.md ->");
    console.error('  "Registry provenance in the lockfile".');
  }
}

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
    // Exact-pinned transitives. None of these appear in package.json, which
    // is precisely why they need asserting: @vitest/browser carried two
    // critical advisories (#533) while invisible on the manifest. `vitest`
    // itself pins the rest of this list at its own exact version, so any
    // one of them going stale is the same class of drift.
    followers: [
      '@vitest/browser',
      '@vitest/expect',
      '@vitest/mocker',
      '@vitest/pretty-format',
      '@vitest/runner',
      '@vitest/snapshot',
      '@vitest/spy',
      '@vitest/utils',
    ],
    issue: '#533',
  },
  // The Angular runtime + devkit peer-lock at an exact version:
  // @angular/core peers @angular/compiler exactly, @angular/compiler-cli
  // peers @angular/compiler exactly, @angular/router peers common /core /
  // platform-browser exactly, and so on. `.github/dependabot.yml` has
  // grouped them since before this gate existed; this is the matching
  // detection half.
  //
  // No `followers`: unlike @vitest/browser, every member of this family is
  // declared in package.json, so there is no exact-pinned transitive
  // hiding behind a parent.
  {
    name: 'angular',
    workspace: 'root',
    declared: [
      '@angular/animations',
      '@angular/common',
      '@angular/compiler',
      '@angular/compiler-cli',
      '@angular/core',
      '@angular/forms',
      '@angular/localize',
      '@angular/platform-browser',
      '@angular/platform-server',
      '@angular/router',
      '@angular/ssr',
      '@angular/cli',
      '@angular-devkit/build-angular',
    ],
    followers: [],
  },
  // Material and CDK peer-lock to each other exactly but ship on their own
  // release cadence, which is why dependabot.yml carves them out of the
  // `angular` group. Same split here so a Material bump is not reported as
  // Angular-runtime drift.
  {
    name: 'material',
    workspace: 'root',
    declared: ['@angular/material', '@angular/cdk'],
    followers: [],
  },
  // Playwright is exact-linked rather than peer-locked: @playwright/test
  // depends on `playwright` at an exact version, which depends on
  // `playwright-core` at an exact version. The lockstep requirement is the
  // same, so it belongs here.
  //
  // It matters beyond tidiness. `.github/actions/install-playwright-chromium`
  // derives the CI cache key from the resolved root `playwright` version and
  // is used by BOTH the e2e job and the Vitest browser-mode unit tests, so
  // this family determines the exact Chromium binary the suite runs against.
  // Issue #533 deliberately held it at 1.60.0 to keep the browser out of the
  // runner upgrade as a confounding variable; #537 tracks moving it, and the
  // whole family must move together.
  {
    name: 'playwright',
    workspace: 'root',
    declared: ['playwright', '@playwright/test'],
    followers: ['playwright-core'],
    issue: '#537',
  },
];

/**
 * Renders a family's tracking-issue reference, or nothing when it has none.
 *
 * `issue` is optional on purpose: the Angular and Material families are
 * long-standing and have no single tracking issue, and stamping them with
 * the Vitest remediation issue would point a maintainer at unrelated
 * history. `printPeerLockedFamilyMessage` always prints the
 * docs/supply-chain.md pointer, so a family without an issue still has
 * somewhere to go.
 */
function issueSuffix(family) {
  return family.issue ? ` (${family.issue})` : '';
}

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

    // A family that is not used here at all is not drift -- skip it. A
    // family that is only PARTIALLY declared still falls through to the
    // per-member check below, because dropping one member of an
    // exact-peer-locked set is exactly the failure this gate exists for.
    const declaredHere = family.declared.filter(
      (name) => typeof (pkg?.devDependencies?.[name] ?? pkg?.dependencies?.[name]) === 'string',
    );
    if (declaredHere.length === 0) continue;

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
          `partial bump cannot resolve -- npm will ERESOLVE on install.${issueSuffix(family)}`,
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
      // npm legitimately nests a duplicate copy when peer contexts differ.
      // What matters for an exact-peer-locked family is that every copy is
      // the SAME version: identical copies cannot carry a stale advisory,
      // which is the whole reason this check exists. Only divergent copies
      // are a problem, so compare versions rather than counting entries.
      const versions = [...new Set(entries.map((key) => packages[key]?.version))];
      if (versions.length > 1) {
        const detail = entries.map((key) => `${key}@${packages[key]?.version}`).join(', ');
        problems.push(
          `${family.name} family: '${name}' resolves to ${entries.length} copies at ` +
            `differing versions (${detail}). Every copy must be the same version -- ` +
            `otherwise one is an unwatched duplicate that can silently carry an ` +
            `advisory.${issueSuffix(family)}`,
        );
        continue;
      }
      resolved.set(name, versions[0]);
    }
    const distinctResolved = new Set(resolved.values());
    if (distinctResolved.size > 1) {
      const detail = [...resolved].map(([n, v]) => `${n}@${v}`).join(', ');
      problems.push(
        `${family.name} family: resolved versions diverge (${detail}). ` +
          `Every member -- including transitives not named in package.json -- ` +
          `must be at the same version.${issueSuffix(family)}`,
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
