import { CosmosClient, Database } from '@azure/cosmos';

let cachedClient: CosmosClient | undefined;
let cachedDatabase: Database | undefined;

/**
 * Returns a cached Cosmos DB client and database handle.
 * Reads config from env vars COSMOS_ENDPOINT, COSMOS_KEY, COSMOS_DATABASE.
 */
export function getCosmos(): { client: CosmosClient; database: Database } {
  if (!cachedClient || !cachedDatabase) {
    const endpoint = process.env['COSMOS_ENDPOINT'];
    const key = process.env['COSMOS_KEY'];
    const dbName = process.env['COSMOS_DATABASE'] ?? 'jotjson';

    if (!endpoint || !key) {
      throw new Error('COSMOS_ENDPOINT and COSMOS_KEY must be set');
    }

    cachedClient = new CosmosClient({ endpoint, key });
    cachedDatabase = cachedClient.database(dbName);
  }
  return { client: cachedClient, database: cachedDatabase };
}
