import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isStale, readBaselineAge } from './check-fresh.mjs';

test('isStale returns false when age is null', () => {
  assert.equal(isStale(null), false);
});

test('isStale returns true above threshold', () => {
  assert.equal(isStale(45, 30), true);
  assert.equal(isStale(15, 30), false);
});

test('readBaselineAge returns null age when file does not exist', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fresh-test-'));
  try {
    const { baselinePath, ageDays } = readBaselineAge('missing-machine', tmp);
    assert.ok(baselinePath.endsWith('missing-machine.json'));
    assert.equal(ageDays, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readBaselineAge returns positive age when file is older', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fresh-test-'));
  try {
    const oldDate = new Date(Date.now() - 60 * 86_400_000).toISOString();
    writeFileSync(join(tmp, 'mach.json'), JSON.stringify({ lastUpdatedUtc: oldDate }));
    const { ageDays } = readBaselineAge('mach', tmp);
    assert.ok(ageDays !== null && ageDays >= 59 && ageDays <= 61, `age ${ageDays}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readBaselineAge returns null when lastUpdatedUtc is missing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fresh-test-'));
  try {
    writeFileSync(join(tmp, 'mach.json'), JSON.stringify({}));
    const { ageDays } = readBaselineAge('mach', tmp);
    assert.equal(ageDays, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
