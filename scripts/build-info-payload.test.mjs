// Unit tests for scripts/build-info-payload.mjs.
//
// Runs under Node's built-in test runner: `node --test`. No external
// dependencies.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  computeBuildInfoPayload,
  deriveBuildNumber,
  normalizeRepositoryUrl,
  resolveBuildShaFromEnv,
} from './build-info-payload.mjs';

const FAKE_PACKAGE = Object.freeze({
  version: '0.30.0',
  repository: { url: 'git+https://github.com/geevensingh/jotjson.git' },
});

const FIXED_BUILT_AT = '2025-06-01T12:00:00.000Z';

function silentLogger() {
  return { warn() {}, log() {} };
}

test('resolveBuildShaFromEnv prefers JOTJSON_BUILD_SHA', () => {
  const sha = resolveBuildShaFromEnv({
    JOTJSON_BUILD_SHA: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    GITHUB_SHA: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  assert.equal(sha, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
});

test('resolveBuildShaFromEnv falls back to GITHUB_SHA when JOTJSON_BUILD_SHA empty', () => {
  const sha = resolveBuildShaFromEnv({
    JOTJSON_BUILD_SHA: '',
    GITHUB_SHA: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
  });
  assert.equal(sha, 'cccccccccccccccccccccccccccccccccccccccc');
});

test('resolveBuildShaFromEnv falls back to GITHUB_SHA when JOTJSON_BUILD_SHA unset', () => {
  const sha = resolveBuildShaFromEnv({
    GITHUB_SHA: 'dddddddddddddddddddddddddddddddddddddddd',
  });
  assert.equal(sha, 'dddddddddddddddddddddddddddddddddddddddd');
});

test("resolveBuildShaFromEnv returns 'dev' when no env vars set", () => {
  assert.equal(resolveBuildShaFromEnv({}), 'dev');
  assert.equal(resolveBuildShaFromEnv({ JOTJSON_BUILD_SHA: '  ' }), 'dev');
  assert.equal(resolveBuildShaFromEnv({ JOTJSON_BUILD_SHA: '', GITHUB_SHA: '   ' }), 'dev');
});

test('normalizeRepositoryUrl strips git+ prefix and .git suffix', () => {
  assert.equal(
    normalizeRepositoryUrl('git+https://github.com/geevensingh/jotjson.git'),
    'https://github.com/geevensingh/jotjson',
  );
});

test('normalizeRepositoryUrl handles SSH protocol form', () => {
  assert.equal(
    normalizeRepositoryUrl('ssh://git@github.com/geevensingh/jotjson.git'),
    'https://github.com/geevensingh/jotjson',
  );
});

test('normalizeRepositoryUrl handles SSH shortcut form', () => {
  assert.equal(
    normalizeRepositoryUrl('git@github.com:geevensingh/jotjson.git'),
    'https://github.com/geevensingh/jotjson',
  );
});

test('normalizeRepositoryUrl returns empty string for missing values', () => {
  assert.equal(normalizeRepositoryUrl(undefined), '');
  assert.equal(normalizeRepositoryUrl(''), '');
  assert.equal(normalizeRepositoryUrl('  '), '');
});

test('computeBuildInfoPayload returns the canonical payload shape', () => {
  const payload = computeBuildInfoPayload({
    repoRoot: '/fake/repo',
    sha: 'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE',
    branch: 'main',
    builtAt: FIXED_BUILT_AT,
    packageMetadata: FAKE_PACKAGE,
    buildNumber: '42',
  });
  assert.deepEqual(payload, {
    version: '0.30.0',
    sha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    branch: 'main',
    builtAt: FIXED_BUILT_AT,
    repoUrl: 'https://github.com/geevensingh/jotjson',
    buildNumber: '42',
  });
});

test('computeBuildInfoPayload requires sha', () => {
  assert.throws(
    () =>
      computeBuildInfoPayload({
        repoRoot: '/fake/repo',
        packageMetadata: FAKE_PACKAGE,
        buildNumber: '42',
      }),
    /sha is required/,
  );
  assert.throws(
    () =>
      computeBuildInfoPayload({
        repoRoot: '/fake/repo',
        sha: '',
        packageMetadata: FAKE_PACKAGE,
        buildNumber: '42',
      }),
    /sha is required/,
  );
});

test('computeBuildInfoPayload requires repoRoot', () => {
  assert.throws(
    () =>
      computeBuildInfoPayload({
        sha: 'a',
        packageMetadata: FAKE_PACKAGE,
        buildNumber: '42',
      }),
    /repoRoot is required/,
  );
});

test('computeBuildInfoPayload propagates explicit buildNumber override', () => {
  const payload = computeBuildInfoPayload({
    repoRoot: '/fake/repo',
    sha: 'abc',
    packageMetadata: FAKE_PACKAGE,
    buildNumber: 'unknown',
  });
  assert.equal(payload.buildNumber, 'unknown');
});

test('computeBuildInfoPayload defaults branch to empty string', () => {
  const payload = computeBuildInfoPayload({
    repoRoot: '/fake/repo',
    sha: 'abc',
    packageMetadata: FAKE_PACKAGE,
    buildNumber: '1',
  });
  assert.equal(payload.branch, '');
});

test('computeBuildInfoPayload handles missing repository.url', () => {
  const payload = computeBuildInfoPayload({
    repoRoot: '/fake/repo',
    sha: 'abc',
    packageMetadata: { version: '1.2.3' },
    buildNumber: '1',
  });
  assert.equal(payload.repoUrl, '');
});

test('deriveBuildNumber requires repoRoot', () => {
  assert.throws(() => deriveBuildNumber({ logger: silentLogger() }), /repoRoot is required/);
});

test("deriveBuildNumber returns 'unknown' when git fails", () => {
  // Pointing at a directory that is not a git repository forces the
  // `execFileSync('git', ...)` call to fail, exercising the catch
  // branch.
  const result = deriveBuildNumber({
    repoRoot: '/this/path/does/not/exist',
    logger: silentLogger(),
  });
  assert.equal(result, 'unknown');
});
