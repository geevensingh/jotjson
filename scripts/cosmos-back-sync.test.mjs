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
  getErrorCode,
  main,
  parseCliOptions,
  warnDeletesNotReplayed,
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
  '--accept-delete-loss',
]);

function removeFlag(args, flag) {
  const flagIndex = args.indexOf(flag);
  if (flagIndex === -1) {
    throw new Error(`Missing flag ${flag} in test helper.`);
  }
  // Boolean flags take no value; remove only the flag itself.
  const flagsWithoutValues = new Set(['--accept-delete-loss', '--dry-run', '--help']);
  if (flagsWithoutValues.has(flag)) {
    return args.filter((_, index) => index !== flagIndex);
  }
  return args.filter((_, index) => index !== flagIndex && index !== flagIndex + 1);
}

function replaceFlagValue(args, flag, newValue) {
  const flagIndex = args.indexOf(flag);
  if (flagIndex === -1) {
    throw new Error(`Missing flag ${flag} in test helper.`);
  }
  const copy = [...args];
  copy[flagIndex + 1] = newValue;
  return copy;
}

function createStreamCapture() {
  const chunks = [];
  return {
    chunks,
    write(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    },
    get text() {
      return chunks.join('');
    },
  };
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

test('parseCliOptions defaults database, container names, and accept-delete-loss', () => {
  const options = parseCliOptions(removeFlag([...VALID_ARGS], '--accept-delete-loss'));
  assert.equal(options.databaseName, 'jotjson');
  assert.deepEqual(options.containerNames, ['blobs', 'users', 'history', 'rule-sets']);
  assert.equal(options.acceptDeleteLoss, false);
  assert.equal(options.dryRun, false);
});

test('parseCliOptions sets acceptDeleteLoss true when the flag is present', () => {
  const options = parseCliOptions([...VALID_ARGS]);
  assert.equal(options.acceptDeleteLoss, true);
});

test('parseCliOptions rejects partial-numeric cutover-instant values', () => {
  const partialNumericCases = [
    '1717200000abc',
    '1717200000.9',
    '+1717200000',
    '1e9',
    '-1717200000',
    'NaN',
    'Infinity',
    '',
  ];

  for (const badValue of partialNumericCases) {
    const args =
      badValue === ''
        ? removeFlag([...VALID_ARGS], '--cutover-instant-unix-seconds')
        : replaceFlagValue([...VALID_ARGS], '--cutover-instant-unix-seconds', badValue);
    assert.throws(
      () => parseCliOptions(args),
      (error) => error instanceof UsageError,
      `Expected rejection for cutover-instant value ${JSON.stringify(badValue)}`,
    );
  }
});

test('parseCliOptions accepts digit-only cutover-instant values including leading zeros and surrounding whitespace', () => {
  const acceptableCases = [
    ['1717200000', 1717200000],
    ['01717200000', 1717200000],
    ['0', 0],
    [' 1717200000 ', 1717200000],
  ];

  for (const [raw, expected] of acceptableCases) {
    const options = parseCliOptions(
      replaceFlagValue([...VALID_ARGS], '--cutover-instant-unix-seconds', raw),
    );
    assert.equal(options.cutoverInstantUnixSeconds, expected);
  }
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

test('getErrorCode returns numeric codes for numeric and digit-string code shapes', () => {
  assert.equal(getErrorCode({ code: 412 }), 412);
  assert.equal(getErrorCode({ code: 404 }), 404);
  assert.equal(getErrorCode({ code: 409 }), 409);
  assert.equal(getErrorCode({ code: '412' }), 412);
  assert.equal(getErrorCode({ code: '404' }), 404);
});

test('getErrorCode normalizes evidence-backed Cosmos string aliases', () => {
  // Adopted aliases - see api/src/shared/cosmos.ts:isCosmosPreconditionFailed
  // for the canonical precedent on PreconditionFailed; NotFound is added
  // here because the destination-read 404 path (readDestinationDocument)
  // would otherwise silently misclassify a 404-as-string as 'unknown'
  // and skip the items.create path that the script's per-doc strategy
  // depends on.
  assert.equal(getErrorCode({ code: 'PreconditionFailed' }), 412);
  assert.equal(getErrorCode({ code: 'NotFound' }), 404);
});

test('getErrorCode returns null for unrecognized string codes', () => {
  // 'Conflict' is intentionally not in the alias map until SDK source
  // evidence emerges; documented in the PR-D rubber-duck gate.
  assert.equal(getErrorCode({ code: 'Conflict' }), null);
  assert.equal(getErrorCode({ code: 'SomeOtherCode' }), null);
  assert.equal(getErrorCode({ code: '' }), null);
});

test('getErrorCode returns null for non-object inputs and missing code', () => {
  assert.equal(getErrorCode(null), null);
  assert.equal(getErrorCode(undefined), null);
  assert.equal(getErrorCode('PreconditionFailed'), null);
  assert.equal(getErrorCode(412), null);
  assert.equal(getErrorCode({}), null);
  assert.equal(getErrorCode({ code: null }), null);
  assert.equal(getErrorCode({ code: undefined }), null);
  assert.equal(getErrorCode({ code: NaN }), null);
  assert.equal(getErrorCode({ code: true }), null);
});

test('warnDeletesNotReplayed writes the limitation text to the provided stream', () => {
  const stderr = createStreamCapture();
  warnDeletesNotReplayed(stderr);
  assert.match(stderr.text, /change feed/i);
  assert.match(stderr.text, /delete/i);
  assert.match(stderr.text, /blobs/);
  assert.match(stderr.text, /history/);
  assert.match(stderr.text, /rule-sets/);
});

test('main refuses to run without --accept-delete-loss and exits 1', async () => {
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    const stderr = createStreamCapture();
    await main(removeFlag([...VALID_ARGS], '--accept-delete-loss'), { stderr });
    assert.equal(process.exitCode, 1);
    assert.match(stderr.text, /--accept-delete-loss/);
    assert.match(stderr.text, /change feed/i);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('main treats UsageError as exit 1 and writes usage to the provided stream', async () => {
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    const stderr = createStreamCapture();
    await main(['--src', 'only-one-flag'], { stderr });
    assert.equal(process.exitCode, 1);
    assert.match(stderr.text, /Missing required arguments/);
    assert.match(stderr.text, /--accept-delete-loss/);
  } finally {
    process.exitCode = previousExitCode;
  }
});
