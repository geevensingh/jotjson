import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isValidMachineLabel,
  requireMachineLabel,
  sanitizeHostnameForLabel,
  suggestMachineLabel,
} from './machine-label.mjs';

test('suggestMachineLabel returns a platform-arch-hostname triplet that passes isValidMachineLabel', () => {
  const label = suggestMachineLabel();
  // Shape: <platform>-<arch>-<sanitized-hostname>. The hostname segment
  // is host-dependent so we assert the structural prefix and full-label
  // validity, not the hostname text.
  assert.match(label, /^[a-z0-9]+-[a-z0-9]+-[A-Za-z0-9_-]+$/, `unexpected shape: ${label}`);
  assert.ok(isValidMachineLabel(label), `suggested label should be valid: ${label}`);
});

test('suggestMachineLabel is deterministic across calls', () => {
  assert.equal(suggestMachineLabel(), suggestMachineLabel());
});

test('sanitizeHostnameForLabel replaces invalid chars with a single hyphen', () => {
  assert.equal(sanitizeHostnameForLabel("Geeven's-MBP.local"), 'Geeven-s-MBP-local');
  assert.equal(sanitizeHostnameForLabel('Build Runner 01'), 'Build-Runner-01');
  assert.equal(sanitizeHostnameForLabel('alex@laptop'), 'alex-laptop');
});

test('sanitizeHostnameForLabel collapses runs of hyphens and trims edges', () => {
  assert.equal(sanitizeHostnameForLabel('---foo---bar---'), 'foo-bar');
  assert.equal(sanitizeHostnameForLabel('!!!'), 'unknown-host');
});

test('sanitizeHostnameForLabel returns unknown-host for empty input', () => {
  assert.equal(sanitizeHostnameForLabel(''), 'unknown-host');
  assert.equal(
    sanitizeHostnameForLabel(/** @type {string} */ (/** @type {unknown} */ (null))),
    'unknown-host',
  );
});

test('sanitizeHostnameForLabel truncates to fit the 64-char budget', () => {
  const raw = 'a'.repeat(100);
  const result = sanitizeHostnameForLabel(raw, 14); // prefix "linux-x64-" is 10; pretend 14 for headroom
  assert.equal(result.length, 50);
  assert.match(result, /^a+$/);
});

test('isValidMachineLabel accepts ASCII letters, digits, hyphen, underscore, dot', () => {
  assert.ok(isValidMachineLabel('linux-x64-3f9c2a'));
  assert.ok(isValidMachineLabel('darwin_arm64.M3_2024'));
  assert.ok(isValidMachineLabel('CI'));
  assert.ok(isValidMachineLabel('a'));
});

test('isValidMachineLabel rejects empty, spaces, slashes, and >64 chars', () => {
  assert.equal(isValidMachineLabel(''), false);
  assert.equal(isValidMachineLabel('has space'), false);
  assert.equal(isValidMachineLabel('has/slash'), false);
  assert.equal(isValidMachineLabel('has\\backslash'), false);
  assert.equal(isValidMachineLabel('has:colon'), false);
  assert.equal(isValidMachineLabel('x'.repeat(65)), false);
});

test('requireMachineLabel returns the env value when set and valid', () => {
  const label = requireMachineLabel({ PERF_MACHINE: 'linux-x64-test01' });
  assert.equal(label, 'linux-x64-test01');
});

test('requireMachineLabel throws a docs-linking message when unset', () => {
  assert.throws(() => requireMachineLabel({}), /PERF_MACHINE.*required.*docs\/perf\.md/s);
});

test('requireMachineLabel throws when set to invalid characters', () => {
  assert.throws(
    () => requireMachineLabel({ PERF_MACHINE: 'has space' }),
    /not a valid machine label/,
  );
});
