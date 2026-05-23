// Unit tests for scripts/cosmos-back-sync.mjs.

import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_CONTAINERS,
  UsageError,
  buildConflictFilePath,
  buildConflictRecord,
  decideAction,
  parseCliOptions,
} from './cosmos-back-sync.mjs';

const VALID_ARGS = Object.freeze([
  '--src',
  'new-account',
  '--src-rg',
  'new-rg',
  '--dst',
  'old-account',
  '--dst-rg',
  'old-rg',
  '--cutover-instant-unix-seconds',
  '1717200000',
]);

function removeFlag(args, flag) {
  const flagIndex = args.indexOf(flag);
  if (flagIndex === -1) {
    throw new Error(`Missing flag ${flag} in test helper.`);
  }
  return args.filter((_, index) => index !== flagIndex && index !== flagIndex + 1);
}

test('parseCliOptions rejects each missing required flag', () => {
  const requiredFlags = [
    '--src',
    '--src-rg',
    '--dst',
    '--dst-rg',
    '--cutover-instant-unix-seconds',
  ];

  for (const requiredFlag of requiredFlags) {
    assert.throws(
      () => parseCliOptions(removeFlag([...VALID_ARGS], requiredFlag)),
      (error) => error instanceof UsageError && error.message.includes(requiredFlag),
    );
  }
});

test('parseCliOptions accepts --help without requiring other flags', () => {
  assert.deepEqual(parseCliOptions(['--help']), { help: true });
});

test('DEFAULT_CONTAINERS matches the canonical container set', () => {
  assert.deepEqual([...DEFAULT_CONTAINERS], ['blobs', 'users', 'history', 'rule-sets']);
});

test('parseCliOptions defaults database and container names', () => {
  const options = parseCliOptions([...VALID_ARGS]);
  assert.equal(options.databaseName, 'jotjson');
  assert.deepEqual(options.containerNames, ['blobs', 'users', 'history', 'rule-sets']);
});

test('buildConflictFilePath uses an ISO-safe timestamp and dryrun segment', () => {
  const now = new Date('2026-06-01T03:14:22.123Z');
  const standardFileName = basename(buildConflictFilePath({ cwd: 'C:\\Repos\\jotjson-prd', now }));
  const dryRunFileName = basename(
    buildConflictFilePath({ cwd: 'C:\\Repos\\jotjson-prd', dryRun: true, now }),
  );

  assert.equal(standardFileName, 'cosmos-back-sync-conflicts-2026-06-01T03-14-22Z.jsonl');
  assert.equal(dryRunFileName, 'cosmos-back-sync-conflicts-dryrun-2026-06-01T03-14-22Z.jsonl');
  assert.equal(standardFileName.includes(':'), false);
  assert.equal(standardFileName.includes('.123'), false);
});

test('buildConflictRecord returns the required conflict shape', () => {
  const record = buildConflictRecord({
    container: 'blobs',
    id: 'blob-1',
    partitionKey: 'user-1',
    reason: 'old-fresher',
    oldDoc: { _ts: 10, _etag: 'etag-old' },
    newDoc: { _ts: 20, _etag: 'etag-new' },
    attemptedAt: '2026-06-01T03:14:22.000Z',
  });

  assert.deepEqual(record, {
    container: 'blobs',
    id: 'blob-1',
    partitionKey: 'user-1',
    reason: 'old-fresher',
    oldTs: 10,
    newTs: 20,
    oldEtag: 'etag-old',
    newEtag: 'etag-new',
    attemptedAt: '2026-06-01T03:14:22.000Z',
  });
});

test('decideAction returns create when the destination document is missing', () => {
  assert.equal(decideAction(null, { id: 'blob-1', _ts: 5 }), 'create');
});

test('decideAction returns update when the destination document is older', () => {
  assert.equal(decideAction({ id: 'blob-1', _ts: 4 }, { id: 'blob-1', _ts: 5 }), 'update');
});

test('decideAction returns skip-old-fresher when the destination document is as new or newer', () => {
  assert.equal(
    decideAction({ id: 'blob-1', _ts: 5 }, { id: 'blob-1', _ts: 5 }),
    'skip-old-fresher',
  );
  assert.equal(
    decideAction({ id: 'blob-1', _ts: 6 }, { id: 'blob-1', _ts: 5 }),
    'skip-old-fresher',
  );
});
