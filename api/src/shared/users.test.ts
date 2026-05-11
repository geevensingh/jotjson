import { VersionConflictError } from './cosmos';
import { DEFAULT_PREFERENCES } from './preferences';
import {
  __resetUsersContainerForTesting,
  createUser,
  normalizeStoredUser,
  readUser,
  replaceUser,
  UserAlreadyExistsError,
  type UserDocument,
} from './users';

interface FakeContainer {
  items: UserDocument[];
  nextEtag: number;
  failNextRead?: { code: number };
}

let fake: FakeContainer;

jest.mock('./cosmos', () => {
  const actual = jest.requireActual<typeof import('./cosmos')>('./cosmos');
  return {
    ...actual,
    getCosmos: () => ({
      database: {
        container: () => ({
          items: {
            create: async (doc: UserDocument) => {
              const existingIdx = fake.items.findIndex((u) => u.id === doc.id);
              if (existingIdx !== -1) {
                throw Object.assign(new Error('conflict'), { code: 409 });
              }
              const internal = { ...doc, _etag: `etag-${fake.nextEtag}` };
              fake.nextEtag += 1;
              fake.items.push(internal);
              return { resource: { ...internal } };
            },
          },
          item: (id: string, partitionKey: string) => ({
            read: async () => {
              if (fake.failNextRead) {
                const err = fake.failNextRead;
                delete fake.failNextRead;
                throw err;
              }
              const found = fake.items.find((u) => u.id === id && u.id === partitionKey);
              return { resource: found ? { ...found } : null };
            },
            replace: async (
              next: UserDocument,
              options?: { accessCondition?: { type: string; condition: string } },
            ) => {
              const idx = fake.items.findIndex((u) => u.id === id && u.id === partitionKey);
              if (idx === -1) throw Object.assign(new Error('not found'), { code: 404 });
              const current = fake.items[idx];
              if (!current) throw Object.assign(new Error('not found'), { code: 404 });
              const condition = options?.accessCondition;
              if (condition?.type === 'IfMatch' && condition.condition !== current._etag) {
                throw Object.assign(new Error('precondition failed'), { code: 412 });
              }
              if ('_etag' in next) {
                throw new Error('replace body must not include _etag (helper bug)');
              }
              const stored = { ...next, _etag: `etag-${fake.nextEtag}` };
              fake.nextEtag += 1;
              fake.items[idx] = stored;
              return { resource: stored };
            },
          }),
        }),
      },
    }),
  };
});

beforeEach(() => {
  fake = { items: [], nextEtag: 1 };
  __resetUsersContainerForTesting();
});

function makeDoc(overrides: Partial<UserDocument> = {}): UserDocument {
  return {
    id: 'u-1',
    preferences: DEFAULT_PREFERENCES,
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('createUser', () => {
  it('inserts a new user doc', async () => {
    const saved = await createUser(makeDoc());
    expect(saved.id).toBe('u-1');
    expect(saved.version).toBe(1);
    expect(fake.items).toHaveLength(1);
  });

  it('throws UserAlreadyExistsError on Cosmos 409', async () => {
    fake.items.push({ ...makeDoc(), _etag: 'etag-pre' });
    await expect(createUser(makeDoc())).rejects.toBeInstanceOf(UserAlreadyExistsError);
  });

  it('propagates non-409 errors unchanged', async () => {
    // Force a non-409 by stubbing a different error path - simulate by
    // making the store's `findIndex` happy but the underlying create
    // throw a 500. We do that via a one-shot override.
    const original = fake.items.findIndex.bind(fake.items);
    fake.items.findIndex = ((..._args: Parameters<typeof original>) => {
      throw Object.assign(new Error('boom'), { code: 500 });
    }) as typeof original;
    try {
      await expect(createUser(makeDoc())).rejects.toMatchObject({ code: 500 });
    } finally {
      fake.items.findIndex = original;
    }
  });
});

describe('replaceUser', () => {
  it('bumps version and applies the mutator', async () => {
    const created = await createUser(makeDoc());
    const updated = await replaceUser(created, (draft) => {
      draft.preferences = { ...DEFAULT_PREFERENCES, editorFontSize: 18 };
      draft.updatedAt = '2026-01-02T00:00:00Z';
    });
    expect(updated.version).toBe(2);
    expect(updated.preferences.editorFontSize).toBe(18);
    expect(updated.updatedAt).toBe('2026-01-02T00:00:00Z');
  });

  it('throws VersionConflictError when the IfMatch fails', async () => {
    const created = await createUser(makeDoc());
    // Mutate the stored copy underneath so its _etag changes.
    const stored = fake.items[0]!;
    stored._etag = 'etag-other';
    await expect(
      replaceUser(created, (draft) => {
        draft.preferences = { ...DEFAULT_PREFERENCES, editorFontSize: 18 };
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });
});

describe('readUser + normalizeStoredUser', () => {
  it('returns null when the doc does not exist', async () => {
    expect(await readUser('missing')).toBeNull();
  });

  it('returns null on Cosmos 404', async () => {
    fake.failNextRead = { code: 404 };
    expect(await readUser('u-1')).toBeNull();
  });

  it('rethrows non-404 errors', async () => {
    fake.failNextRead = { code: 500 };
    await expect(readUser('u-1')).rejects.toMatchObject({ code: 500 });
  });

  it('normalizes a legacy doc without version to version 1 on read', async () => {
    const legacy = { ...makeDoc(), _etag: 'etag-legacy' } as Partial<UserDocument>;
    delete legacy.version;
    fake.items.push(legacy as UserDocument);
    const got = await readUser('u-1');
    expect(got?.version).toBe(1);
  });

  it('preserves an explicit version', async () => {
    const stored = { ...makeDoc({ version: 7 }), _etag: 'etag-7' };
    fake.items.push(stored);
    const got = await readUser('u-1');
    expect(got?.version).toBe(7);
  });
});

describe('normalizeStoredUser direct', () => {
  it('returns the doc unchanged when version is a positive integer', () => {
    const doc = makeDoc({ version: 3 });
    const normalized = normalizeStoredUser(doc);
    expect(normalized).toBe(doc);
  });

  it('defaults version to 1 when missing', () => {
    const doc = { ...makeDoc() } as Partial<UserDocument>;
    delete doc.version;
    const normalized = normalizeStoredUser(doc as UserDocument);
    expect(normalized.version).toBe(1);
  });

  it('defaults version to 1 when not a positive integer', () => {
    expect(normalizeStoredUser(makeDoc({ version: 0 })).version).toBe(1);
    expect(normalizeStoredUser(makeDoc({ version: -2 })).version).toBe(1);
    expect(normalizeStoredUser(makeDoc({ version: 1.5 })).version).toBe(1);
  });
});
