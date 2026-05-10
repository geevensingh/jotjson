/**
 * Jest globalTeardown for the api-integration suite (#63).
 *
 * Drops the per-run container after the suite finishes. Defense in
 * depth (per #63 D9): this layer covers ordinary Jest failures.
 * The CI workflow has an `if: always()` cleanup step as a backstop
 * for Jest hard-crashes. The setup-time orphan cleanup
 * (`global-setup.ts` `preflightOrphanCleanup`) covers runner
 * cancellation that bypasses both.
 */

import { CosmosClient } from '@azure/cosmos';
import { withRetry } from './cosmos-test-helpers';

export default async function globalTeardown(): Promise<void> {
  const endpoint = process.env['COSMOS_ENDPOINT'] ?? process.env['COSMOS_CI_ENDPOINT'];
  const key = process.env['COSMOS_KEY'] ?? process.env['COSMOS_CI_KEY'];
  const databaseName = process.env['COSMOS_DATABASE'];
  const containerName = process.env['COSMOS_BLOBS_CONTAINER'];

  if (!endpoint || !key || !databaseName || !containerName) {
    console.warn(
      '[integration] globalTeardown: env config missing; skipping container drop. ' +
        'This is expected if globalSetup itself failed.',
    );
    return;
  }

  const client = new CosmosClient({ endpoint, key });
  const database = client.database(databaseName);

  try {
    await withRetry(() => database.container(containerName).delete(), {
      label: `delete container ${containerName}`,
    });
    console.log(`[integration] dropped container '${containerName}'`);
  } catch (error) {
    console.warn(
      `[integration] failed to drop container '${containerName}'; ` +
        'orphan cleanup at next run will retry',
      error instanceof Error ? error.message : error,
    );
  }
}
