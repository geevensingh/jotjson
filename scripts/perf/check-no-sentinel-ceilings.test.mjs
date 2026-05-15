import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSentinelCeilings } from './check-no-sentinel-ceilings.mjs';

test('returns empty for a doc with all non-negative ceilings', () => {
  const doc = {
    schemaVersion: 1,
    rows: {
      '3.paste-large.mixed-d10.380k': {
        longestTaskMsMedian: { ceiling_ms: 500, reason: 'NFR-anchor' },
      },
      '1.parse.mixed-d10.380k': {
        wallMsMedian: { ceiling_ms: 150, reason: 'measured' },
      },
    },
  };
  assert.deepEqual(findSentinelCeilings(doc), []);
});

test('detects a single sentinel ceiling', () => {
  const doc = {
    schemaVersion: 1,
    rows: {
      '3.paste-large.mixed-d10.380k': {
        longestTaskMsMedian: { ceiling_ms: -1, reason: 'TODO: replace' },
      },
    },
  };
  const offenders = findSentinelCeilings(doc);
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].rowKey, '3.paste-large.mixed-d10.380k');
  assert.equal(offenders[0].metric, 'longestTaskMsMedian');
  assert.equal(offenders[0].ceiling_ms, -1);
});

test('detects multiple sentinels across rows and metrics', () => {
  const doc = {
    schemaVersion: 1,
    rows: {
      '1.parse.mixed-d10.380k': {
        wallMsMedian: { ceiling_ms: -1, reason: 'TODO' },
      },
      '1.build-tree.mixed-d10.380k': {
        wallMsMedian: { ceiling_ms: -1, reason: 'TODO' },
      },
      '3.paste-large.mixed-d10.380k': {
        longestTaskMsMedian: { ceiling_ms: 500, reason: 'measured' },
      },
    },
  };
  const offenders = findSentinelCeilings(doc);
  assert.equal(offenders.length, 2);
});

test('treats ceiling_ms === 0 as valid (not a sentinel)', () => {
  const doc = {
    schemaVersion: 1,
    rows: {
      '1.parse.deep25.10k': {
        wallNsMedianMs: { ceiling_ms: 0, reason: 'intentional zero' },
      },
    },
  };
  assert.deepEqual(findSentinelCeilings(doc), []);
});

test('handles missing rows gracefully', () => {
  assert.deepEqual(findSentinelCeilings({ schemaVersion: 1 }), []);
});

test('handles malformed entries without throwing', () => {
  const doc = {
    schemaVersion: 1,
    rows: {
      'bad.row': null,
      'also.bad': { metric: null },
      'good.row': { longestTaskMsMedian: { ceiling_ms: 100, reason: 'ok' } },
    },
  };
  assert.deepEqual(findSentinelCeilings(doc), []);
});

test('handles entries with non-number ceiling_ms by skipping them', () => {
  const doc = {
    schemaVersion: 1,
    rows: {
      'bad.row': { metric: { ceiling_ms: 'not-a-number', reason: 'ok' } },
    },
  };
  assert.deepEqual(findSentinelCeilings(doc), []);
});
