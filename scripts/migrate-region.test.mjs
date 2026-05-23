import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import {
  assertAppInsightsPair,
  deriveEarliestRestorable,
  executeRequestedPhases,
  getBlobContainers,
  normalizeHostname,
  normalizeSpawnResult,
  parseAppInsightsPairFromText,
  parseCliOptions,
  REPO_ROOT,
  resolveRepoRelativePath,
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

test('--preflight alone runs only preflight', async () => {
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

test('--verify-sha alone still runs the preflight safety gate first', async () => {
  const options = parseCliOptions([
    '--verify-sha',
    '--new-swa-hostname',
    'example.com',
    '--expected-sha',
    'abc1234',
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
  assert.deepEqual(calls, ['preflight', 'verify-sha']);
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

test('deriveEarliestRestorable reads creationTime (Azure field name)', () => {
  const entries = [
    { creationTime: '2026-05-01T11:30:00.000Z' },
    { creationTime: '2026-05-01T11:00:00.000Z' },
  ];
  assert.equal(deriveEarliestRestorable(entries, 'cosmos-jotjson-dev'), '2026-05-01T11:00:00.000Z');
});

test('deriveEarliestRestorable throws when entries lack creationTime', () => {
  assert.throws(
    () => deriveEarliestRestorable([{ name: 'x' }], 'cosmos-jotjson-dev'),
    /did not include creationTime/,
  );
});

test('normalizeHostname accepts a bare FQDN', () => {
  assert.equal(normalizeHostname('example.com'), 'example.com');
});

test('normalizeHostname accepts an https:// URL', () => {
  assert.equal(normalizeHostname('https://example.com'), 'example.com');
});

test('normalizeHostname preserves non-default port', () => {
  assert.equal(normalizeHostname('example.com:1234'), 'example.com:1234');
});

test('normalizeHostname strips default https port', () => {
  assert.equal(normalizeHostname('https://example.com:443'), 'example.com');
});

test('normalizeHostname rejects path components', () => {
  assert.throws(() => normalizeHostname('example.com/foo'), /path components are not allowed/);
  assert.throws(
    () => normalizeHostname('https://example.com/foo'),
    /path components are not allowed/,
  );
});

test('normalizeHostname rejects query strings', () => {
  assert.throws(() => normalizeHostname('https://example.com?x=1'), /query string is not allowed/);
});

test('normalizeHostname rejects fragments', () => {
  assert.throws(() => normalizeHostname('https://example.com#frag'), /fragment is not allowed/);
});

test('normalizeHostname rejects userinfo (silent credential drop)', () => {
  assert.throws(
    () => normalizeHostname('https://user:secret@example.com'),
    /userinfo .* is not allowed/,
  );
});

test('normalizeHostname rejects explicit http:// (silent protocol upgrade)', () => {
  assert.throws(
    () => normalizeHostname('http://example.com'),
    /explicit http:\/\/ scheme not allowed/,
  );
});

test('normalizeHostname rejects empty hostname after parse', () => {
  // A path-only string like "/just/a/path" prepends to "https:///just/a/path"
  // -> empty hostname. Older code would have returned garbage downstream.
  assert.throws(() => normalizeHostname('/just/a/path'), /hostname is empty|path components/);
});

test('normalizeSpawnResult throws when subprocess terminates by signal', () => {
  assert.throws(
    () =>
      normalizeSpawnResult({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' }, 'az', [
        'cosmosdb',
        'show',
      ]),
    /terminated by signal SIGTERM/,
  );
});

test('normalizeSpawnResult throws when subprocess terminates without an exit status or signal', () => {
  assert.throws(
    () =>
      normalizeSpawnResult({ status: null, signal: null, stdout: '', stderr: '' }, 'az', ['show']),
    /terminated without an exit status/,
  );
});

test('normalizeSpawnResult propagates spawn errors', () => {
  assert.throws(
    () => normalizeSpawnResult({ error: new Error('ENOENT') }, 'az', ['show']),
    /Failed to spawn az show: ENOENT/,
  );
});

test('normalizeSpawnResult returns normalized success payload', () => {
  const result = normalizeSpawnResult({ status: 0, stdout: 'ok\n', stderr: '' }, 'az', ['show']);
  assert.deepEqual(result, { status: 0, stdout: 'ok\n', stderr: '' });
});

test('resolveRepoRelativePath resolves relative paths against REPO_ROOT (not CWD)', () => {
  const result = resolveRepoRelativePath('infra/parameters/prod.bicepparam');
  assert.equal(result, path.resolve(REPO_ROOT, 'infra', 'parameters', 'prod.bicepparam'));
});

test('resolveRepoRelativePath honors absolute paths', () => {
  const absolute = process.platform === 'win32' ? 'C:\\absolute\\paramfile' : '/absolute/paramfile';
  assert.equal(resolveRepoRelativePath(absolute), absolute);
});

test('resolveRepoRelativePath returns empty string for empty input', () => {
  assert.equal(resolveRepoRelativePath(''), '');
  assert.equal(resolveRepoRelativePath(undefined), '');
});
