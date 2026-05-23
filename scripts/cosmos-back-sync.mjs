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
//   --cutover-instant-unix-seconds N  Cutover moment. Per-doc filter
//                                     ignores docs with _ts < this value
//                                     (perf optimization; not correctness).
//   --database <name>                 Cosmos database name (default 'jotjson').
//   --containers <comma-separated>    Optional. Default: all four
//                                     (blobs,users,history,rule-sets).
//   --dry-run                         Print planned ops; don't write.
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
//   reason: 'old-fresher' | 'concurrent-write' | 'unknown'.
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
  node scripts/cosmos-back-sync.mjs --src <account-name> --src-rg <rg-name> --dst <account-name> --dst-rg <rg-name> --cutover-instant-unix-seconds <unix-seconds> [--database <name>] [--containers <comma-separated>] [--dry-run]
  node scripts/cosmos-back-sync.mjs --help

Options:
  --src <account-name>              NEW account (read from).
  --src-rg <rg-name>                NEW account RG.
  --dst <account-name>              OLD account (write to).
  --dst-rg <rg-name>                OLD account RG.
  --cutover-instant-unix-seconds N  Cutover moment.
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

function getErrorCode(error) {
  if (typeof error?.code === 'number' && Number.isFinite(error.code)) {
    return error.code;
  }
  if (typeof error?.code === 'string' && /^\d+$/u.test(error.code)) {
    return Number.parseInt(error.code, 10);
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

async function syncDocument({
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

  const { id } = sourceDocument;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(
      `Encountered a source document without a valid id in container ${containerName}.`,
    );
  }

  const partitionKey = extractPartitionKeyValue(sourceDocument, partitionKeyPaths);
  summary.docsProcessed += 1;

  let destinationDocument;
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

  const action = decideAction(destinationDocument, sourceDocument);
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
    conflicts: 0,
  };

  const iterator = sourceContainer.items.getChangeFeedIterator({
    changeFeedStartFrom: ChangeFeedStartFrom.Time(new Date(cutoverInstantUnixSeconds * 1000)),
  });

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

  process.stderr.write(
    `Completed ${containerName}: processed=${summary.docsProcessed}, created=${summary.docsCreated}, updated=${summary.docsUpdated}, skippedOldFresher=${summary.docsSkippedOldFresher}, conflicts=${summary.conflicts}\n`,
  );
  writeJsonLine(process.stdout, summary);
}

export async function main(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseCliOptions(args);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n`);
      writeUsage(process.stderr);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (options.help) {
    writeUsage(process.stdout);
    return;
  }

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
  writeFileSync(conflictsFilePath, '', 'utf8');
  process.stderr.write(`Conflicts file: ${conflictsFilePath}\n`);

  const sourceClient = new CosmosClient({ endpoint: sourceEndpoint, key: sourceKey });
  const destinationClient = new CosmosClient({
    endpoint: destinationEndpoint,
    key: destinationKey,
  });
  const sourceDatabase = sourceClient.database(options.databaseName);
  const destinationDatabase = destinationClient.database(options.databaseName);

  for (const containerName of options.containerNames) {
    await syncContainer({
      sourceDatabase,
      destinationDatabase,
      containerName,
      cutoverInstantUnixSeconds: options.cutoverInstantUnixSeconds,
      dryRun: options.dryRun,
      conflictsFilePath,
    });
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
