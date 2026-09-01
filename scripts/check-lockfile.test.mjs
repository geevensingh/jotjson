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
import { test } from 'node:test';

import { checkMetadataFields, checkVersionInSync } from './check-lockfile.mjs';

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
  assert.match(offenders[0].reason, /resolved/);
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
  assert.match(offenders[0].reason, /resolved/);
  assert.match(offenders[1].reason, /integrity/);
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
