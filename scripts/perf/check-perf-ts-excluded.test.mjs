import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findMissingGlobs, parseExcludeGlobs } from './check-perf-ts-excluded.mjs';

test('parseExcludeGlobs strips line comments and reads exclude array', () => {
  const text = `{
    // a comment
    "include": ["src/**/*.spec.ts"],
    "exclude": ["src/**/*.perf.ts", "src/legacy/**/*.spec.ts"]
  }`;
  assert.deepEqual(parseExcludeGlobs(text), ['src/**/*.perf.ts', 'src/legacy/**/*.spec.ts']);
});

test('parseExcludeGlobs strips block comments', () => {
  const text = `{
    /* multi-line
       comment */
    "exclude": ["src/**/*.perf.ts"]
  }`;
  assert.deepEqual(parseExcludeGlobs(text), ['src/**/*.perf.ts']);
});

test('parseExcludeGlobs returns empty when exclude is missing', () => {
  const text = `{ "include": ["a"] }`;
  assert.deepEqual(parseExcludeGlobs(text), []);
});

test('findMissingGlobs returns absent globs', () => {
  const missing = findMissingGlobs(['src/legacy/**/*.spec.ts'], ['src/**/*.perf.ts']);
  assert.deepEqual(missing, ['src/**/*.perf.ts']);
});

test('findMissingGlobs returns empty when all required globs are present', () => {
  const missing = findMissingGlobs(['src/**/*.perf.ts', 'something-else'], ['src/**/*.perf.ts']);
  assert.deepEqual(missing, []);
});
