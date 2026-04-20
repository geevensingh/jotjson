import { CosmosClient, Database } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';

let cachedClient: CosmosClient | undefined;
let cachedDatabase: Database | undefined;

/**
 * Returns a cached Cosmos DB client and database handle.
 *
 * Auth precedence:
 *  1. COSMOS_KEY env var (local dev fallback) — key auth
 *  2. DefaultAzureCredential — managed identity in Azure; `az login` locally
 *
 * COSMOS_ENDPOINT is always required. COSMOS_DATABASE defaults to `jotjson`.
 */
export function getCosmos(): { client: CosmosClient; database: Database } {
  if (!cachedClient || !cachedDatabase) {
    const endpoint = process.env['COSMOS_ENDPOINT'];
    const key = process.env['COSMOS_KEY'];
    const dbName = process.env['COSMOS_DATABASE'] ?? 'jotjson';

    if (!endpoint) {
      throw new Error('COSMOS_ENDPOINT must be set');
    }

    cachedClient = key
      ? new CosmosClient({ endpoint, key })
      : new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
    cachedDatabase = cachedClient.database(dbName);
  }
  return { client: cachedClient, database: cachedDatabase };
}

/** Reset the cached client — used by tests. */
export function __resetCosmosForTesting(): void {
  cachedClient = undefined;
  cachedDatabase = undefined;
}
