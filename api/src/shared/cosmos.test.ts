// Mock the upstream Azure SDK modules so this test exercises the env-variable
// logic in `getCosmos` without pulling in `@azure/identity` -> `@azure/msal-node`
// -> `uuid` (ESM-only) at import time. Jest hoists `jest.mock` factories above
// the import below.
jest.mock('@azure/identity', () => ({
  DefaultAzureCredential: jest
    .fn()
    .mockImplementation(() => ({ __kind: 'DefaultAzureCredential' })),
}));

interface CosmosClientOptions {
  endpoint: string;
  key?: string;
  aadCredentials?: unknown;
}

jest.mock('@azure/cosmos', () => ({
  CosmosClient: jest.fn().mockImplementation((options: CosmosClientOptions) => ({
    __endpoint: options.endpoint,
    __key: options.key,
    __aad: options.aadCredentials,
    database: (name: string) => ({ id: name }),
  })),
}));

import { CosmosConfigurationError, __resetCosmosForTesting, getCosmos } from './cosmos';

describe('shared/cosmos getCosmos', () => {
  const FAKE_ENDPOINT = 'https://example.documents.azure.com:443/';
  const FAKE_KEY = 'aGVsbG8td29ybGQtZmFrZS1rZXktZm9yLXRlc3RzLW9ubHk=';

  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      COSMOS_ENDPOINT: process.env['COSMOS_ENDPOINT'],
      COSMOS_KEY: process.env['COSMOS_KEY'],
      COSMOS_DATABASE: process.env['COSMOS_DATABASE'],
      WEBSITE_INSTANCE_ID: process.env['WEBSITE_INSTANCE_ID'],
    };
    delete process.env['COSMOS_ENDPOINT'];
    delete process.env['COSMOS_KEY'];
    delete process.env['COSMOS_DATABASE'];
    delete process.env['WEBSITE_INSTANCE_ID'];
    __resetCosmosForTesting();
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    __resetCosmosForTesting();
  });

  it('throws when COSMOS_ENDPOINT is unset', () => {
    expect(() => getCosmos()).toThrow('COSMOS_ENDPOINT must be set');
  });

  it('throws CosmosConfigurationError in Azure-host env when COSMOS_KEY is absent', () => {
    process.env['COSMOS_ENDPOINT'] = FAKE_ENDPOINT;
    process.env['WEBSITE_INSTANCE_ID'] = 'host-1';
    let caught: unknown;
    try {
      getCosmos();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CosmosConfigurationError);
    const message = (caught as Error).message;
    expect(message).toMatch(/COSMOS_KEY/);
    expect(message).toMatch(/Azure-host/);
  });

  it('uses key auth when COSMOS_KEY and WEBSITE_INSTANCE_ID are both set', () => {
    process.env['COSMOS_ENDPOINT'] = FAKE_ENDPOINT;
    process.env['COSMOS_KEY'] = FAKE_KEY;
    process.env['WEBSITE_INSTANCE_ID'] = 'host-1';
    const result = getCosmos();
    const client = result.client as unknown as {
      __endpoint: string;
      __key?: string;
      __aad?: unknown;
    };
    expect(client.__endpoint).toBe(FAKE_ENDPOINT);
    expect(client.__key).toBe(FAKE_KEY);
    expect(client.__aad).toBeUndefined();
  });

  it('falls through to the AAD branch in non-Azure (local-dev) env when COSMOS_KEY is absent', () => {
    process.env['COSMOS_ENDPOINT'] = FAKE_ENDPOINT;
    const result = getCosmos();
    const client = result.client as unknown as {
      __endpoint: string;
      __key?: string;
      __aad?: { __kind: string };
    };
    expect(client.__endpoint).toBe(FAKE_ENDPOINT);
    expect(client.__key).toBeUndefined();
    expect(client.__aad).toEqual({ __kind: 'DefaultAzureCredential' });
  });

  it('caches the client across calls', () => {
    process.env['COSMOS_ENDPOINT'] = FAKE_ENDPOINT;
    process.env['COSMOS_KEY'] = FAKE_KEY;
    const first = getCosmos();
    const second = getCosmos();
    expect(second.client).toBe(first.client);
    expect(second.database).toBe(first.database);
  });
});
