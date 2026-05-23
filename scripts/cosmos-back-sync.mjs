#!/usr/bin/env node
// scripts/cosmos-back-sync.mjs
//
// Post-cutover rollback back-sync. Replays writes from the NEW Cosmos
// account (post-cutover) to the OLD Cosmos account (rollback target).
//
// CRITICAL: This script is the rollback insurance artifact for the
// region migration. It is invoked ONLY when the operator decides to
// roll back the cutover within the 7-day soak window.
//
// Operators obtain account keys before running the script:
//   az cosmosdb keys list -n <account> -g <rg> --type keys --query primaryMasterKey -o tsv
//
// Required args:
//   --src <account-name>              NEW account (read from).
//   --src-rg <rg-name>                NEW account RG.
//   --dst <account-name>              OLD account (write to).
//   --dst-rg <rg-name>                OLD account RG.
//   --cutover-instant-unix-seconds N  Cutover moment. The per-doc
//                                     filter at sourceDocument._ts <
//                                     cutoverInstantUnixSeconds is
//                                     CORRECTNESS, not just perf: the
//                                     Cosmos change feed has ~1-second
//                                     resolution and may emit docs
//                                     whose _ts is slightly before the
//                                     requested instant. Removing the
//                                     filter would replay pre-cutover
//                                     writes.
//   --accept-delete-loss              REQUIRED opt-in. The standard
//                                     Cosmos change feed does NOT
//                                     emit deletes. Without this flag
//                                     the script refuses to run. See
//                                     "Known limitation" below.
//   --database <name>                 Cosmos database name (default 'jotjson').
//   --containers <comma-separated>    Optional. Default: all four
//                                     (blobs,users,history,rule-sets).
//   --dry-run                         Print planned ops; don't write.
//
// Known limitation - deletes are not replayed:
//   The Cosmos change feed in standard (latest-version) mode emits
//   only live document versions. Documents deleted on the NEW account
//   between cutover and back-sync are invisible to this script and
//   will resurrect on the OLD account after rollback. The
//   AllVersionsAndDeletes change-feed mode would capture deletes but
//   requires changeFeedPolicy.retentionDuration to be set on the
//   container BEFORE the deletes happen; retention is forward-looking
//   only and cannot recover deletes that already occurred. Affected
//   containers: blobs, history, rule-sets. The users container has no
//   delete path in production code and is unaffected. After running
//   the back-sync, perform a post-rollback diff reconciliation per
//   container to surface resurrected documents for manual review.
//
// Per-doc strategy:
//   For each doc in the NEW account's change feed (filtered to
//   _ts >= cutoverInstant):
//     1. GET doc from OLD account by partitionKey + id.
//     2. If 404: unconditional CREATE on OLD (new post-cutover doc).
//     3. If 200 and oldDoc._ts < newDoc._ts: write with If-Match
//        on oldDoc._etag. 412 -> log to conflicts file.
//     4. If 200 and oldDoc._ts >= newDoc._ts: skip + log 'old-fresher'.
//
// Conflicts file:
//   cosmos-back-sync-conflicts-<ISO8601>.jsonl in CWD.
//   --dry-run uses cosmos-back-sync-conflicts-dryrun-<ISO8601>.jsonl.
//   One JSON object per line. Fields:
//     {container, id, partitionKey, reason, oldTs, newTs,
//      oldEtag, newEtag, attemptedAt}
//   reason:
//     'old-fresher'       - oldDoc._ts >= newDoc._ts; left in place.
//     'concurrent-write'  - 412/409 from replace/items.create.
//     'malformed-source'  - source doc failed id / partition-key /
//                           _ts validation; logged with id
//                           '<unknown>' when the id itself is bad.
//                           Operators reconciling rollbacks must
//                           investigate these rows manually because
//                           the script could not classify them.
//     'unknown'           - other errors (e.g. 5xx from read or
//                           write); manual investigation required.
//
// Authentication:
//   Key-only. Provide COSMOS_SRC_KEY and COSMOS_DST_KEY in the
//   environment at invocation time.

import { ChangeFeedStartFrom, CosmosClient } from '@azure/cosmos';
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const DEFAULT_CONTAINERS = Object.freeze(['blobs', 'users', 'history', 'rule-sets']);

export const USAGE = `Usage:
  node scripts/cosmos-back-sync.mjs --src <account-name> --src-rg <rg-name> --dst <account-name> --dst-rg <rg-name> --cutover-instant-unix-seconds <unix-seconds> --accept-delete-loss [--database <name>] [--containers <comma-separated>] [--dry-run]
  node scripts/cosmos-back-sync.mjs --help

Options:
  --src <account-name>              NEW account (read from).
  --src-rg <rg-name>                NEW account RG.
  --dst <account-name>              OLD account (write to).
  --dst-rg <rg-name>                OLD account RG.
  --cutover-instant-unix-seconds N  Cutover moment (non-negative integer).
  --accept-delete-loss              REQUIRED. Acknowledges that the
                                    standard Cosmos change feed does
                                    not replay deletes; the script
                                    refuses to run without this flag.
  --database <name>                 Cosmos database name (default: jotjson).
  --containers <comma-separated>    Optional. Default: blobs,users,history,rule-sets.
  --dry-run                         Print planned ops; do not write.
  --help                            Print this usage text.

Environment:
  COSMOS_SRC_KEY                    Source account primary key.
  COSMOS_DST_KEY                    Destination account primary key.`;

const IF_MATCH = 'IfMatch';
const NOT_MODIFIED_STATUS_CODE = 304;
const NOT_FOUND_STATUS_CODE = 404;
const CONFLICT_STATUS_CODE = 409;
const PRECONDITION_FAILED_STATUS_CODE = 412;

export class UsageError extends Error {}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseContainerNames(rawContainerNames) {
  if (typeof rawContainerNames !== 'string' || rawContainerNames.trim() === '') {
    return [...DEFAULT_CONTAINERS];
  }

  const containerNames = [
    ...new Set(rawContainerNames.split(',').map((containerName) => containerName.trim())),
  ].filter((containerName) => containerName !== '');

  if (containerNames.length === 0) {
    throw new UsageError('The --containers value must include at least one container name.');
  }

  return containerNames;
}

export function parseCliOptions(args = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        help: { type: 'boolean' },
        src: { type: 'string' },
        'src-rg': { type: 'string' },
        dst: { type: 'string' },
        'dst-rg': { type: 'string' },
        'cutover-instant-unix-seconds': { type: 'string' },
        'accept-delete-loss': { type: 'boolean' },
        database: { type: 'string' },
        containers: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  if (values.help === true) {
    return { help: true };
  }

  const sourceAccount = normalizeString(values.src);
  const sourceResourceGroup = normalizeString(values['src-rg']);
  const destinationAccount = normalizeString(values.dst);
  const destinationResourceGroup = normalizeString(values['dst-rg']);
  const cutoverInstantRaw = normalizeString(values['cutover-instant-unix-seconds']);

  const missingArguments = [];
  if (sourceAccount === '') {
    missingArguments.push('--src');
  }
  if (sourceResourceGroup === '') {
    missingArguments.push('--src-rg');
  }
  if (destinationAccount === '') {
    missingArguments.push('--dst');
  }
  if (destinationResourceGroup === '') {
    missingArguments.push('--dst-rg');
  }
  if (cutoverInstantRaw === '') {
    missingArguments.push('--cutover-instant-unix-seconds');
  }

  if (missingArguments.length > 0) {
    throw new UsageError(`Missing required arguments: ${missingArguments.join(', ')}`);
  }

  if (!/^\d+$/u.test(cutoverInstantRaw)) {
    throw new UsageError(
      'The --cutover-instant-unix-seconds value must be a base-10 non-negative integer (digits only).',
    );
  }
  const cutoverInstantUnixSeconds = Number.parseInt(cutoverInstantRaw, 10);
  if (!Number.isSafeInteger(cutoverInstantUnixSeconds) || cutoverInstantUnixSeconds < 0) {
    throw new UsageError(
      'The --cutover-instant-unix-seconds value must be a non-negative integer.',
    );
  }

  const databaseName = normalizeString(values.database) || 'jotjson';

  return {
    help: false,
    sourceAccount,
    sourceResourceGroup,
    destinationAccount,
    destinationResourceGroup,
    cutoverInstantUnixSeconds,
    databaseName,
    containerNames: parseContainerNames(values.containers),
    acceptDeleteLoss: values['accept-delete-loss'] === true,
    dryRun: values['dry-run'] === true,
  };
}

export function formatTimestampForFile(now = new Date()) {
  return new Date(now)
    .toISOString()
    .replace(/\.\d{3}Z$/u, 'Z')
    .replace(/:/gu, '-');
}

export function buildConflictFilePath({
  cwd = process.cwd(),
  dryRun = false,
  now = new Date(),
} = {}) {
  const dryRunSegment = dryRun ? 'dryrun-' : '';
  return resolve(
    cwd,
    `cosmos-back-sync-conflicts-${dryRunSegment}${formatTimestampForFile(now)}.jsonl`,
  );
}

export function buildConflictRecord({
  container,
  id,
  partitionKey,
  reason,
  oldDoc = null,
  newDoc = null,
  attemptedAt = new Date().toISOString(),
}) {
  return {
    container,
    id,
    partitionKey: partitionKey ?? null,
    reason,
    oldTs: oldDoc?._ts ?? null,
    newTs: newDoc?._ts ?? null,
    oldEtag: oldDoc?._etag ?? null,
    newEtag: newDoc?._etag ?? null,
    attemptedAt,
  };
}

export function decideAction(oldDoc, newDoc) {
  if (newDoc === null || typeof newDoc !== 'object') {
    throw new Error('A new document is required to decide the sync action.');
  }
  if (!Number.isFinite(newDoc._ts)) {
    throw new Error(`Document ${newDoc.id ?? '<unknown>'} is missing a numeric _ts.`);
  }
  if (oldDoc === null) {
    return 'create';
  }
  if (!Number.isFinite(oldDoc._ts)) {
    throw new Error(`Existing document ${oldDoc.id ?? '<unknown>'} is missing a numeric _ts.`);
  }
  return oldDoc._ts < newDoc._ts ? 'update' : 'skip-old-fresher';
}

function writeJsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function appendConflictRecord(conflictsFilePath, record) {
  appendFileSync(conflictsFilePath, `${JSON.stringify(record)}\n`, 'utf8');
}

function writeUsage(stream) {
  stream.write(`${USAGE}\n`);
}

function getRequiredKey(variableName, accountName, resourceGroup) {
  const key = normalizeString(process.env[variableName]);
  if (key !== '') {
    return key;
  }

  throw new Error(
    `Missing ${variableName}. Retrieve it with: az cosmosdb keys list -n ${accountName} -g ${resourceGroup} --type keys --query primaryMasterKey -o tsv`,
  );
}

/**
 * Emits the deletes-not-replayed warning to the provided stderr-like
 * stream. Extracted so unit tests can inject a capturing stream
 * instead of asserting against process.stderr. See "Known limitation"
 * in the header for the full mechanism description.
 */
export function warnDeletesNotReplayed(stderr = process.stderr) {
  stderr.write(
    'WARNING: The standard Cosmos change feed does NOT replay deletes. ' +
      'Documents deleted on the NEW account between cutover and back-sync are invisible ' +
      'to this script and will resurrect on the OLD account after rollback. ' +
      'Affected containers: blobs, history, rule-sets. The users container has no ' +
      'delete path in production code and is unaffected. ' +
      'After running the back-sync, perform a post-rollback per-container diff ' +
      'reconciliation to surface resurrected documents for manual review.\n',
  );
}

/**
 * Normalized Cosmos string-code aliases to numeric HTTP-status codes.
 * Cosmos surfaces error codes as one of three shapes depending on SDK
 * version and code path: a number (e.g. 412), a digit-string (e.g.
 * '412'), or a named alias string. Only aliases with explicit
 * production evidence are mapped here. 'Conflict' is intentionally
 * not in this set until SDK source evidence emerges (see follow-up
 * issue noted in the PR-D rubber-duck gate).
 */
const COSMOS_ERROR_CODE_ALIASES = Object.freeze({
  __proto__: null,
  PreconditionFailed: 412,
  NotFound: 404,
});

/**
 * Returns the numeric HTTP-status code from a Cosmos error, or null if
 * the error has no recognizable code. Cosmos surfaces the code as
 * either a number (e.g. 412), a digit-string (e.g. '412'), or a
 * string alias (e.g. 'PreconditionFailed' for 412, 'NotFound' for
 * 404). Normalizing here means every call site
 * (readDestinationDocument, the write-path classifier, etc.) sees a
 * consistent numeric code.
 *
 * This helper is intentionally broader than
 * `api/src/shared/cosmos.ts:isCosmosPreconditionFailed`, which only
 * classifies 412 because that is the only shape `replaceWithIfMatch`
 * needs. `getErrorCode` covers 404/409/412 across number,
 * digit-string, and named-alias shapes because the back-sync script
 * calls it from multiple sites (the destination read, the write
 * conflict classifier, the malformed-source fallback). The
 * cross-reference is for navigation, not shape parity.
 *
 * If a future SDK release adds a new string alias for 412
 * (analogous to `'PreconditionFailed'`), register it in both
 * helpers in the same change. Other aliases (404, 409, etc.) belong
 * here only; the api helper does not need them.
 */
export function getErrorCode(error) {
  if (error === null || typeof error !== 'object') {
    return null;
  }
  const { code } = error;
  if (typeof code === 'number' && Number.isFinite(code)) {
    return code;
  }
  if (typeof code === 'string') {
    if (/^\d+$/u.test(code)) {
      return Number.parseInt(code, 10);
    }
    if (code in COSMOS_ERROR_CODE_ALIASES) {
      return COSMOS_ERROR_CODE_ALIASES[code];
    }
  }
  return null;
}

function decodePartitionKeySegment(segment) {
  return segment.replace(/~1/gu, '/').replace(/~0/gu, '~');
}

function extractValueAtPath(document, path) {
  const segments = path
    .split('/')
    .filter((segment) => segment !== '')
    .map(decodePartitionKeySegment);
  let currentValue = document;

  for (const segment of segments) {
    if (currentValue === null || typeof currentValue !== 'object' || !(segment in currentValue)) {
      return undefined;
    }
    currentValue = currentValue[segment];
  }

  return currentValue;
}

function extractPartitionKeyValue(document, partitionKeyPaths) {
  const partitionKeyValues = partitionKeyPaths.map((partitionKeyPath) =>
    extractValueAtPath(document, partitionKeyPath),
  );
  if (partitionKeyValues.some((partitionKeyValue) => partitionKeyValue === undefined)) {
    throw new Error(
      `Document ${document.id ?? '<unknown>'} is missing partition key path(s): ${partitionKeyPaths.join(', ')}`,
    );
  }
  return partitionKeyValues.length === 1 ? partitionKeyValues[0] : partitionKeyValues;
}

async function readPartitionKeyPaths(container, containerName, endpointRole) {
  const { resource } = await container.read();
  const partitionKeyPaths = resource?.partitionKey?.paths;
  if (!Array.isArray(partitionKeyPaths) || partitionKeyPaths.length === 0) {
    throw new Error(
      `Container ${containerName} on the ${endpointRole} account is missing a partition key path.`,
    );
  }
  return partitionKeyPaths;
}

async function readDestinationDocument(destinationContainer, id, partitionKey) {
  try {
    const { resource } = await destinationContainer.item(id, partitionKey).read();
    return resource ?? null;
  } catch (error) {
    if (getErrorCode(error) === NOT_FOUND_STATUS_CODE) {
      return null;
    }
    throw error;
  }
}

function createDocumentEvent({
  container,
  id,
  partitionKey,
  action,
  result,
  dryRun,
  oldDoc = null,
  newDoc = null,
  reason = null,
  errorCode = null,
}) {
  return {
    container,
    id,
    partitionKey,
    action,
    result,
    dryRun,
    oldTs: oldDoc?._ts ?? null,
    newTs: newDoc?._ts ?? null,
    reason,
    errorCode,
  };
}

function logConflict({
  conflictsFilePath,
  summary,
  container,
  id,
  partitionKey,
  reason,
  oldDoc = null,
  newDoc = null,
}) {
  summary.conflicts += 1;
  appendConflictRecord(
    conflictsFilePath,
    buildConflictRecord({
      container,
      id,
      partitionKey,
      reason,
      oldDoc,
      newDoc,
    }),
  );
}

// Exported for tests in scripts/cosmos-back-sync.write-path.test.mjs.
// Not part of the script's CLI contract; the entry point is `main`.
export async function syncDocument({
  sourceDocument,
  containerName,
  destinationContainer,
  partitionKeyPaths,
  cutoverInstantUnixSeconds,
  dryRun,
  conflictsFilePath,
  summary,
}) {
  if (!Number.isFinite(sourceDocument?._ts) || sourceDocument._ts < cutoverInstantUnixSeconds) {
    return;
  }

  // Outer try/catch covers the two non-network throw sites that live
  // outside the inner read/write try blocks: id validation,
  // extractPartitionKeyValue (line ~396 pre-fix), and decideAction
  // (line ~429 pre-fix). Without this, a single malformed source doc
  // (missing partition-key path, non-numeric _ts, missing id) crashes
  // the entire rollback by propagating to syncContainer's iterator
  // loop and then to main's container loop. With it, the bad doc is
  // logged as 'malformed-source' and processing continues.
  let id = null;
  let partitionKey = null;
  let destinationDocument = null;
  let action = null;

  try {
    ({ id } = sourceDocument);
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error(
        `Encountered a source document without a valid id in container ${containerName}.`,
      );
    }

    partitionKey = extractPartitionKeyValue(sourceDocument, partitionKeyPaths);
    summary.docsProcessed += 1;

    try {
      destinationDocument = await readDestinationDocument(destinationContainer, id, partitionKey);
    } catch (error) {
      logConflict({
        conflictsFilePath,
        summary,
        container: containerName,
        id,
        partitionKey,
        reason: 'unknown',
        newDoc: sourceDocument,
      });
      writeJsonLine(
        process.stdout,
        createDocumentEvent({
          container: containerName,
          id,
          partitionKey,
          action: 'inspect',
          result: 'failed',
          dryRun,
          newDoc: sourceDocument,
          reason: 'unknown',
          errorCode: getErrorCode(error),
        }),
      );
      return;
    }

    action = decideAction(destinationDocument, sourceDocument);
  } catch (error) {
    summary.docsMalformed += 1;
    const fallbackId = typeof id === 'string' && id.trim() !== '' ? id : '<unknown>';
    logConflict({
      conflictsFilePath,
      summary,
      container: containerName,
      id: fallbackId,
      partitionKey,
      reason: 'malformed-source',
      oldDoc: destinationDocument,
      newDoc: sourceDocument,
    });
    writeJsonLine(
      process.stdout,
      createDocumentEvent({
        container: containerName,
        id: fallbackId,
        partitionKey,
        action: 'inspect',
        result: 'failed',
        dryRun,
        oldDoc: destinationDocument,
        newDoc: sourceDocument,
        reason: 'malformed-source',
        errorCode: error instanceof Error ? error.message : String(error),
      }),
    );
    return;
  }

  if (action === 'skip-old-fresher') {
    summary.docsSkippedOldFresher += 1;
    logConflict({
      conflictsFilePath,
      summary,
      container: containerName,
      id,
      partitionKey,
      reason: 'old-fresher',
      oldDoc: destinationDocument,
      newDoc: sourceDocument,
    });
    writeJsonLine(
      process.stdout,
      createDocumentEvent({
        container: containerName,
        id,
        partitionKey,
        action,
        result: 'skipped',
        dryRun,
        oldDoc: destinationDocument,
        newDoc: sourceDocument,
        reason: 'old-fresher',
      }),
    );
    return;
  }

  if (dryRun) {
    if (action === 'create') {
      summary.docsCreated += 1;
    } else {
      summary.docsUpdated += 1;
    }
    writeJsonLine(
      process.stdout,
      createDocumentEvent({
        container: containerName,
        id,
        partitionKey,
        action,
        result: 'planned',
        dryRun,
        oldDoc: destinationDocument,
        newDoc: sourceDocument,
      }),
    );
    return;
  }

  try {
    if (action === 'create') {
      await destinationContainer.items.create(sourceDocument);
      summary.docsCreated += 1;
      writeJsonLine(
        process.stdout,
        createDocumentEvent({
          container: containerName,
          id,
          partitionKey,
          action,
          result: 'created',
          dryRun,
          newDoc: sourceDocument,
        }),
      );
      return;
    }

    await destinationContainer.item(id, partitionKey).replace(sourceDocument, {
      accessCondition: {
        type: IF_MATCH,
        condition: destinationDocument._etag,
      },
    });
    summary.docsUpdated += 1;
    writeJsonLine(
      process.stdout,
      createDocumentEvent({
        container: containerName,
        id,
        partitionKey,
        action,
        result: 'updated',
        dryRun,
        oldDoc: destinationDocument,
        newDoc: sourceDocument,
      }),
    );
  } catch (error) {
    const errorCode = getErrorCode(error);
    const reason =
      errorCode === PRECONDITION_FAILED_STATUS_CODE || errorCode === CONFLICT_STATUS_CODE
        ? 'concurrent-write'
        : 'unknown';
    logConflict({
      conflictsFilePath,
      summary,
      container: containerName,
      id,
      partitionKey,
      reason,
      oldDoc: destinationDocument,
      newDoc: sourceDocument,
    });
    writeJsonLine(
      process.stdout,
      createDocumentEvent({
        container: containerName,
        id,
        partitionKey,
        action,
        result: 'failed',
        dryRun,
        oldDoc: destinationDocument,
        newDoc: sourceDocument,
        reason,
        errorCode,
      }),
    );
  }
}

async function syncContainer({
  sourceDatabase,
  destinationDatabase,
  containerName,
  cutoverInstantUnixSeconds,
  dryRun,
  conflictsFilePath,
}) {
  const sourceContainer = sourceDatabase.container(containerName);
  const destinationContainer = destinationDatabase.container(containerName);
  const sourcePartitionKeyPaths = await readPartitionKeyPaths(
    sourceContainer,
    containerName,
    'source',
  );
  const destinationPartitionKeyPaths = await readPartitionKeyPaths(
    destinationContainer,
    containerName,
    'destination',
  );

  if (JSON.stringify(sourcePartitionKeyPaths) !== JSON.stringify(destinationPartitionKeyPaths)) {
    throw new Error(
      `Container ${containerName} has mismatched partition key paths between source and destination accounts.`,
    );
  }

  process.stderr.write(
    `Syncing container ${containerName} with partition key path(s) ${sourcePartitionKeyPaths.join(', ')}...\n`,
  );

  const summary = {
    container: containerName,
    docsProcessed: 0,
    docsCreated: 0,
    docsUpdated: 0,
    docsSkippedOldFresher: 0,
    docsMalformed: 0,
    conflicts: 0,
  };

  const iterator = sourceContainer.items.getChangeFeedIterator({
    changeFeedStartFrom: ChangeFeedStartFrom.Time(new Date(cutoverInstantUnixSeconds * 1000)),
  });

  // try/finally so the per-container summary is emitted even when the
  // change-feed iterator throws mid-stream. Without this, a transient
  // SDK error during readNext() loses the partial-progress accounting
  // for that container; the operator has no record of how many docs
  // were processed before the failure.
  try {
    for (;;) {
      const response = await iterator.readNext();
      if (response.statusCode === NOT_MODIFIED_STATUS_CODE || response.count === 0) {
        break;
      }

      for (const sourceDocument of response.result) {
        await syncDocument({
          sourceDocument,
          containerName,
          destinationContainer,
          partitionKeyPaths: sourcePartitionKeyPaths,
          cutoverInstantUnixSeconds,
          dryRun,
          conflictsFilePath,
          summary,
        });
      }
    }
  } finally {
    process.stderr.write(
      `Completed ${containerName}: processed=${summary.docsProcessed}, created=${summary.docsCreated}, updated=${summary.docsUpdated}, skippedOldFresher=${summary.docsSkippedOldFresher}, malformed=${summary.docsMalformed}, conflicts=${summary.conflicts}\n`,
    );
    writeJsonLine(process.stdout, summary);
  }
}

export async function main(args = process.argv.slice(2), { stderr = process.stderr } = {}) {
  let options;
  try {
    options = parseCliOptions(args);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`${error.message}\n\n`);
      stderr.write(`${USAGE}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (options.help) {
    writeUsage(process.stdout);
    return;
  }

  // Required opt-in gate. The deletes-not-replayed limitation is
  // permanent for this rollback window (AllVersionsAndDeletes retention
  // is forward-looking and was not enabled pre-cutover). Refusing to
  // run without explicit acknowledgement forces the operator to read
  // the warning instead of scrolling past it.
  if (!options.acceptDeleteLoss) {
    warnDeletesNotReplayed(stderr);
    stderr.write(
      'Refusing to run without --accept-delete-loss. Pass --accept-delete-loss after ' +
        'reading the deletes-not-replayed warning above and planning the post-rollback ' +
        'per-container diff reconciliation.\n',
    );
    process.exitCode = 1;
    return;
  }

  warnDeletesNotReplayed(stderr);

  const sourceEndpoint = `https://${options.sourceAccount}.documents.azure.com:443/`;
  const destinationEndpoint = `https://${options.destinationAccount}.documents.azure.com:443/`;
  const sourceKey = getRequiredKey(
    'COSMOS_SRC_KEY',
    options.sourceAccount,
    options.sourceResourceGroup,
  );
  const destinationKey = getRequiredKey(
    'COSMOS_DST_KEY',
    options.destinationAccount,
    options.destinationResourceGroup,
  );

  const conflictsFilePath = buildConflictFilePath({ dryRun: options.dryRun });
  // Exclusive create (flag: 'wx') so a second run started in the same
  // second (timestamp granularity) refuses rather than silently
  // truncating the prior run's audit trail.
  try {
    writeFileSync(conflictsFilePath, '', { flag: 'wx', encoding: 'utf8' });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(
        `Conflicts file already exists: ${conflictsFilePath}. Wait one second and re-run, or move the existing file aside.`,
      );
    }
    throw error;
  }
  stderr.write(`Conflicts file: ${conflictsFilePath}\n`);

  const sourceClient = new CosmosClient({ endpoint: sourceEndpoint, key: sourceKey });
  const destinationClient = new CosmosClient({
    endpoint: destinationEndpoint,
    key: destinationKey,
  });
  const sourceDatabase = sourceClient.database(options.databaseName);
  const destinationDatabase = destinationClient.database(options.databaseName);

  // Per-container try/catch so one container's failure does not abort
  // the rest of the rollback. The first error is preserved and
  // re-raised after the loop so the script exits non-zero.
  let firstContainerError = null;
  for (const containerName of options.containerNames) {
    try {
      await syncContainer({
        sourceDatabase,
        destinationDatabase,
        containerName,
        cutoverInstantUnixSeconds: options.cutoverInstantUnixSeconds,
        dryRun: options.dryRun,
        conflictsFilePath,
      });
    } catch (error) {
      stderr.write(
        `Container ${containerName} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      if (firstContainerError === null) {
        firstContainerError = error;
      }
    }
  }

  if (firstContainerError !== null) {
    process.exitCode = 1;
  }
}

const entryPointPath = process.argv[1];
if (
  typeof entryPointPath === 'string' &&
  resolve(entryPointPath) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
