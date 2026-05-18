// Unit tests for scripts/check-lockfile.mjs.
//
// Runs under Node's built-in test runner: `node --test`. No external
// dependencies. The test file imports the script as a module; the script
// guards `main()` behind an "invoked directly" check so importing it does
// not trigger CLI side effects (spawnSync npm, process.exit).
//
// Coverage focuses on `checkVersionInSync` -- the version-drift gate
// added in response to PR #286 review feedback. The dependency-tree
// gate (Phase 2, `npm ci --dry-run`) is exercised end-to-end by the
// real `npm run lint:lockfile` and is not unit-tested here.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkVersionInSync } from './check-lockfile.mjs';

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
