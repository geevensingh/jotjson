import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkRedaction } from './check-fixture-redaction.mjs';

function withFixture(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'fixture-redaction-test-'));
  const path = join(dir, 'fixture.json');
  writeFileSync(path, content, 'utf8');
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('checkRedaction passes when all values follow the recipe', () => {
  const content = JSON.stringify({
    id: 'lorem-0001',
    _rid: '00000000-0000-0000-0000-000000000001',
    _ts: '2000-01-01T00:00:00Z',
    owner: 'lorem@example.com',
    state: 'PENDING',
    version: 'v2',
    notes: 'lorem-0002',
  });
  withFixture(content, (path) => {
    assert.deepEqual(checkRedaction(path), []);
  });
});

test('checkRedaction flags a real-looking UUID', () => {
  const content = JSON.stringify({ id: 'a3f4e2b1-9c8d-4e7f-a1b2-c3d4e5f6a7b8' });
  withFixture(content, (path) => {
    const violations = checkRedaction(path);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /real-looking UUID/);
  });
});

test('checkRedaction flags a non-canonical email', () => {
  const content = JSON.stringify({ owner: 'real.person@contoso.com' });
  withFixture(content, (path) => {
    const violations = checkRedaction(path);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /real-looking email/);
  });
});

test('checkRedaction flags a non-canonical ISO timestamp', () => {
  const content = JSON.stringify({ _ts: '2024-08-15T12:34:56Z' });
  withFixture(content, (path) => {
    const violations = checkRedaction(path);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /non-canonical timestamp/);
  });
});

test('checkRedaction flags an unexpected free-form string', () => {
  const content = JSON.stringify({ note: 'arbitrary free-form sentence with several words' });
  withFixture(content, (path) => {
    const violations = checkRedaction(path);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /unredacted free-form string/);
  });
});

test('checkRedaction reports invalid JSON without throwing', () => {
  withFixture('not-json', (path) => {
    const violations = checkRedaction(path);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /invalid JSON/);
  });
});
