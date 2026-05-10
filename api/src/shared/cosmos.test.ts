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

// =============================================================================
// Versioned-document concurrency primitives
// =============================================================================

import type { Container } from '@azure/cosmos';
import {
  CosmosInvariantError,
  VersionConflictError,
  isCosmosPreconditionFailed,
  replaceWithIfMatch,
  stripCosmosMetadata,
  type Mutable,
  type VersionedDocument,
} from './cosmos';

interface TestDoc extends VersionedDocument {
  id: string;
  version: number;
  _etag?: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  tags: string[];
  nested: { value: number; items: number[] };
}

interface FakeReplaceCall {
  id: string;
  partitionKey: string;
  body: TestDoc;
  ifMatch: string | undefined;
}

interface FakeContainer {
  store: Map<string, { doc: TestDoc }>;
  nextEtag: number;
  replaceCalls: FakeReplaceCall[];
  /** When set, the next replace() call rejects with this code. */
  rejectNext?: { code: number | string };
}

function makeFakeContainer(): FakeContainer {
  return { store: new Map(), nextEtag: 1, replaceCalls: [] };
}

function asContainer(fake: FakeContainer): Container {
  return {
    item: (id: string, partitionKey: string) => ({
      replace: async <T>(
        body: T,
        options?: { accessCondition?: { type: string; condition: string } },
      ): Promise<{ resource: T }> => {
        if (fake.rejectNext) {
          const reject = fake.rejectNext;
          fake.rejectNext = undefined;
          throw Object.assign(new Error('rejected'), { code: reject.code });
        }
        fake.replaceCalls.push({
          id,
          partitionKey,
          body: body as unknown as TestDoc,
          ifMatch: options?.accessCondition?.condition,
        });
        const key = `${partitionKey}/${id}`;
        const current = fake.store.get(key);
        if (!current) throw Object.assign(new Error('not found'), { code: 404 });
        const cond = options?.accessCondition;
        if (cond?.type === 'IfMatch' && cond.condition !== current.doc._etag) {
          throw Object.assign(new Error('precondition failed'), { code: 412 });
        }
        const stored: TestDoc = {
          ...(body as unknown as TestDoc),
          _etag: `etag-${fake.nextEtag}`,
        };
        fake.nextEtag += 1;
        fake.store.set(key, { doc: stored });
        return { resource: stored as unknown as T };
      },
    }),
  } as unknown as Container;
}

function seedDoc(fake: FakeContainer, doc: TestDoc): TestDoc {
  // Store a separate clone so callers holding the returned reference can
  // mutate the "internal" stored copy independently for IfMatch tests.
  const internal: TestDoc = { ...doc, _etag: `etag-${fake.nextEtag}` };
  fake.nextEtag += 1;
  fake.store.set(`${doc.ownerId}/${doc.id}`, { doc: internal });
  return { ...internal };
}

function baseDoc(): TestDoc {
  return {
    id: 'doc-1',
    version: 3,
    ownerId: 'user-1',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
    name: 'original',
    tags: ['a', 'b'],
    nested: { value: 7, items: [1, 2, 3] },
  };
}

describe('isCosmosPreconditionFailed', () => {
  it('matches numeric 412 code', () => {
    expect(isCosmosPreconditionFailed({ code: 412 })).toBe(true);
  });

  it('matches string PreconditionFailed code', () => {
    expect(isCosmosPreconditionFailed({ code: 'PreconditionFailed' })).toBe(true);
  });

  it('does not match 404 / null / non-objects', () => {
    expect(isCosmosPreconditionFailed({ code: 404 })).toBe(false);
    expect(isCosmosPreconditionFailed(null)).toBe(false);
    expect(isCosmosPreconditionFailed(undefined)).toBe(false);
    expect(isCosmosPreconditionFailed('precondition')).toBe(false);
  });
});

describe('replaceWithIfMatch', () => {
  let fake: FakeContainer;
  let container: Container;

  beforeEach(() => {
    fake = makeFakeContainer();
    container = asContainer(fake);
  });

  it('happy path bumps version and strips _etag from the write body', async () => {
    const stored = seedDoc(fake, baseDoc());

    const result = await replaceWithIfMatch<TestDoc>(container, stored.ownerId, stored, (draft) => {
      draft.name = 'updated';
      draft.updatedAt = '2024-02-01T00:00:00.000Z';
    });

    expect(result.version).toBe(stored.version + 1);
    expect(result.name).toBe('updated');
    expect(fake.replaceCalls).toHaveLength(1);
    const call = fake.replaceCalls[0]!;
    expect(call.ifMatch).toBe(stored._etag);
    expect(call.body._etag).toBeUndefined();
    expect(call.body.version).toBe(stored.version + 1);
    expect(call.body.id).toBe(stored.id);
    expect(call.body.name).toBe('updated');
  });

  it('translates Cosmos 412 into VersionConflictError', async () => {
    const stored = seedDoc(fake, baseDoc());
    fake.store.get(`${stored.ownerId}/${stored.id}`)!.doc._etag = 'etag-other';

    await expect(
      replaceWithIfMatch<TestDoc>(container, stored.ownerId, stored, (draft) => {
        draft.name = 'updated';
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });

  it('translates string-form PreconditionFailed into VersionConflictError', async () => {
    const stored = seedDoc(fake, baseDoc());
    fake.rejectNext = { code: 'PreconditionFailed' };

    await expect(
      replaceWithIfMatch<TestDoc>(container, stored.ownerId, stored, (draft) => {
        draft.name = 'updated';
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });

  it('throws CosmosInvariantError (NOT VersionConflictError) when existing has no _etag', async () => {
    const noEtag = baseDoc();
    delete noEtag._etag;

    await expect(
      replaceWithIfMatch<TestDoc>(container, noEtag.ownerId, noEtag, (draft) => {
        draft.name = 'updated';
      }),
    ).rejects.toBeInstanceOf(CosmosInvariantError);

    // Specifically NOT a VersionConflictError - a programming error
    // must not be hidden as a 412 to clients.
    let caught: unknown;
    try {
      await replaceWithIfMatch<TestDoc>(container, noEtag.ownerId, noEtag, (draft) => {
        draft.name = 'updated';
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeInstanceOf(VersionConflictError);
  });

  it('mutator setting _etag is overridden defensively', async () => {
    const stored = seedDoc(fake, baseDoc());

    await replaceWithIfMatch<TestDoc>(container, stored.ownerId, stored, (draft) => {
      // Runtime cast: bypass the Mutable<T> narrowing.
      (draft as unknown as TestDoc)._etag = 'forged';
      draft.name = 'updated';
    });

    expect(fake.replaceCalls[0]!.body._etag).toBeUndefined();
    // Helper still uses the original _etag for IfMatch, not the forgery.
    expect(fake.replaceCalls[0]!.ifMatch).toBe(stored._etag);
  });

  it('mutator changing id is overridden defensively', async () => {
    const stored = seedDoc(fake, baseDoc());

    await replaceWithIfMatch<TestDoc>(container, stored.ownerId, stored, (draft) => {
      (draft as unknown as TestDoc).id = 'attacker';
      draft.name = 'updated';
    });

    expect(fake.replaceCalls[0]!.body.id).toBe(stored.id);
  });

  it('mutator setting version itself is overridden by helper bump', async () => {
    const stored = seedDoc(fake, baseDoc());

    await replaceWithIfMatch<TestDoc>(container, stored.ownerId, stored, (draft) => {
      (draft as unknown as TestDoc).version = 999;
      draft.name = 'updated';
    });

    expect(fake.replaceCalls[0]!.body.version).toBe(stored.version + 1);
  });

  it('mutator throwing propagates and no write happens', async () => {
    const stored = seedDoc(fake, baseDoc());

    const boom = new Error('mutator threw');
    await expect(
      replaceWithIfMatch<TestDoc>(container, stored.ownerId, stored, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(fake.replaceCalls).toHaveLength(0);
  });

  it('uses structuredClone so nested mutations do not bleed into existing', async () => {
    const stored = seedDoc(fake, baseDoc());
    const existingTagsSnapshot = [...stored.tags];
    const existingItemsSnapshot = [...stored.nested.items];
    const existingValueSnapshot = stored.nested.value;

    await replaceWithIfMatch<TestDoc>(container, stored.ownerId, stored, (draft) => {
      draft.tags.push('mutated');
      draft.nested.items.push(99);
      draft.nested.value = 42;
    });

    expect(stored.tags).toEqual(existingTagsSnapshot);
    expect(stored.nested.items).toEqual(existingItemsSnapshot);
    expect(stored.nested.value).toEqual(existingValueSnapshot);
    expect(fake.replaceCalls[0]!.body.tags).toContain('mutated');
    expect(fake.replaceCalls[0]!.body.nested.items).toContain(99);
  });

  it('immutable fields pass through unchanged when mutator does not touch them', async () => {
    const stored = seedDoc(fake, baseDoc());

    await replaceWithIfMatch<TestDoc>(container, stored.ownerId, stored, (draft) => {
      draft.updatedAt = '2024-03-01T00:00:00.000Z';
    });

    const body = fake.replaceCalls[0]!.body;
    expect(body.id).toBe(stored.id);
    expect(body.ownerId).toBe(stored.ownerId);
    expect(body.createdAt).toBe(stored.createdAt);
    expect(body.name).toBe(stored.name);
    expect(body.tags).toEqual(stored.tags);
  });

  it('Mutable<T> type strips id, version, and _etag', () => {
    type T = Mutable<TestDoc>;
    type _IdRemoved = Extract<keyof T, 'id'>;
    type _VersionRemoved = Extract<keyof T, 'version'>;
    type _EtagRemoved = Extract<keyof T, '_etag'>;

    const _idCheck: _IdRemoved extends never ? true : false = true;
    const _versionCheck: _VersionRemoved extends never ? true : false = true;
    const _etagCheck: _EtagRemoved extends never ? true : false = true;

    expect(_idCheck).toBe(true);
    expect(_versionCheck).toBe(true);
    expect(_etagCheck).toBe(true);
  });

  it('non-precondition errors propagate unchanged', async () => {
    const stored = seedDoc(fake, baseDoc());
    fake.rejectNext = { code: 503 };

    await expect(
      replaceWithIfMatch<TestDoc>(container, stored.ownerId, stored, (draft) => {
        draft.name = 'updated';
      }),
    ).rejects.toMatchObject({ code: 503 });
  });
});

describe('stripCosmosMetadata', () => {
  function baseStripDoc(): TestDoc {
    return {
      id: 'doc-1',
      version: 3,
      ownerId: 'user-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      name: 'original',
      tags: ['a', 'b'],
      nested: { value: 7, items: [1, 2, 3] },
    };
  }

  it('returns a copy without _etag', () => {
    const doc: TestDoc = { ...baseStripDoc(), _etag: 'etag-1' };
    const stripped = stripCosmosMetadata(doc);

    expect((stripped as Record<string, unknown>)['_etag']).toBeUndefined();
    expect(stripped.id).toBe(doc.id);
    expect(stripped.version).toBe(doc.version);
    expect(stripped.name).toBe(doc.name);
  });

  it('does not mutate the input doc', () => {
    const doc: TestDoc = { ...baseStripDoc(), _etag: 'etag-1' };
    stripCosmosMetadata(doc);
    expect(doc._etag).toBe('etag-1');
  });

  it('handles a doc that already lacks _etag', () => {
    const doc: TestDoc = baseStripDoc();
    expect(() => stripCosmosMetadata(doc)).not.toThrow();
    const stripped = stripCosmosMetadata(doc);
    expect((stripped as Record<string, unknown>)['_etag']).toBeUndefined();
  });
});
