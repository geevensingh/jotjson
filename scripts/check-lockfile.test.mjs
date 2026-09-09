// Unit tests for scripts/check-lockfile.mjs.
//
// Runs under Node's built-in test runner: `node --test`. No external
// dependencies. The test file imports the script as a module; the script
// guards `main()` behind an "invoked directly" check so importing it does
// not trigger CLI side effects (spawnSync npm, process.exit).
//
// Coverage focuses on `checkVersionInSync` -- the version-drift gate
// added in response to PR #286 review feedback -- and
// `checkMetadataFields` -- the resolved/integrity gate added in response
// to issue #509. The dependency-tree gate (Phase 2, `npm ci --dry-run`)
// is exercised end-to-end by the real `npm run lint:lockfile` and is not
// unit-tested here.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

import {
  checkMetadataFields,
  checkPeerLockedFamilies,
  checkVersionInSync,
  PEER_LOCKED_FAMILIES,
} from './check-lockfile.mjs';

/**
 * Builds a manifest + lockfile pair describing a healthy vitest family,
 * so each test below can perturb exactly one thing.
 */
function vitestFixture(version = '4.1.11', range = '^4.1.11') {
  const members = [
    'vitest',
    '@vitest/browser-playwright',
    '@vitest/coverage-v8',
    '@vitest/browser',
  ];
  const packages = { '': { version: '1.0.0' } };
  for (const name of members) packages[`node_modules/${name}`] = { version };
  return {
    pkg: {
      devDependencies: {
        vitest: range,
        '@vitest/browser-playwright': range,
        '@vitest/coverage-v8': range,
      },
    },
    lock: { packages },
  };
}

test('checkPeerLockedFamilies passes on a healthy family', () => {
  const { pkg, lock } = vitestFixture();
  assert.deepEqual(checkPeerLockedFamilies(pkg, lock, 'root'), []);
});

test('checkPeerLockedFamilies ignores workspaces it does not govern', () => {
  const { pkg, lock } = vitestFixture();
  pkg.devDependencies['@vitest/coverage-v8'] = '^4.1.7';
  assert.deepEqual(checkPeerLockedFamilies(pkg, lock, 'api/'), []);
});

test('checkPeerLockedFamilies flags divergent declared ranges', () => {
  const { pkg, lock } = vitestFixture();
  pkg.devDependencies['@vitest/coverage-v8'] = '^4.1.7';
  const problems = checkPeerLockedFamilies(pkg, lock, 'root');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /declared ranges diverge/);
  assert.match(problems[0], /#533/);
});

test('checkPeerLockedFamilies flags a stale transitive follower', () => {
  const { pkg, lock } = vitestFixture();
  lock.packages['node_modules/@vitest/browser'].version = '4.1.7';
  const problems = checkPeerLockedFamilies(pkg, lock, 'root');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /resolved versions diverge/);
  assert.match(problems[0], /@vitest\/browser@4\.1\.7/);
});

test('checkPeerLockedFamilies flags a nested duplicate copy', () => {
  const { pkg, lock } = vitestFixture();
  lock.packages['node_modules/vitest/node_modules/@vitest/browser'] = { version: '4.1.7' };
  const problems = checkPeerLockedFamilies(pkg, lock, 'root');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /resolves to 2 copies/);
});

test('checkPeerLockedFamilies flags an undeclared family member', () => {
  const { pkg, lock } = vitestFixture();
  delete pkg.devDependencies['@vitest/coverage-v8'];
  const problems = checkPeerLockedFamilies(pkg, lock, 'root');
  assert.ok(problems.some((p) => /is not declared in package\.json/.test(p)));
});

test('checkPeerLockedFamilies flags a family member missing from the lockfile', () => {
  const { pkg, lock } = vitestFixture();
  delete lock.packages['node_modules/@vitest/browser'];
  const problems = checkPeerLockedFamilies(pkg, lock, 'root');
  assert.ok(problems.some((p) => /has no entry in the lockfile/.test(p)));
});

test('checkPeerLockedFamilies tolerates a lockfile with no packages map', () => {
  assert.deepEqual(checkPeerLockedFamilies({}, {}, 'root'), []);
});

// A family absent from the manifest is not drift. A family that is only
// partially declared is, since dropping one member of an exact-peer-locked
// set is the failure this gate exists for.
test('checkPeerLockedFamilies skips a family that is entirely absent', () => {
  const { lock } = vitestFixture();
  assert.deepEqual(checkPeerLockedFamilies({ devDependencies: {} }, lock, 'root'), []);
});

test('checkPeerLockedFamilies still flags a partially declared family', () => {
  const { pkg, lock } = vitestFixture();
  delete pkg.devDependencies['@vitest/browser-playwright'];
  const problems = checkPeerLockedFamilies(pkg, lock, 'root');
  assert.ok(problems.some((p) => /@vitest\/browser-playwright.*not declared/.test(p)));
});

test('the real repo lockfile has every peer-locked family in lockstep', () => {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(resolve(repoRoot, 'package-lock.json'), 'utf8'));
  assert.deepEqual(checkPeerLockedFamilies(pkg, lock, 'root'), []);
});

test('PEER_LOCKED_FAMILIES covers every family the docs claim is asserted', () => {
  const names = PEER_LOCKED_FAMILIES.map((family) => family.name);
  for (const expected of ['vitest', 'angular', 'material']) {
    assert.ok(names.includes(expected), `missing peer-locked family '${expected}'`);
  }
});

test('checkPeerLockedFamilies flags a partial Angular-family bump', () => {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(resolve(repoRoot, 'package-lock.json'), 'utf8'));
  // Move one member and leave the rest behind -- the shape a single-package
  // Dependabot PR would produce for an exact-peer-locked family.
  lock.packages['node_modules/@angular/router'].version = '21.3.0';
  const problems = checkPeerLockedFamilies(pkg, lock, 'root');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^angular family: resolved versions diverge/);
});

// Registry provenance + digest strength (PR #534). A corporate npm proxy
// rewrites `resolved` to its own host and can downgrade `integrity` from
// sha512 to sha1; `npm ci` accepts both, so nothing else catches it.
function lockWithEntry(entry) {
  return { packages: { '': { version: '1.0.0' }, 'node_modules/x': entry } };
}

const GOOD_ENTRY = {
  version: '1.0.0',
  resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz',
  integrity: 'sha512-abc==',
};

test('checkMetadataFields accepts a public-registry sha512 entry', () => {
  assert.deepEqual(checkMetadataFields(lockWithEntry(GOOD_ENTRY)), []);
});

test('checkMetadataFields flags a private-mirror resolved host', () => {
  const offenders = checkMetadataFields(
    lockWithEntry({
      ...GOOD_ENTRY,
      resolved:
        'https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/x/-/x-1.0.0.tgz',
    }),
  );
  assert.equal(offenders.length, 1);
  assert.match(offenders[0].reason, /ms-feed-25\.pkgs\.visualstudio\.com/);
  assert.match(offenders[0].reason, /registry\.npmjs\.org/);
});

test('checkMetadataFields flags sha1 integrity', () => {
  const offenders = checkMetadataFields(
    lockWithEntry({ ...GOOD_ENTRY, integrity: 'sha1-u+EtyltO+YOg0K9LB7m8kOoKuro=' }),
  );
  assert.equal(offenders.length, 1);
  assert.match(offenders[0].reason, /'sha1', expected 'sha512'/);
});

test('checkMetadataFields flags an unparsable resolved URL', () => {
  const offenders = checkMetadataFields(lockWithEntry({ ...GOOD_ENTRY, resolved: 'not a url' }));
  assert.equal(offenders.length, 1);
  assert.match(offenders[0].reason, /not a parsable URL/);
});

// Host alone is not provenance: http:// downgrades the fetch to cleartext,
// and embedded credentials would be committed in plain text to a public repo.
// Both name the correct host, so a host-only check accepted them.
test('checkMetadataFields flags an http:// resolved URL on the right host', () => {
  const offenders = checkMetadataFields(
    lockWithEntry({ ...GOOD_ENTRY, resolved: 'http://registry.npmjs.org/x/-/x-1.0.0.tgz' }),
  );
  assert.equal(offenders.length, 1);
  assert.match(offenders[0].reason, /expected 'https:\/\/'/);
  assert.equal(offenders[0].kind, 'provenance');
});

test('checkMetadataFields flags credentials embedded in the resolved URL', () => {
  const offenders = checkMetadataFields(
    lockWithEntry({
      ...GOOD_ENTRY,
      resolved: 'https://user:token@registry.npmjs.org/x/-/x-1.0.0.tgz',
    }),
  );
  assert.equal(offenders.length, 1);
  assert.match(offenders[0].reason, /embeds credentials/);
  assert.equal(offenders[0].kind, 'provenance');
});

test('checkMetadataFields flags a username-only credential', () => {
  const offenders = checkMetadataFields(
    lockWithEntry({ ...GOOD_ENTRY, resolved: 'https://user@registry.npmjs.org/x/-/x-1.0.0.tgz' }),
  );
  assert.equal(offenders.length, 1);
  assert.match(offenders[0].reason, /embeds credentials/);
});

// A query string clears the host, scheme and userinfo checks, so it is the
// remaining place a token can hide in an otherwise well-formed URL.
test('checkMetadataFields flags a query string on the tarball URL', () => {
  const offenders = checkMetadataFields(
    lockWithEntry({
      ...GOOD_ENTRY,
      resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz?token=secret',
    }),
  );
  assert.equal(offenders.length, 1);
  assert.match(offenders[0].reason, /query string or fragment/);
  assert.equal(offenders[0].kind, 'provenance');
});

test('checkMetadataFields flags a fragment on the tarball URL', () => {
  const offenders = checkMetadataFields(
    lockWithEntry({ ...GOOD_ENTRY, resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz#frag' }),
  );
  assert.equal(offenders.length, 1);
  assert.match(offenders[0].reason, /query string or fragment/);
});

// These reason strings land in public CI logs, so they must never echo a
// value that could carry a secret.
test('checkMetadataFields does not echo secrets from offending URLs', () => {
  const cases = [
    'https://registry.npmjs.org/x/-/x-1.0.0.tgz?token=SUPERSECRET',
    'https://user:SUPERSECRET@registry.npmjs.org/x/-/x-1.0.0.tgz',
    'ht!tp://SUPERSECRET',
  ];
  for (const resolved of cases) {
    const offenders = checkMetadataFields(lockWithEntry({ ...GOOD_ENTRY, resolved }));
    assert.equal(offenders.length, 1, resolved);
    assert.ok(
      !offenders[0].reason.includes('SUPERSECRET'),
      `reason leaked the secret for ${resolved}: ${offenders[0].reason}`,
    );
  }
});

// The two shapes need opposite fixes, so the reporter branches on `kind`:
// missing metadata is repaired by regenerating, invalid provenance must be
// repaired in place or unrelated versions float.
test('checkMetadataFields tags missing vs provenance offenders distinctly', () => {
  const missing = checkMetadataFields(lockWithEntry({ version: '1.0.0' }));
  assert.equal(missing.length, 1);
  assert.equal(missing[0].kind, 'missing');

  const provenance = checkMetadataFields(lockWithEntry({ ...GOOD_ENTRY, integrity: 'sha1-abc=' }));
  assert.equal(provenance.length, 1);
  assert.equal(provenance[0].kind, 'provenance');
});

test('checkMetadataFields still allows file: and git+ sources', () => {
  assert.deepEqual(
    checkMetadataFields(
      lockWithEntry({ version: '1.0.0', resolved: 'file:../local', integrity: 'sha512-abc==' }),
    ),
    [],
  );
  assert.deepEqual(
    checkMetadataFields(
      lockWithEntry({
        version: '1.0.0',
        resolved: 'git+ssh://git@github.com/o/r.git#' + 'a'.repeat(40),
      }),
    ),
    [],
  );
});

// Deliberate: a remote tarball on another host is a dependency Dependabot
// and npm audit cannot see, even with valid integrity. Documented in
// checkMetadataFields' contract and docs/supply-chain.md.
test('checkMetadataFields rejects a remote tarball on another host despite valid sha512', () => {
  const offenders = checkMetadataFields(
    lockWithEntry({
      version: '1.0.0',
      resolved: 'https://example.com/pkg/-/pkg-1.0.0.tgz',
      integrity: 'sha512-abc==',
    }),
  );
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].kind, 'provenance');
  assert.match(offenders[0].reason, /example\.com/);
  assert.match(offenders[0].reason, /Remote tarballs from other hosts are not allowed/);
});

test('every committed lockfile entry resolves to the public registry with sha512', () => {
  for (const file of ['package-lock.json', 'api/package-lock.json']) {
    const lock = JSON.parse(readFileSync(resolve(repoRoot, file), 'utf8'));
    assert.deepEqual(checkMetadataFields(lock), [], `${file} has metadata offenders`);
  }
});

test('checkVersionInSync returns null when pkg and lock agree', () => {
  const pkg = { name: 'jotjson', version: '0.26.2' };
  const lock = {
    name: 'jotjson',
    version: '0.26.2',
    packages: { '': { name: 'jotjson', version: '0.26.2' } },
  };
  assert.equal(checkVersionInSync(pkg, lock), null);
});

test('checkVersionInSync detects drift between pkg.version and lock.version', () => {
  // The exact scenario PR #286 hit: package.json bumped to 0.26.2,
  // package-lock.json still at 0.26.0.
  const pkg = { name: 'jotjson', version: '0.26.2' };
  const lock = {
    name: 'jotjson',
    version: '0.26.0',
    packages: { '': { name: 'jotjson', version: '0.26.0' } },
  };
  const detail = checkVersionInSync(pkg, lock);
  assert.notEqual(detail, null);
  assert.match(detail, /version drift/);
  assert.match(detail, /0\.26\.2/);
  assert.match(detail, /0\.26\.0/);
});

test('checkVersionInSync detects partial drift (top-level synced, packages[""] stale)', () => {
  // Pathological scenario where only one of the two mirrors got
  // updated. Must still fail.
  const pkg = { name: 'jotjson', version: '0.26.2' };
  const lock = {
    name: 'jotjson',
    version: '0.26.2',
    packages: { '': { name: 'jotjson', version: '0.26.0' } },
  };
  const detail = checkVersionInSync(pkg, lock);
  assert.notEqual(detail, null);
  assert.match(detail, /version drift/);
});

test('checkVersionInSync detects partial drift (packages[""] synced, top-level stale)', () => {
  const pkg = { name: 'jotjson', version: '0.26.2' };
  const lock = {
    name: 'jotjson',
    version: '0.26.0',
    packages: { '': { name: 'jotjson', version: '0.26.2' } },
  };
  const detail = checkVersionInSync(pkg, lock);
  assert.notEqual(detail, null);
  assert.match(detail, /version drift/);
});

test('checkVersionInSync handles missing pkg.version', () => {
  const pkg = { name: 'jotjson' };
  const lock = {
    name: 'jotjson',
    version: '0.26.2',
    packages: { '': { name: 'jotjson', version: '0.26.2' } },
  };
  const detail = checkVersionInSync(pkg, lock);
  assert.notEqual(detail, null);
  assert.match(detail, /package\.json/);
});

test('checkVersionInSync handles missing lock.version', () => {
  const pkg = { name: 'jotjson', version: '0.26.2' };
  const lock = {
    name: 'jotjson',
    packages: { '': { name: 'jotjson', version: '0.26.2' } },
  };
  const detail = checkVersionInSync(pkg, lock);
  assert.notEqual(detail, null);
  assert.match(detail, /top-level/);
});

test('checkVersionInSync handles missing lock.packages', () => {
  const pkg = { name: 'jotjson', version: '0.26.2' };
  const lock = { name: 'jotjson', version: '0.26.2' };
  const detail = checkVersionInSync(pkg, lock);
  assert.notEqual(detail, null);
  assert.match(detail, /packages/);
});

test('checkVersionInSync handles missing lock.packages[""]', () => {
  const pkg = { name: 'jotjson', version: '0.26.2' };
  const lock = { name: 'jotjson', version: '0.26.2', packages: {} };
  const detail = checkVersionInSync(pkg, lock);
  assert.notEqual(detail, null);
  assert.match(detail, /packages\[""\]/);
});

test('checkVersionInSync handles non-object inputs', () => {
  assert.match(checkVersionInSync(null, {}), /package\.json/);
  assert.match(checkVersionInSync({}, null), /package-lock\.json/);
  assert.match(checkVersionInSync('not-json', {}), /package\.json/);
  assert.match(checkVersionInSync({}, 'not-json'), /package-lock\.json/);
});

test('checkVersionInSync handles api/ workspace (0.1.0 baseline)', () => {
  // Smoke check that the function is workspace-agnostic.
  const pkg = { name: 'jotjson-api', version: '0.1.0' };
  const lock = {
    name: 'jotjson-api',
    version: '0.1.0',
    packages: { '': { name: 'jotjson-api', version: '0.1.0' } },
  };
  assert.equal(checkVersionInSync(pkg, lock), null);
});

// --- checkMetadataFields (issue #509) ------------------------------------

/** Builds a lockfile whose `packages` map is the given object. */
const lockWith = (packages) => ({ name: 'jotjson', version: '1.4.0', packages });

/** A well-formed registry entry. */
const registryEntry = (name, version) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
  integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  dev: true,
  license: 'MIT',
});

test('checkMetadataFields passes a clean lockfile', () => {
  const lock = lockWith({
    '': { name: 'jotjson', version: '1.4.0' },
    'node_modules/left-pad': registryEntry('left-pad', '1.3.0'),
    'node_modules/@scope/thing': registryEntry('thing', '2.0.0'),
  });
  assert.deepEqual(checkMetadataFields(lock), []);
});

test('checkMetadataFields flags a missing integrity', () => {
  const entry = registryEntry('left-pad', '1.3.0');
  delete entry.integrity;
  const offenders = checkMetadataFields(lockWith({ 'node_modules/left-pad': entry }));
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].path, 'node_modules/left-pad');
  assert.match(offenders[0].reason, /integrity/);
});

test('checkMetadataFields flags a missing resolved', () => {
  const entry = registryEntry('left-pad', '1.3.0');
  delete entry.resolved;
  const offenders = checkMetadataFields(lockWith({ 'node_modules/left-pad': entry }));
  assert.equal(offenders.length, 1);
  // `integrity` is still present, so only `resolved` is named.
  assert.equal(offenders[0].reason, 'missing `resolved`');
});

test('checkMetadataFields flags the issue #509 shape (both fields absent)', () => {
  // Exactly what 742 root entries looked like: version + flags, no metadata.
  const lock = lockWith({
    'node_modules/@algolia/abtesting': {
      version: '1.16.0',
      dev: true,
      license: 'MIT',
      engines: { node: '>= 14.0.0' },
    },
  });
  const offenders = checkMetadataFields(lock);
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].path, 'node_modules/@algolia/abtesting');
  // Naming only `resolved` here would send someone off to fix half the
  // problem and re-run into the other half.
  assert.equal(offenders[0].reason, 'missing `resolved` and `integrity`');
});

test('checkMetadataFields treats empty strings as missing', () => {
  const lock = lockWith({
    'node_modules/a': { version: '1.0.0', resolved: '', integrity: '' },
    'node_modules/b': {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/b/-/b-1.0.0.tgz',
      integrity: '',
    },
  });
  const offenders = checkMetadataFields(lock);
  assert.equal(offenders.length, 2);
  assert.equal(offenders[0].reason, 'missing `resolved` and `integrity`');
  assert.equal(offenders[1].reason, 'missing `integrity`');
});

test('checkMetadataFields exempts link entries (symlink, no tarball)', () => {
  const lock = lockWith({
    'node_modules/local-pkg': { resolved: '../packages/local-pkg', link: true },
  });
  assert.deepEqual(checkMetadataFields(lock), []);
});

test('checkMetadataFields exempts bundled entries (ship inside the parent tarball)', () => {
  const lock = lockWith({
    'node_modules/thing/node_modules/bundled-dep': { version: '1.0.0', inBundle: true },
  });
  assert.deepEqual(checkMetadataFields(lock), []);
});

test('checkMetadataFields accepts a git source pinned to a commit SHA', () => {
  const lock = lockWith({
    'node_modules/forked': {
      version: '1.0.0',
      resolved: 'git+ssh://git@github.com/o/forked.git#0123456789abcdef0123456789abcdef01234567',
    },
  });
  assert.deepEqual(checkMetadataFields(lock), []);
});

test('checkMetadataFields rejects a git source on a mutable ref', () => {
  // `#main` can be re-pointed at any time, so it pins nothing -- exactly as
  // unverifiable as a missing hash.
  const lock = lockWith({
    'node_modules/forked': {
      version: '1.0.0',
      resolved: 'git+https://github.com/o/forked.git#main',
    },
  });
  const offenders = checkMetadataFields(lock);
  assert.equal(offenders.length, 1);
  assert.match(offenders[0].reason, /commit SHA/);
});

test('checkMetadataFields ignores the root and workspace entries', () => {
  const lock = lockWith({
    '': { name: 'jotjson', version: '1.4.0' },
    'packages/some-workspace': { version: '1.0.0' },
  });
  assert.deepEqual(checkMetadataFields(lock), []);
});

test('checkMetadataFields returns offenders sorted by path', () => {
  const lock = lockWith({
    'node_modules/zeta': { version: '1.0.0' },
    'node_modules/alpha': { version: '1.0.0' },
    'node_modules/mid': { version: '1.0.0' },
  });
  assert.deepEqual(
    checkMetadataFields(lock).map((offender) => offender.path),
    ['node_modules/alpha', 'node_modules/mid', 'node_modules/zeta'],
  );
});

test('checkMetadataFields reports every offender so the caller can count them', () => {
  // The 10-entry cap lives in the printer, not the checker -- the caller
  // needs the true total to say "showing first 10 of N".
  const packages = {};
  for (let i = 0; i < 25; i++) {
    packages[`node_modules/pkg-${String(i).padStart(2, '0')}`] = { version: '1.0.0' };
  }
  assert.equal(checkMetadataFields(lockWith(packages)).length, 25);
});

test('checkMetadataFields handles a non-object entry', () => {
  const offenders = checkMetadataFields(lockWith({ 'node_modules/weird': null }));
  assert.equal(offenders.length, 1);
  assert.match(offenders[0].reason, /not an object/);
});

test('checkMetadataFields handles malformed lockfiles', () => {
  assert.match(checkMetadataFields(null)[0].reason, /did not parse/);
  assert.match(checkMetadataFields('not-json')[0].reason, /did not parse/);
  assert.match(checkMetadataFields({ name: 'x' })[0].reason, /packages/);
});

test('checkMetadataFields accepts the committed lockfiles', async () => {
  // Regression guard: the real artifacts must satisfy the gate. Before the
  // issue #509 backfill this failed with 742 offenders.
  const { readFileSync } = await import('node:fs');
  for (const lockfile of ['package-lock.json', 'api/package-lock.json']) {
    const lock = JSON.parse(readFileSync(lockfile, 'utf8'));
    assert.deepEqual(checkMetadataFields(lock), [], `${lockfile} has entries missing metadata`);
  }
});
