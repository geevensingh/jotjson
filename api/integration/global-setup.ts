/**
 * Jest globalSetup for the api-integration suite (#63).
 *
 * Runs once before any test worker starts. Responsibilities:
 *  1. Validate required env vars are present (fail fast with a clear
 *     message if not).
 *  2. Remap `COSMOS_CI_*` to production env-var names for setup-time
 *     use (the test workers also do this via setup-env.ts, but
 *     globalSetup runs before that and needs its own remap to use
 *     `getCosmos()`-equivalent config).
 *  3. Preflight orphan cleanup: list `blobs-*` containers in the
 *     `jotjson-ci` database, drop any older than 24h. Fail with a
 *     clear message if more than `CONTAINER_COUNT_HARD_CAP` exist
 *     (safety margin under Cosmos's 25-container shared-throughput
 *     limit).
 *  4. Create the per-run container with the production indexing
 *     policy (`indexingMode: 'consistent'`, excludedPaths
 *     `/"_etag"/?`) and `/ownerId` partition key, matching
 *     `infra/modules/cosmosDb.bicep:58-62`.
 *
 * All control-plane operations are wrapped in `withRetry` because
 * real Cosmos can return transient 429/5xx during provisioning.
 */

import { CosmosClient, type Database } from '@azure/cosmos';
import {
  CONTAINER_COUNT_HARD_CAP,
  ORPHAN_THRESHOLD_MS,
  TEST_CONTAINER_PREFIX,
  withRetry,
} from './cosmos-test-helpers';

function readEnvOrFail(name: string, alternateName?: string): string {
  const value = process.env[name] ?? (alternateName ? process.env[alternateName] : undefined);
  if (!value) {
    const altMsg = alternateName ? ` (also tried ${alternateName})` : '';
    throw new Error(
      `[integration] ${name}${altMsg} is not set. ` +
        'CI sets COSMOS_ENDPOINT/COSMOS_KEY/COSMOS_DATABASE/COSMOS_BLOBS_CONTAINER ' +
        'directly via the workflow env: block. Local dev should set ' +
        'COSMOS_CI_ENDPOINT/COSMOS_CI_KEY (plus COSMOS_DATABASE=jotjson-ci ' +
        'and COSMOS_BLOBS_CONTAINER=blobs-<unique-suffix>) before running ' +
        'npm run test:integration. See docs/ci-cosmos.md for setup.',
    );
  }
  return value;
}

async function preflightOrphanCleanup(
  database: Database,
  currentContainerName: string,
): Promise<void> {
  const { resources } = await withRetry(() => database.containers.readAll().fetchAll(), {
    label: 'list containers',
  });

  const testContainers = resources.filter((container) =>
    container.id.startsWith(TEST_CONTAINER_PREFIX),
  );

  if (testContainers.length > CONTAINER_COUNT_HARD_CAP) {
    throw new Error(
      `[integration] Found ${testContainers.length} ${TEST_CONTAINER_PREFIX}* containers in ` +
        `database '${database.id}'. Hard cap is ${CONTAINER_COUNT_HARD_CAP} (Cosmos shared-throughput ` +
        'database limit is 25 containers). Run `npm --prefix api run cleanup:cosmos-ci` ' +
        'to drop orphans, or investigate why cleanup is leaking.',
    );
  }

  const now = Date.now();
  const orphans = testContainers.filter((container) => {
    if (container.id === currentContainerName) return false;
    const tsRaw = container._ts;
    if (typeof tsRaw !== 'number') return false;
    const ageMs = now - tsRaw * 1000;
    return ageMs > ORPHAN_THRESHOLD_MS;
  });

  for (const orphan of orphans) {
    try {
      await withRetry(() => database.container(orphan.id).delete(), {
        label: `delete orphan container ${orphan.id}`,
      });
      console.log(`[integration] dropped orphan container ${orphan.id}`);
    } catch (error) {
      console.warn(
        `[integration] failed to drop orphan container ${orphan.id}; continuing`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

export default async function globalSetup(): Promise<void> {
  if (
    process.env['COSMOS_ENDPOINT'] === undefined &&
    process.env['COSMOS_CI_ENDPOINT'] !== undefined
  ) {
    process.env['COSMOS_ENDPOINT'] = process.env['COSMOS_CI_ENDPOINT'];
  }
  if (process.env['COSMOS_KEY'] === undefined && process.env['COSMOS_CI_KEY'] !== undefined) {
    process.env['COSMOS_KEY'] = process.env['COSMOS_CI_KEY'];
  }

  const endpoint = readEnvOrFail('COSMOS_ENDPOINT', 'COSMOS_CI_ENDPOINT');
  const key = readEnvOrFail('COSMOS_KEY', 'COSMOS_CI_KEY');
  const databaseName = readEnvOrFail('COSMOS_DATABASE');
  const containerName = readEnvOrFail('COSMOS_BLOBS_CONTAINER');

  if (!containerName.startsWith(TEST_CONTAINER_PREFIX)) {
    throw new Error(
      `[integration] COSMOS_BLOBS_CONTAINER must start with '${TEST_CONTAINER_PREFIX}' ` +
        'so it is recognized as a test container by orphan cleanup. Got: ' +
        containerName,
    );
  }

  const client = new CosmosClient({ endpoint, key });
  const database = client.database(databaseName);

  await preflightOrphanCleanup(database, containerName);

  await withRetry(
    () =>
      database.containers.createIfNotExists({
        id: containerName,
        partitionKey: { paths: ['/ownerId'] },
        indexingPolicy: {
          indexingMode: 'consistent',
          includedPaths: [{ path: '/*' }],
          excludedPaths: [{ path: '/"_etag"/?' }],
        },
      }),
    { label: `create container ${containerName}` },
  );

  console.log(`[integration] container '${containerName}' ready in database '${databaseName}'`);
}
