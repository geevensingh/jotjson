import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertPerfTargetsSchema,
  PERF_TARGETS_SCHEMA_VERSION,
  readPerfTargets,
} from './perf-targets.mjs';

function withTempFile(filename, body, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'perf-targets-test-'));
  try {
    const path = join(dir, filename);
    writeFileSync(path, body, 'utf8');
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('PERF_TARGETS_SCHEMA_VERSION is exported as 1', () => {
  assert.equal(PERF_TARGETS_SCHEMA_VERSION, 1);
});

test('readPerfTargets parses a well-formed file and returns rows', () => {
  const body = JSON.stringify({
    $schema: './perf-targets.schema.json',
    schemaVersion: 1,
    _comment: 'test fixture',
    rows: {
      '3.paste-large.wide-aoo.1m': {
        longestTaskMsMedian: {
          ceiling_ms: 500,
          reason: 'v1 stress check',
        },
      },
    },
  });
  withTempFile('perf-targets.json', body, (path) => {
    const targets = readPerfTargets(path);
    assert.equal(targets.schemaVersion, 1);
    assert.equal(targets.rows['3.paste-large.wide-aoo.1m'].longestTaskMsMedian.ceiling_ms, 500);
    assert.equal(
      targets.rows['3.paste-large.wide-aoo.1m'].longestTaskMsMedian.reason,
      'v1 stress check',
    );
  });
});

test('readPerfTargets throws when the file is missing', () => {
  const missing = join(
    mkdtempSync(join(tmpdir(), 'perf-targets-missing-')),
    'definitely-not-here.json',
  );
  assert.throws(() => readPerfTargets(missing), /perf-targets\.json not found at/);
});

test('readPerfTargets throws when JSON is malformed', () => {
  withTempFile('perf-targets.json', '{not valid json}', (path) => {
    assert.throws(() => readPerfTargets(path), /is not valid JSON/);
  });
});

test('assertPerfTargetsSchema rejects mismatched schemaVersion with the canonical message', () => {
  assert.throws(
    () => assertPerfTargetsSchema({ schemaVersion: 2, rows: {} }, '/some/path.json'),
    /perf-targets at \/some\/path\.json has schemaVersion=2, expected 1\. Update perf-targets\.json or the reader\./,
  );
});

test('assertPerfTargetsSchema rejects missing schemaVersion', () => {
  assert.throws(
    () => assertPerfTargetsSchema({ rows: {} }, '/some/path.json'),
    /is missing "schemaVersion"/,
  );
});

test('assertPerfTargetsSchema rejects non-object input', () => {
  assert.throws(() => assertPerfTargetsSchema(null, '/some/path.json'), /is not an object/);
  assert.throws(() => assertPerfTargetsSchema(42, '/some/path.json'), /is not an object/);
});

test('assertPerfTargetsSchema rejects rows that are arrays or non-objects', () => {
  assert.throws(
    () => assertPerfTargetsSchema({ schemaVersion: 1, rows: [] }, '/p.json'),
    /is missing "rows" object \(got array\)/,
  );
  assert.throws(
    () => assertPerfTargetsSchema({ schemaVersion: 1 }, '/p.json'),
    /is missing "rows" object/,
  );
});

test('assertPerfTargetsSchema rejects a metric spec without ceiling_ms', () => {
  assert.throws(
    () =>
      assertPerfTargetsSchema(
        {
          schemaVersion: 1,
          rows: {
            '3.paste-large.wide-aoo.1m': {
              longestTaskMsMedian: { reason: 'missing ceiling' },
            },
          },
        },
        '/p.json',
      ),
    /is missing numeric "ceiling_ms"/,
  );
});

test('assertPerfTargetsSchema rejects a metric spec without reason', () => {
  assert.throws(
    () =>
      assertPerfTargetsSchema(
        {
          schemaVersion: 1,
          rows: {
            '3.paste-large.wide-aoo.1m': {
              longestTaskMsMedian: { ceiling_ms: 500, reason: '' },
            },
          },
        },
        '/p.json',
      ),
    /is missing non-empty "reason"/,
  );
});

test('assertPerfTargetsSchema rejects a metric spec that is not an object', () => {
  assert.throws(
    () =>
      assertPerfTargetsSchema(
        {
          schemaVersion: 1,
          rows: {
            '3.paste-large.wide-aoo.1m': { longestTaskMsMedian: 500 },
          },
        },
        '/p.json',
      ),
    /metric "longestTaskMsMedian" must be an object/,
  );
});
