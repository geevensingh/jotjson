import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertAppInsightsPair,
  executeRequestedPhases,
  getBlobContainers,
  parseAppInsightsPairFromText,
  parseCliOptions,
  validateRestoreTimestamp,
} from './migrate-region.mjs';

test('parseCliOptions rejects missing --paramfile for --preflight', () => {
  assert.throws(() => parseCliOptions(['--preflight']), /--paramfile=<path>/);
});

test('parseCliOptions rejects missing required restore flags', () => {
  assert.throws(
    () => parseCliOptions(['--restore-cosmos', '--paramfile', 'infra/parameters/prod.bicepparam']),
    /--src-account=<name>/,
  );
});

test('app insights pair validation rejects exactly one value set', () => {
  const pair = parseAppInsightsPairFromText(
    "param existingAppInsightsName = 'appi-jotjson-prod'\n",
  );
  assert.throws(() => assertAppInsightsPair(pair), /must be both set or both empty/);
});

test('app insights pair validation accepts neither value set', () => {
  const pair = parseAppInsightsPairFromText("param environmentName = 'prod'\n");
  assert.doesNotThrow(() => assertAppInsightsPair(pair));
});

test('app insights pair validation accepts both values set', () => {
  const pair = parseAppInsightsPairFromText(
    "param existingAppInsightsName = 'appi-jotjson-prod'\nparam existingAppInsightsRg = 'rg-jotjson-monitoring'\n",
  );
  assert.doesNotThrow(() => assertAppInsightsPair(pair));
});

test('--preflight only routes to the preflight handler', async () => {
  const options = parseCliOptions([
    '--preflight',
    '--paramfile',
    'infra/parameters/prod.bicepparam',
  ]);
  const calls = [];
  await executeRequestedPhases(options, {
    preflight: async () => {
      calls.push('preflight');
    },
    predeleteCosmos: async () => {
      calls.push('predelete-cosmos');
    },
    restoreCosmos: async () => {
      calls.push('restore-cosmos');
    },
    regrantCosmosRole: async () => {
      calls.push('regrant-cosmos-role');
    },
    azcopyBlobs: async () => {
      calls.push('azcopy-blobs');
    },
    verifySha: async () => {
      calls.push('verify-sha');
    },
  });
  assert.deepEqual(calls, ['preflight']);
});

test('validateRestoreTimestamp accepts timestamps at or after earliest-restorable', () => {
  const validated = validateRestoreTimestamp(
    '2026-05-01T12:00:00.000Z',
    '2026-05-01T11:30:00.000Z',
  );
  assert.equal(validated.requestedAt.toISOString(), '2026-05-01T12:00:00.000Z');
  assert.equal(validated.earliestAt.toISOString(), '2026-05-01T11:30:00.000Z');
});

test('validateRestoreTimestamp rejects timestamps earlier than earliest-restorable', () => {
  assert.throws(
    () => validateRestoreTimestamp('2026-05-01T11:29:59.000Z', '2026-05-01T11:30:00.000Z'),
    /earlier than earliest-restorable-time/,
  );
});

test('getBlobContainers enumerates avatars, exports, and sourcemaps', () => {
  assert.deepEqual(getBlobContainers(), ['avatars', 'exports', 'sourcemaps']);
});
