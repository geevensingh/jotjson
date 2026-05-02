import { CosmosClient, Database } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';

let cachedClient: CosmosClient | undefined;
let cachedDatabase: Database | undefined;

export class CosmosConfigurationError extends Error {
  readonly statusCode = 500;
  constructor(message: string) {
    super(message);
    this.name = 'CosmosConfigurationError';
  }
}

/**
 * Returns a cached Cosmos DB client and database handle.
 *
 * Auth precedence (per `DESIGN_SPEC.md` Cosmos DB authentication):
 *  1. `COSMOS_KEY` env var - the production path. Required in any
 *     Azure-host environment (`WEBSITE_INSTANCE_ID` set) because the
 *     SWA managed-Functions runtime does not expose managed identity
 *     to the Function process. Also the conventional local-dev path,
 *     supplied via `local.settings.json`.
 *  2. `DefaultAzureCredential` - reserved for the future M7o
 *     BYO-Functions migration. Today this branch is only useful on a
 *     developer workstation that has run `az login`. In an Azure-host
 *     env, missing `COSMOS_KEY` is a hard configuration error and we
 *     fail fast rather than silently fall through to broken upstream
 *     code (see 5/1 incident retrospective).
 *
 * `COSMOS_ENDPOINT` is always required. `COSMOS_DATABASE` defaults to
 * `jotjson`.
 */
export function getCosmos(): { client: CosmosClient; database: Database } {
  if (!cachedClient || !cachedDatabase) {
    const endpoint = process.env['COSMOS_ENDPOINT'];
    const key = process.env['COSMOS_KEY'];
    const dbName = process.env['COSMOS_DATABASE'] ?? 'jotjson';

    if (!endpoint) {
      throw new Error('COSMOS_ENDPOINT must be set');
    }

    if (!key && process.env['WEBSITE_INSTANCE_ID']) {
      throw new CosmosConfigurationError(
        'COSMOS_KEY app setting is required in Azure-host environments. ' +
          'See DESIGN_SPEC.md "Cosmos DB authentication". The DefaultAzureCredential ' +
          'branch is reserved for the future M7o BYO-Functions migration.',
      );
    }

    cachedClient = key
      ? new CosmosClient({ endpoint, key })
      : new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
    cachedDatabase = cachedClient.database(dbName);
  }
  return { client: cachedClient, database: cachedDatabase };
}

/** Reset the cached client - used by tests. */
export function __resetCosmosForTesting(): void {
  cachedClient = undefined;
  cachedDatabase = undefined;
}
