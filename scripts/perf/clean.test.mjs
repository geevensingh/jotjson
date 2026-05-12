import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pruneOldRuns } from './clean.mjs';

test('pruneOldRuns removes dirs older than maxAgeMs and keeps newer ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'perf-clean-test-'));
  try {
    const oldDir = join(root, '2026-04-01T00-00-00');
    const newDir = join(root, '2026-05-08T00-00-00');
    mkdirSync(oldDir);
    mkdirSync(newDir);
    writeFileSync(join(oldDir, 'layer-1.jsonl'), '{}\n');
    writeFileSync(join(newDir, 'layer-1.jsonl'), '{}\n');
    const tenDaysAgo = Date.now() - 10 * 86400000;
    const twoDaysAgo = Date.now() - 2 * 86400000;
    utimesSync(oldDir, new Date(tenDaysAgo), new Date(tenDaysAgo));
    utimesSync(newDir, new Date(twoDaysAgo), new Date(twoDaysAgo));

    const result = pruneOldRuns({
      rootDir: root,
      maxAgeMs: 7 * 86400000,
    });

    assert.equal(result.removed.length, 1);
    assert.equal(result.kept.length, 1);
    assert.ok(result.removed[0].endsWith('2026-04-01T00-00-00'));
    assert.ok(result.kept[0].endsWith('2026-05-08T00-00-00'));
    assert.equal(existsSync(oldDir), false);
    assert.equal(existsSync(newDir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pruneOldRuns dry-run does not remove anything', () => {
  const root = mkdtempSync(join(tmpdir(), 'perf-clean-test-dryrun-'));
  try {
    const dir = join(root, 'stale');
    mkdirSync(dir);
    const past = Date.now() - 100 * 86400000;
    utimesSync(dir, new Date(past), new Date(past));

    const result = pruneOldRuns({
      rootDir: root,
      maxAgeMs: 7 * 86400000,
      dryRun: true,
    });
    assert.equal(result.removed.length, 1);
    assert.equal(existsSync(dir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pruneOldRuns returns empty arrays when rootDir does not exist', () => {
  const result = pruneOldRuns({
    rootDir: join(tmpdir(), 'definitely-does-not-exist-' + Date.now()),
    maxAgeMs: 7 * 86400000,
  });
  assert.deepEqual(result, { removed: [], kept: [] });
});
