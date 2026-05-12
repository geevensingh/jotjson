import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidMachineLabel, requireMachineLabel, suggestMachineLabel } from './machine-label.mjs';

test('suggestMachineLabel returns a non-empty platform-arch-hash triplet', () => {
  const label = suggestMachineLabel();
  assert.match(label, /^[a-z0-9]+-[a-z0-9]+-[a-f0-9]{6}$/);
  assert.ok(isValidMachineLabel(label), `suggested label should be valid: ${label}`);
});

test('suggestMachineLabel is deterministic across calls', () => {
  assert.equal(suggestMachineLabel(), suggestMachineLabel());
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
