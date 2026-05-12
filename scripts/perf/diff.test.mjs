import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertBaselineSchema, BASELINE_SCHEMA_VERSION } from './baseline.mjs';
import { computeDiffs, formatDiffTable, formatNs } from './diff.mjs';

function makeBaseline(rows) {
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    machineLabel: 'test',
    lastUpdatedUtc: '2025-01-01T00:00:00.000Z',
    codeShaAtBaseline: 'abc1234',
    rows,
  };
}

test('formatNs uses ASCII-only unit suffixes', () => {
  assert.equal(formatNs(500), '500ns');
  assert.equal(formatNs(1_500), '1.5us');
  assert.equal(formatNs(2_500_000), '2.5ms');
  assert.equal(formatNs(3_000_000_000), '3.00s');
});

test('computeDiffs flags rows over the layer-specific threshold', () => {
  const baseline = makeBaseline({
    '1.parse.deep25.10K': {
      wallNsMedian: 1_000_000,
      wallNsIqrLow: 950_000,
      wallNsIqrHigh: 1_050_000,
      iters: 20,
      approxNodes: 10000,
    },
    '3.paste-large.cosmos-doc-sample.5m': {
      wallNsMedian: 1_000_000_000,
      wallNsIqrLow: 950_000_000,
      wallNsIqrHigh: 1_050_000_000,
      iters: 7,
      approxNodes: 5_000_000,
    },
  });
  const currentRows = [
    {
      layer: 1,
      scenario: 'parse',
      fixture: 'deep25',
      size: '10K',
      approxNodes: 10000,
      iters: 20,
      wallNsMedian: 1_200_000,
      wallNsIqrLow: 0,
      wallNsIqrHigh: 0,
      codeSha: 'newish',
    },
    {
      layer: 3,
      scenario: 'paste-large',
      fixture: 'cosmos-doc-sample',
      size: '5m',
      approxNodes: 5_000_000,
      iters: 7,
      wallNsMedian: 1_180_000_000,
      wallNsIqrLow: 0,
      wallNsIqrHigh: 0,
      codeSha: 'newish',
    },
  ];
  const diffs = computeDiffs(baseline, currentRows);
  const byKey = new Map(diffs.map((diff) => [diff.key, diff]));
  // Layer 1: 20% > 15% threshold -> flagged.
  assert.equal(byKey.get('1.parse.deep25.10K').flagged, true);
  // Layer 3: 18% < 20% threshold -> not flagged.
  assert.equal(byKey.get('3.paste-large.cosmos-doc-sample.5m').flagged, false);
});

test('computeDiffs skips rows with no baseline entry', () => {
  const baseline = makeBaseline({});
  const diffs = computeDiffs(baseline, [
    {
      layer: 1,
      scenario: 'parse',
      fixture: 'deep25',
      size: '10K',
      approxNodes: 0,
      iters: 0,
      wallNsMedian: 100,
      wallNsIqrLow: 0,
      wallNsIqrHigh: 0,
      codeSha: 'x',
    },
  ]);
  assert.equal(diffs.length, 0);
});

test('formatDiffTable returns an ASCII-only table sorted by largest delta', () => {
  const baseline = makeBaseline({
    '1.a.b.10K': {
      wallNsMedian: 1000,
      wallNsIqrLow: 0,
      wallNsIqrHigh: 0,
      iters: 1,
      approxNodes: 0,
    },
    '1.c.d.10K': {
      wallNsMedian: 1000,
      wallNsIqrLow: 0,
      wallNsIqrHigh: 0,
      iters: 1,
      approxNodes: 0,
    },
  });
  const currentRows = [
    {
      layer: 1,
      scenario: 'a',
      fixture: 'b',
      size: '10K',
      approxNodes: 0,
      iters: 1,
      wallNsMedian: 1100,
      wallNsIqrLow: 0,
      wallNsIqrHigh: 0,
      codeSha: 'x',
    },
    {
      layer: 1,
      scenario: 'c',
      fixture: 'd',
      size: '10K',
      approxNodes: 0,
      iters: 1,
      wallNsMedian: 1500,
      wallNsIqrLow: 0,
      wallNsIqrHigh: 0,
      codeSha: 'x',
    },
  ];
  const diffs = computeDiffs(baseline, currentRows);
  const table = formatDiffTable(diffs);
  // ASCII-only: no Unicode dashes/arrows.
  for (let i = 0; i < table.length; i++) {
    assert.ok(table.charCodeAt(i) < 128, `non-ASCII at index ${i}: ${table[i]}`);
  }
  // c.d row should appear before a.b row (50% > 10%).
  const cdIdx = table.indexOf('c.d');
  const abIdx = table.indexOf('a.b');
  assert.ok(cdIdx > 0 && cdIdx < abIdx, 'c.d row should sort before a.b row');
});

test('formatDiffTable handles empty input', () => {
  const out = formatDiffTable([]);
  assert.match(out, /no overlapping/);
});

test('assertBaselineSchema accepts current schemaVersion', () => {
  const baseline = { schemaVersion: BASELINE_SCHEMA_VERSION, rows: {} };
  const result = assertBaselineSchema(baseline, '/tmp/baseline.json');
  assert.equal(result.schemaVersion, BASELINE_SCHEMA_VERSION);
});

test('assertBaselineSchema rejects missing schemaVersion', () => {
  assert.throws(
    () => assertBaselineSchema({ rows: {} }, '/tmp/old.json'),
    /missing "schemaVersion"/,
  );
});

test('assertBaselineSchema rejects mismatched schemaVersion', () => {
  assert.throws(
    () => assertBaselineSchema({ schemaVersion: 999, rows: {} }, '/tmp/future.json'),
    /schemaVersion=999/,
  );
});
