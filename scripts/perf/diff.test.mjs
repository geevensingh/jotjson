import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertBaselineSchema, BASELINE_SCHEMA_VERSION } from './baseline.mjs';
import { checkAgainstTargets, computeDiffs, formatDiffTable, formatNs } from './diff.mjs';

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
    '1.parse.deep25.10k': {
      wallNsMedian: 1_000_000,
      wallNsIqrLow: 950_000,
      wallNsIqrHigh: 1_050_000,
      iters: 20,
      approxNodes: 10000,
    },
    '3.paste-large.wide-aoo.1m': {
      wallNsMedian: 1_000_000_000,
      wallNsIqrLow: 950_000_000,
      wallNsIqrHigh: 1_050_000_000,
      iters: 7,
      approxNodes: 1_000_000,
    },
  });
  const currentRows = [
    {
      layer: 1,
      scenario: 'parse',
      fixture: 'deep25',
      size: '10k',
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
      fixture: 'wide-aoo',
      size: '1m',
      approxNodes: 1_000_000,
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
  assert.equal(byKey.get('1.parse.deep25.10k').flagged, true);
  // Layer 3: 18% < 20% threshold -> not flagged.
  assert.equal(byKey.get('3.paste-large.wide-aoo.1m').flagged, false);
});

test('computeDiffs skips rows with no baseline entry', () => {
  const baseline = makeBaseline({});
  const diffs = computeDiffs(baseline, [
    {
      layer: 1,
      scenario: 'parse',
      fixture: 'deep25',
      size: '10k',
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

test('computeDiffs skips rows whose pasteMethod differs from the baseline entry', () => {
  const baseline = makeBaseline({
    '3.paste-large.wide-aoo.10k': {
      wallNsMedian: 1_000_000,
      wallNsIqrLow: 0,
      wallNsIqrHigh: 0,
      iters: 7,
      approxNodes: 10000,
      pasteMethod: 'setvalue',
    },
  });
  const diffs = computeDiffs(baseline, [
    {
      layer: 3,
      scenario: 'paste-large',
      fixture: 'wide-aoo',
      size: '10k',
      approxNodes: 10000,
      iters: 7,
      wallNsMedian: 1_200_000,
      wallNsIqrLow: 0,
      wallNsIqrHigh: 0,
      pasteMethod: 'keyboard',
      codeSha: 'x',
    },
  ]);
  assert.equal(diffs.length, 0);
});

test('computeDiffs matches rows when pasteMethod is identical on both sides', () => {
  const baseline = makeBaseline({
    '3.paste-large.wide-aoo.10k': {
      wallNsMedian: 1_000_000,
      wallNsIqrLow: 0,
      wallNsIqrHigh: 0,
      iters: 7,
      approxNodes: 10000,
      pasteMethod: 'setvalue',
    },
  });
  const diffs = computeDiffs(baseline, [
    {
      layer: 3,
      scenario: 'paste-large',
      fixture: 'wide-aoo',
      size: '10k',
      approxNodes: 10000,
      iters: 7,
      wallNsMedian: 1_200_000,
      wallNsIqrLow: 0,
      wallNsIqrHigh: 0,
      pasteMethod: 'setvalue',
      codeSha: 'x',
    },
  ]);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].key, '3.paste-large.wide-aoo.10k');
});

test('computeDiffs matches rows when pasteMethod is omitted on both sides (legacy v1)', () => {
  const baseline = makeBaseline({
    '1.parse.deep25.10k': {
      wallNsMedian: 1_000_000,
      wallNsIqrLow: 0,
      wallNsIqrHigh: 0,
      iters: 20,
      approxNodes: 10000,
    },
  });
  const diffs = computeDiffs(baseline, [
    {
      layer: 1,
      scenario: 'parse',
      fixture: 'deep25',
      size: '10k',
      approxNodes: 10000,
      iters: 20,
      wallNsMedian: 1_100_000,
      wallNsIqrLow: 0,
      wallNsIqrHigh: 0,
      codeSha: 'x',
    },
  ]);
  assert.equal(diffs.length, 1);
});

test('computeDiffs skips rows when only one side carries pasteMethod', () => {
  const baseline = makeBaseline({
    '3.paste-large.wide-aoo.10k': {
      wallNsMedian: 1_000_000,
      wallNsIqrLow: 0,
      wallNsIqrHigh: 0,
      iters: 7,
      approxNodes: 10000,
      pasteMethod: 'setvalue',
    },
  });
  const diffs = computeDiffs(baseline, [
    {
      layer: 3,
      scenario: 'paste-large',
      fixture: 'wide-aoo',
      size: '10k',
      approxNodes: 10000,
      iters: 7,
      wallNsMedian: 1_100_000,
      wallNsIqrLow: 0,
      wallNsIqrHigh: 0,
      codeSha: 'x',
    },
  ]);
  assert.equal(diffs.length, 0);
});

test('formatDiffTable returns an ASCII-only table sorted by largest delta', () => {
  const baseline = makeBaseline({
    '1.a.b.10k': {
      wallNsMedian: 1000,
      wallNsIqrLow: 0,
      wallNsIqrHigh: 0,
      iters: 1,
      approxNodes: 0,
    },
    '1.c.d.10k': {
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
      size: '10k',
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
      size: '10k',
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

function makeL3Row(overrides = {}) {
  return {
    layer: 3,
    scenario: 'paste-large',
    fixture: 'wide-aoo',
    size: '1m',
    approxNodes: 1_000_000,
    iters: 7,
    wallNsMedian: 1_000_000_000,
    wallNsIqrLow: 0,
    wallNsIqrHigh: 0,
    codeSha: 'x',
    longestTaskMsMedian: 250,
    ...overrides,
  };
}

function makeTargets(rows) {
  return { schemaVersion: 1, rows };
}

test('checkAgainstTargets returns 0 flags when metric is within ceiling', () => {
  const targets = makeTargets({
    '3.paste-large.wide-aoo.1m': {
      longestTaskMsMedian: { ceiling_ms: 500, reason: 'within ceiling' },
    },
  });
  const { flaggedCount, messages } = checkAgainstTargets([makeL3Row()], targets);
  assert.equal(flaggedCount, 0);
  assert.deepEqual(messages, []);
});

test('checkAgainstTargets flags rows whose metric exceeds ceiling', () => {
  const targets = makeTargets({
    '3.paste-large.wide-aoo.1m': {
      longestTaskMsMedian: { ceiling_ms: 200, reason: 'too low ceiling' },
    },
  });
  const { flaggedCount, messages } = checkAgainstTargets(
    [makeL3Row({ longestTaskMsMedian: 250 })],
    targets,
  );
  assert.equal(flaggedCount, 1);
  assert.equal(messages.length, 1);
  assert.match(
    messages[0],
    /\[!\] perf-targets row "3\.paste-large\.wide-aoo\.1m" metric "longestTaskMsMedian" = 250\.0 ms exceeds ceiling 200 ms/,
  );
});

test('checkAgainstTargets warns (no flag) when current run lacks the targeted row', () => {
  const targets = makeTargets({
    '3.paste-large.wide-aoo.1m': {
      longestTaskMsMedian: { ceiling_ms: 500, reason: 'present in targets, absent in run' },
    },
  });
  const { flaggedCount, messages } = checkAgainstTargets([], targets);
  assert.equal(flaggedCount, 0);
  assert.equal(messages.length, 1);
  assert.match(
    messages[0],
    /^WARN: perf-targets row "3\.paste-large\.wide-aoo\.1m" has no current-run data; skipping$/,
  );
});

test('checkAgainstTargets warns (no flag) when the named metric is not numeric on the row', () => {
  const targets = makeTargets({
    '3.paste-large.wide-aoo.1m': {
      longestTaskMsMedian: { ceiling_ms: 500, reason: 'metric missing' },
    },
  });
  const { flaggedCount, messages } = checkAgainstTargets(
    [makeL3Row({ longestTaskMsMedian: null })],
    targets,
  );
  assert.equal(flaggedCount, 0);
  assert.equal(messages.length, 1);
  assert.match(
    messages[0],
    /metric "longestTaskMsMedian" has no numeric value in current run; skipping/,
  );
});

test('checkAgainstTargets returns 0 flags for an empty rows map', () => {
  const targets = makeTargets({});
  const { flaggedCount, messages } = checkAgainstTargets([makeL3Row()], targets);
  assert.equal(flaggedCount, 0);
  assert.deepEqual(messages, []);
});
