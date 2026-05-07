#!/usr/bin/env node
/**
 * Standalone manual cleanup for orphaned api-integration test
 * containers in the CI Cosmos free-tier account.
 *
 * Lists `blobs-*` containers in the `jotjson-ci` database and drops
 * any older than 24 hours. Useful for one-off cleanup if the
 * automated three-layer cleanup (#63 plan D9) leaks containers - for
 * example after a runner cancellation.
 *
 * Required env vars:
 *  - COSMOS_CI_ENDPOINT
 *  - COSMOS_CI_KEY
 *  - COSMOS_DATABASE (defaults to 'jotjson-ci')
 *
 * Usage:
 *   npm --prefix api run cleanup:cosmos-ci
 */

import { CosmosClient } from '@azure/cosmos';

const PREFIX = 'blobs-';
const ORPHAN_THRESHOLD_MS = 24 * 60 * 60 * 1000;

async function main() {
  const endpoint = process.env.COSMOS_CI_ENDPOINT;
  const key = process.env.COSMOS_CI_KEY;
  const databaseName = process.env.COSMOS_DATABASE ?? 'jotjson-ci';

  if (!endpoint || !key) {
    console.error('COSMOS_CI_ENDPOINT and COSMOS_CI_KEY must be set.');
    process.exit(1);
  }

  const client = new CosmosClient({ endpoint, key });
  const database = client.database(databaseName);

  const { resources } = await database.containers.readAll().fetchAll();
  const testContainers = resources.filter((c) => c.id.startsWith(PREFIX));

  console.log(
    `Found ${testContainers.length} ${PREFIX}* container(s) in database '${databaseName}'.`,
  );

  const now = Date.now();
  const orphans = testContainers.filter((c) => {
    const ts = c._ts;
    if (typeof ts !== 'number') return false;
    return now - ts * 1000 > ORPHAN_THRESHOLD_MS;
  });

  if (orphans.length === 0) {
    console.log('No orphans older than 24h. Nothing to do.');
    return;
  }

  console.log(`Dropping ${orphans.length} orphan container(s):`);
  for (const orphan of orphans) {
    const ageHours = ((now - orphan._ts * 1000) / 3600000).toFixed(1);
    console.log(`  - ${orphan.id} (age ${ageHours}h)`);
    try {
      await database.container(orphan.id).delete();
      console.log(`    OK`);
    } catch (error) {
      console.error(`    FAILED: ${error.message ?? error}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
