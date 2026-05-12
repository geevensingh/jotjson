import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { extractRows } from './run-l2.mjs';

test('extractRows returns [] for text containing no sentinels', () => {
  assert.deepEqual(extractRows('no sentinels here'), []);
  assert.deepEqual(extractRows(''), []);
  assert.deepEqual(extractRows('@@PERF_L1@@{"layer":1}@@END@@'), []);
});

test('extractRows parses a single well-formed @@PERF_L2@@ sentinel', () => {
  const row = {
    layer: 2,
    scenario: 'initial-render',
    fixture: 'wide-aoo',
    size: '10k',
    approxNodes: 10000,
    iters: 5,
    wallNsMedian: 1234,
    wallNsIqrLow: 1200,
    wallNsIqrHigh: 1300,
    wallNsStddev: 50,
  };
  const text = `@@PERF_L2@@${JSON.stringify(row)}@@END@@`;
  const rows = extractRows(text);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], row);
});

test('extractRows parses multiple sentinels embedded in surrounding log noise', () => {
  const rowA = { layer: 2, scenario: 'initial-render', size: '10k' };
  const rowB = { layer: 2, scenario: 'scroll-after-expand', size: '10k' };
  const text = [
    'Karma chunk 1 begins...',
    `@@PERF_L2@@${JSON.stringify(rowA)}@@END@@`,
    'some interleaved stdout',
    `@@PERF_L2@@${JSON.stringify(rowB)}@@END@@`,
    'tail noise',
  ].join('\n');
  const rows = extractRows(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], rowA);
  assert.deepEqual(rows[1], rowB);
});

test('extractRows silently drops malformed sentinels', () => {
  assert.deepEqual(extractRows('@@PERF_L2@@malformed@@END@@'), []);
  assert.deepEqual(extractRows('@@PERF_L2@@{not json}@@END@@'), []);
});

test('extractRows preserves valid rows even when a malformed sentinel is interleaved', () => {
  const valid = { layer: 2, scenario: 'initial-render' };
  const text = [`@@PERF_L2@@${JSON.stringify(valid)}@@END@@`, '@@PERF_L2@@malformed@@END@@'].join(
    '\n',
  );
  const rows = extractRows(text);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], valid);
});
