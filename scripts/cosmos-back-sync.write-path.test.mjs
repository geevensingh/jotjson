// Container-stubbed integration-style tests for syncDocument's write
// path in scripts/cosmos-back-sync.mjs. These tests have a different
// fragility profile than the pure-function tests in
// cosmos-back-sync.test.mjs -- they couple to the @azure/cosmos SDK
// call shape (.item().read()/.replace(), .items.create()) and turn
// over on SDK upgrades, not just on helper changes. SDK-shape
// knowledge is centralized in createFakeDestinationContainer so a
// future SDK migration touches one place rather than N tests.
//
// Scope: helper-level only (no live Cosmos, no emulator). The fake
// satisfies the call surface syncDocument exercises and nothing
// more.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { syncDocument } from './cosmos-back-sync.mjs';

// Shared fake-container builder. Centralizes SDK call-shape
// knowledge: every test parameterizes BEHAVIOR (what read returns,
// what replace throws) but the STRUCTURE of the fake lives here.
function createFakeDestinationContainer({
  readReturns,
  readThrows,
  replaceReturns,
  replaceThrows,
  createReturns,
  createThrows,
} = {}) {
  const calls = {
    read: [],
    replace: [],
    create: [],
  };

  function makeItem(id, partitionKey) {
    return {
      async read() {
        calls.read.push({ id, partitionKey });
        if (readThrows !== undefined) {
          throw readThrows;
        }
        return readReturns ?? { resource: null };
      },
      async replace(document, options) {
        calls.replace.push({ id, partitionKey, document, options });
        if (replaceThrows !== undefined) {
          throw replaceThrows;
        }
        return replaceReturns ?? { resource: document };
      },
    };
  }

  return {
    item: (id, partitionKey) => makeItem(id, partitionKey),
    items: {
      async create(document) {
        calls.create.push({ document });
        if (createThrows !== undefined) {
          throw createThrows;
        }
        return createReturns ?? { resource: document };
      },
    },
    calls,
  };
}

const CONTAINER = 'blobs';
const PARTITION_KEY_PATHS = ['/userId'];
const PARTITION_KEY_VALUE = 'user-abc';
const CUTOVER = 1_717_200_000;

function baseSummary() {
  return {
    container: CONTAINER,
    docsProcessed: 0,
    docsCreated: 0,
    docsUpdated: 0,
    docsSkippedOldFresher: 0,
    docsMalformed: 0,
    conflicts: 0,
  };
}

function newDoc({
  id = 'doc-1',
  userId = PARTITION_KEY_VALUE,
  ts = CUTOVER + 10,
  etag = 'src-etag',
  extra = {},
} = {}) {
  return { id, userId, _ts: ts, _etag: etag, ...extra };
}

function existingDoc({
  id = 'doc-1',
  userId = PARTITION_KEY_VALUE,
  ts = CUTOVER - 10,
  etag = 'dst-etag',
  extra = {},
} = {}) {
  return { id, userId, _ts: ts, _etag: etag, ...extra };
}

let conflictsTempDir;
let conflictsFilePath;
let stdoutChunks;
let originalStdoutWrite;

beforeEach(() => {
  conflictsTempDir = mkdtempSync(join(tmpdir(), 'cosmos-back-sync-test-'));
  conflictsFilePath = join(conflictsTempDir, 'conflicts.jsonl');

  // Capture stdout writes so JSONL event emission doesn't pollute
  // the test reporter and so tests can inspect emitted events.
  stdoutChunks = [];
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
});

afterEach(() => {
  process.stdout.write = originalStdoutWrite;
  rmSync(conflictsTempDir, { recursive: true, force: true });
});

function readConflictsFile() {
  try {
    return readFileSync(conflictsFilePath, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function getStdoutEvents() {
  return stdoutChunks
    .join('')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

async function runSyncDocument({ sourceDocument, destinationContainer, dryRun = false }) {
  const summary = baseSummary();
  await syncDocument({
    sourceDocument,
    containerName: CONTAINER,
    destinationContainer,
    partitionKeyPaths: PARTITION_KEY_PATHS,
    cutoverInstantUnixSeconds: CUTOVER,
    dryRun,
    conflictsFilePath,
    summary,
  });
  return { summary };
}

test('CREATE happy path: destination 404 triggers items.create with source doc, docsCreated bumps', async () => {
  const destinationContainer = createFakeDestinationContainer({
    readThrows: { code: 404, message: 'Not found' },
  });
  const sourceDocument = newDoc({ ts: CUTOVER + 5 });

  const { summary } = await runSyncDocument({ sourceDocument, destinationContainer });

  assert.equal(destinationContainer.calls.read.length, 1);
  assert.equal(destinationContainer.calls.create.length, 1);
  assert.equal(destinationContainer.calls.replace.length, 0);
  assert.deepEqual(destinationContainer.calls.create[0].document, sourceDocument);

  assert.deepEqual(summary, { ...baseSummary(), docsProcessed: 1, docsCreated: 1 });
  assert.equal(readConflictsFile().length, 0);

  const events = getStdoutEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].result, 'created');
  assert.equal(events[0].action, 'create');
});

test('UPDATE happy path: replace uses DESTINATION _etag for IfMatch (not source _etag)', async () => {
  // Distinct etags so a regression that uses sourceDocument._etag as
  // the IfMatch condition is caught loudly.
  const destinationDocument = existingDoc({ ts: CUTOVER - 100, etag: 'dst-etag' });
  const destinationContainer = createFakeDestinationContainer({
    readReturns: { resource: destinationDocument },
  });
  const sourceDocument = newDoc({ ts: CUTOVER + 100, etag: 'src-etag' });

  const { summary } = await runSyncDocument({ sourceDocument, destinationContainer });

  assert.equal(destinationContainer.calls.replace.length, 1);
  const recordedAccessCondition = destinationContainer.calls.replace[0].options.accessCondition;
  assert.equal(recordedAccessCondition.type, 'IfMatch');
  assert.equal(
    recordedAccessCondition.condition,
    'dst-etag',
    'IfMatch condition must be the destination _etag (regression guard)',
  );
  assert.notEqual(
    recordedAccessCondition.condition,
    'src-etag',
    'IfMatch condition must NOT be the source _etag',
  );

  assert.equal(destinationContainer.calls.create.length, 0);
  assert.deepEqual(summary, { ...baseSummary(), docsProcessed: 1, docsUpdated: 1 });
  assert.equal(readConflictsFile().length, 0);
});

test('skip-old-fresher: destination newer than source -> no write, conflict logged', async () => {
  const destinationContainer = createFakeDestinationContainer({
    readReturns: { resource: existingDoc({ ts: CUTOVER + 200, etag: 'dst-etag' }) },
  });
  const sourceDocument = newDoc({ ts: CUTOVER + 100 });

  const { summary } = await runSyncDocument({ sourceDocument, destinationContainer });

  assert.equal(destinationContainer.calls.replace.length, 0);
  assert.equal(destinationContainer.calls.create.length, 0);
  assert.deepEqual(summary, {
    ...baseSummary(),
    docsProcessed: 1,
    docsSkippedOldFresher: 1,
    conflicts: 1,
  });
  const conflicts = readConflictsFile();
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, 'old-fresher');
});

test('412 numeric from replace: classified as concurrent-write, docsUpdated NOT bumped', async () => {
  const destinationContainer = createFakeDestinationContainer({
    readReturns: { resource: existingDoc({ ts: CUTOVER - 5, etag: 'dst-etag' }) },
    replaceThrows: { code: 412, message: 'Precondition failed' },
  });

  const { summary } = await runSyncDocument({
    sourceDocument: newDoc({ ts: CUTOVER + 50 }),
    destinationContainer,
  });

  assert.deepEqual(summary, { ...baseSummary(), docsProcessed: 1, conflicts: 1 });
  const conflicts = readConflictsFile();
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, 'concurrent-write');

  const failed = getStdoutEvents().find((event) => event.result === 'failed');
  assert.equal(failed.reason, 'concurrent-write');
  assert.equal(failed.errorCode, 412);
});

test('409 numeric from replace: classified as concurrent-write', async () => {
  const destinationContainer = createFakeDestinationContainer({
    readReturns: { resource: existingDoc({ ts: CUTOVER - 5, etag: 'dst-etag' }) },
    replaceThrows: { code: 409, message: 'Conflict' },
  });

  const { summary } = await runSyncDocument({
    sourceDocument: newDoc({ ts: CUTOVER + 50 }),
    destinationContainer,
  });

  assert.deepEqual(summary, { ...baseSummary(), docsProcessed: 1, conflicts: 1 });
  const failed = getStdoutEvents().find((event) => event.result === 'failed');
  assert.equal(failed.reason, 'concurrent-write');
  assert.equal(failed.errorCode, 409);
});

test("string alias 'PreconditionFailed' from replace: classified as concurrent-write with errorCode 412", async () => {
  // Composition check between getErrorCode's alias normalization
  // and the write-path classifier branch. Without this, a
  // regression that removes 'PreconditionFailed' from the alias
  // map would silently reclassify a real 412 as 'unknown'.
  const destinationContainer = createFakeDestinationContainer({
    readReturns: { resource: existingDoc({ ts: CUTOVER - 5, etag: 'dst-etag' }) },
    replaceThrows: { code: 'PreconditionFailed', message: 'Precondition failed' },
  });

  const { summary } = await runSyncDocument({
    sourceDocument: newDoc({ ts: CUTOVER + 50 }),
    destinationContainer,
  });

  assert.deepEqual(summary, { ...baseSummary(), docsProcessed: 1, conflicts: 1 });
  const failed = getStdoutEvents().find((event) => event.result === 'failed');
  assert.equal(failed.reason, 'concurrent-write');
  assert.equal(failed.errorCode, 412, 'string alias must normalize to numeric 412');
});

test('500 from replace: classified as unknown', async () => {
  const destinationContainer = createFakeDestinationContainer({
    readReturns: { resource: existingDoc({ ts: CUTOVER - 5, etag: 'dst-etag' }) },
    replaceThrows: { code: 500, message: 'Internal' },
  });

  const { summary } = await runSyncDocument({
    sourceDocument: newDoc({ ts: CUTOVER + 50 }),
    destinationContainer,
  });

  assert.deepEqual(summary, { ...baseSummary(), docsProcessed: 1, conflicts: 1 });
  const failed = getStdoutEvents().find((event) => event.result === 'failed');
  assert.equal(failed.reason, 'unknown');
  assert.equal(failed.errorCode, 500);
});

test('items.create throws 409: classified as concurrent-write', async () => {
  // The create path goes through the same inner try/catch as the
  // replace path. Covers a Cosmos unique-key conflict on create.
  const destinationContainer = createFakeDestinationContainer({
    readThrows: { code: 404 },
    createThrows: { code: 409, message: 'Conflict on create' },
  });

  const { summary } = await runSyncDocument({
    sourceDocument: newDoc({ ts: CUTOVER + 50 }),
    destinationContainer,
  });

  assert.equal(destinationContainer.calls.create.length, 1);
  assert.deepEqual(summary, { ...baseSummary(), docsProcessed: 1, conflicts: 1 });
  const failed = getStdoutEvents().find((event) => event.result === 'failed');
  assert.equal(failed.reason, 'concurrent-write');
  assert.equal(failed.errorCode, 409);
});

test('dry-run UPDATE: counter bumped, no replace call, event result=planned', async () => {
  const destinationContainer = createFakeDestinationContainer({
    readReturns: { resource: existingDoc({ ts: CUTOVER - 5, etag: 'dst-etag' }) },
  });

  const { summary } = await runSyncDocument({
    sourceDocument: newDoc({ ts: CUTOVER + 50 }),
    destinationContainer,
    dryRun: true,
  });

  assert.equal(destinationContainer.calls.replace.length, 0, 'no replace in dry-run');
  assert.equal(destinationContainer.calls.create.length, 0);
  assert.deepEqual(summary, { ...baseSummary(), docsProcessed: 1, docsUpdated: 1 });
  const events = getStdoutEvents();
  const planned = events.find((event) => event.result === 'planned');
  assert.ok(planned, 'expected a planned event in dry-run');
  assert.equal(planned.dryRun, true);
  assert.equal(planned.action, 'update');
});

test('dry-run CREATE: counter bumped, no items.create call, event result=planned', async () => {
  const destinationContainer = createFakeDestinationContainer({ readThrows: { code: 404 } });

  const { summary } = await runSyncDocument({
    sourceDocument: newDoc({ ts: CUTOVER + 50 }),
    destinationContainer,
    dryRun: true,
  });

  assert.equal(destinationContainer.calls.create.length, 0, 'no items.create in dry-run');
  assert.deepEqual(summary, { ...baseSummary(), docsProcessed: 1, docsCreated: 1 });
  const planned = getStdoutEvents().find((event) => event.result === 'planned');
  assert.ok(planned, 'expected a planned event in dry-run');
  assert.equal(planned.dryRun, true);
  assert.equal(planned.action, 'create');
});

test('pre-cutover filter (CORRECTNESS): _ts < cutover -> no read, no write, no summary change', async () => {
  // The cutover-instant filter is CORRECTNESS, not perf: change feed
  // has ~1-second granularity, so iterating without the filter
  // replays the restored snapshot from pre-cutover state.
  const destinationContainer = createFakeDestinationContainer();
  const { summary } = await runSyncDocument({
    sourceDocument: newDoc({ ts: CUTOVER - 1 }),
    destinationContainer,
  });

  assert.equal(destinationContainer.calls.read.length, 0);
  assert.equal(destinationContainer.calls.replace.length, 0);
  assert.equal(destinationContainer.calls.create.length, 0);
  assert.deepEqual(summary, baseSummary());
  assert.equal(getStdoutEvents().length, 0);
});

test('readDestinationDocument 500 (not 404): inspect/failed/unknown, no write attempted', async () => {
  const destinationContainer = createFakeDestinationContainer({
    readThrows: { code: 500, message: 'Internal' },
  });

  const { summary } = await runSyncDocument({
    sourceDocument: newDoc({ ts: CUTOVER + 50 }),
    destinationContainer,
  });

  assert.equal(destinationContainer.calls.read.length, 1);
  assert.equal(destinationContainer.calls.replace.length, 0);
  assert.equal(destinationContainer.calls.create.length, 0);
  assert.deepEqual(summary, { ...baseSummary(), docsProcessed: 1, conflicts: 1 });

  const conflicts = readConflictsFile();
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, 'unknown');

  const failed = getStdoutEvents().find((event) => event.result === 'failed');
  assert.equal(failed.action, 'inspect');
  assert.equal(failed.reason, 'unknown');
  assert.equal(failed.errorCode, 500);
});

test('malformed source (missing id): outer try/catch logs malformed-source, no write attempted', async () => {
  // Fix-1's outer try/catch covers throws from id validation,
  // extractPartitionKeyValue, and decideAction. Without the
  // try/catch, a single malformed source doc would crash the
  // entire rollback. This test pins the malformed-source branch
  // so a regression that removes it is caught.
  const destinationContainer = createFakeDestinationContainer();
  const sourceDocument = {
    _ts: CUTOVER + 50,
    _etag: 'src-etag',
    userId: PARTITION_KEY_VALUE,
  };

  const { summary } = await runSyncDocument({ sourceDocument, destinationContainer });

  assert.equal(destinationContainer.calls.read.length, 0);
  assert.equal(destinationContainer.calls.replace.length, 0);
  assert.equal(destinationContainer.calls.create.length, 0);

  assert.deepEqual(summary, { ...baseSummary(), docsMalformed: 1, conflicts: 1 });
  const conflicts = readConflictsFile();
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, 'malformed-source');
  assert.equal(conflicts[0].id, '<unknown>');

  const failed = getStdoutEvents().find((event) => event.result === 'failed');
  assert.equal(failed.reason, 'malformed-source');
  assert.equal(failed.id, '<unknown>');
});

// ---------------------------------------------------------------------------
// iter-4: malformed `_ts` is classified as 'malformed-source' (not silently
// skipped) -- closes the doc/code drift introduced in iter-3 commit 0128f9b.
// ---------------------------------------------------------------------------

function makeBadTsSource(badTs) {
  const sourceDocument = {
    id: 'doc-bad-ts',
    _etag: 'src-etag',
    userId: PARTITION_KEY_VALUE,
  };
  if (badTs !== 'MISSING') {
    sourceDocument._ts = badTs;
  }
  return sourceDocument;
}

for (const [label, badTs] of [
  ['missing', 'MISSING'],
  ['non-numeric string', '1234'],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['negative Infinity', Number.NEGATIVE_INFINITY],
  ['null', null],
]) {
  test(`malformed _ts (${label}): classified as malformed-source, no read, no write, summary delta pinned`, async () => {
    // iter-3 commit 0128f9b documented `_ts` validation failures as
    // 'malformed-source' in the conflict-file contract, but the code
    // at line 489 silently dropped them via `!Number.isFinite || _ts <
    // cutover` -- pre-cutover filter and validity gate conflated in
    // one `||`. iter-4 split them: the pre-cutover filter requires
    // `Number.isFinite(_ts) && _ts < cutover`, and a separate explicit
    // throw inside the try block classifies bad _ts as malformed-source.
    const destinationContainer = createFakeDestinationContainer();
    const sourceDocument = makeBadTsSource(badTs);

    const { summary } = await runSyncDocument({ sourceDocument, destinationContainer });

    assert.equal(destinationContainer.calls.read.length, 0, 'no read for malformed _ts');
    assert.equal(destinationContainer.calls.replace.length, 0);
    assert.equal(destinationContainer.calls.create.length, 0);

    // Full summary delta: docsProcessed MUST stay 0 (throw fires
    // before the docsProcessed += 1 line), docsMalformed bumps,
    // conflicts bumps. assert.deepEqual against the full baseline
    // pins the ordering invariant, not just individual counters.
    assert.deepEqual(summary, { ...baseSummary(), docsMalformed: 1, conflicts: 1 });

    const conflicts = readConflictsFile();
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].reason, 'malformed-source');
    // id matches actual source id (not '<unknown>'), because the id
    // check fires BEFORE the _ts check inside the try block.
    assert.equal(conflicts[0].id, 'doc-bad-ts');

    const failed = getStdoutEvents().find((event) => event.result === 'failed');
    assert.equal(failed.reason, 'malformed-source');
    assert.equal(failed.id, 'doc-bad-ts');
    // Pin the errorCode format so runbook jq examples don't silently
    // rot under future refactors.
    assert.match(failed.errorCode, /missing a numeric _ts/);
  });
}

test('pre-cutover x non-numeric _ts (regression-prevention): bad _ts is NOT silently skipped by the pre-cutover filter', async () => {
  // Regression-detection for the very bug iter-4 fixes: a future
  // "optimize the filter" refactor that reverts the `&&` to `||`
  // would silently re-drop docs with non-numeric _ts whose numeric
  // comparison would short-circuit (e.g., `null < cutover` is true,
  // `'abc' < cutover` is false but NaN propagation differs by engine).
  // The new `&&` guard means only finite-numeric _ts reaches the
  // silent-skip return.
  const destinationContainer = createFakeDestinationContainer();
  const sourceDocument = makeBadTsSource(null);

  const { summary } = await runSyncDocument({ sourceDocument, destinationContainer });

  assert.equal(destinationContainer.calls.read.length, 0);
  assert.deepEqual(summary, { ...baseSummary(), docsMalformed: 1, conflicts: 1 });
  const failed = getStdoutEvents().find((event) => event.result === 'failed');
  assert.equal(failed.reason, 'malformed-source');
});

test('_ts === cutover boundary: strictly-less-than semantics means equal _ts is processed (not skipped)', async () => {
  // Pin strict-less-than. A future off-by-one revert to `<=` would
  // silently skip docs whose _ts equals the cutover instant.
  const destinationContainer = createFakeDestinationContainer({ readThrows: { code: 404 } });
  const sourceDocument = newDoc({ ts: CUTOVER });

  const { summary } = await runSyncDocument({ sourceDocument, destinationContainer });

  assert.equal(destinationContainer.calls.read.length, 1, 'doc at cutover MUST be processed');
  assert.deepEqual(summary, { ...baseSummary(), docsProcessed: 1, docsCreated: 1 });
});

test('id missing AND _ts NaN: id check fires first -> conflict logged with id <unknown>', async () => {
  // Pin the inside-try ordering: id validation runs before _ts
  // validation. A future reorder (e.g., "validate _ts first because
  // it is cheaper") would silently change the conflict-row id from
  // '<unknown>' (operator-friendly) to whatever the doc had. Pin
  // the user-facing artifact so the reorder doesn't slip through.
  const destinationContainer = createFakeDestinationContainer();
  const sourceDocument = {
    _ts: Number.NaN,
    _etag: 'src-etag',
    userId: PARTITION_KEY_VALUE,
    // no id property -> destructure yields `id = undefined`
  };

  const { summary } = await runSyncDocument({ sourceDocument, destinationContainer });

  assert.deepEqual(summary, { ...baseSummary(), docsMalformed: 1, conflicts: 1 });
  const conflicts = readConflictsFile();
  assert.equal(conflicts[0].id, '<unknown>', 'id check fires before _ts check');
  const failed = getStdoutEvents().find((event) => event.result === 'failed');
  assert.match(
    failed.errorCode,
    /without a valid id/,
    'errorCode reflects the id failure, not the _ts failure',
  );
});
