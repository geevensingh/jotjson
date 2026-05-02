import {
  HISTORY_RETENTION_PER_USER,
  __resetHistoryContainerForTesting,
  clearAll,
  getRecentViewAt,
  listEntries,
  pruneFifo,
  recordEntry,
  type HistoryDocument,
} from './history';

interface FakeContainer {
  items: HistoryDocument[];
  /** Force the next create call to throw. */
  forceCreateError?: Error;
  /** Force the next delete call to throw a 404 (or arbitrary error). */
  forceDeleteError?: { code?: number; message?: string };
}

let fake: FakeContainer;

jest.mock('./cosmos', () => ({
  getCosmos: () => ({
    database: {
      container: () => ({
        items: {
          query: (
            {
              query,
              parameters,
            }: { query: string; parameters: { name: string; value: unknown }[] },
            _options?: unknown,
          ) => {
            const params = Object.fromEntries(parameters.map((p) => [p.name, p.value]));
            const userId = params['@uid'] as string;
            const matches = () => fake.items.filter((e) => e.userId === userId);
            return {
              fetchAll: async () => {
                if (/SELECT VALUE COUNT\(1\)/.test(query)) {
                  return { resources: [matches().length] };
                }
                if (/SELECT TOP 1 c\.accessedAt/.test(query)) {
                  const blobId = params['@bid'] as string;
                  const views = matches()
                    .filter((e) => e.action === 'viewed' && e.blobId === blobId)
                    .sort((a, b) =>
                      a.accessedAt < b.accessedAt ? 1 : a.accessedAt > b.accessedAt ? -1 : 0,
                    );
                  return {
                    resources: views[0] ? [{ accessedAt: views[0].accessedAt }] : [],
                  };
                }
                if (/SELECT TOP @n c\.id/.test(query)) {
                  const n = params['@n'] as number;
                  const oldest = [...matches()]
                    .sort((a, b) => {
                      if (a.accessedAt !== b.accessedAt) {
                        return a.accessedAt < b.accessedAt ? -1 : 1;
                      }
                      return a.id < b.id ? -1 : 1;
                    })
                    .slice(0, n);
                  return { resources: oldest.map((e) => ({ id: e.id })) };
                }
                if (/SELECT TOP 100 c\.id/.test(query)) {
                  const ids = matches()
                    .slice(0, 100)
                    .map((e) => ({ id: e.id }));
                  return { resources: ids };
                }
                throw new Error(`Unexpected fetchAll query: ${query}`);
              },
              fetchNext: async () => {
                if (/SELECT \* FROM c WHERE/.test(query)) {
                  // Always-applied: action = "viewed".
                  let rows = matches().filter((e) => e.action === 'viewed');
                  const q = params['@q'];
                  if (typeof q === 'string') {
                    const needle = q.toLowerCase();
                    rows = rows.filter((e) => {
                      const t = (e.title ?? '').toLowerCase();
                      const s = (e.slug ?? '').toLowerCase();
                      return t.includes(needle) || s.includes(needle);
                    });
                  }
                  const from = params['@from'];
                  if (typeof from === 'string') {
                    rows = rows.filter((e) => e.accessedAt >= from);
                  }
                  const to = params['@to'];
                  if (typeof to === 'string') {
                    rows = rows.filter((e) => e.accessedAt <= to);
                  }
                  const sorted = [...rows].sort((a, b) =>
                    a.accessedAt < b.accessedAt ? 1 : a.accessedAt > b.accessedAt ? -1 : 0,
                  );
                  return { resources: sorted, continuationToken: undefined };
                }
                throw new Error(`Unexpected fetchNext query: ${query}`);
              },
            };
          },
          create: async <T>(doc: T) => {
            if (fake.forceCreateError) {
              const err = fake.forceCreateError;
              fake.forceCreateError = undefined;
              throw err;
            }
            fake.items.push(doc as unknown as HistoryDocument);
            return { resource: doc };
          },
        },
        item: (id: string, _userId: string) => ({
          delete: async () => {
            if (fake.forceDeleteError) {
              const err = fake.forceDeleteError;
              fake.forceDeleteError = undefined;
              const e: Error & { code?: number } = new Error(err.message ?? 'forced');
              e.code = err.code;
              throw e;
            }
            const idx = fake.items.findIndex((e) => e.id === id);
            if (idx === -1) {
              const e: Error & { code?: number } = new Error('not found');
              e.code = 404;
              throw e;
            }
            fake.items.splice(idx, 1);
            return {};
          },
        }),
      }),
    },
  }),
}));

beforeEach(() => {
  fake = { items: [] };
  __resetHistoryContainerForTesting();
});

function preload(entries: Partial<HistoryDocument>[]): void {
  for (const e of entries) {
    fake.items.push({
      id: e.id ?? `id-${fake.items.length}`,
      userId: e.userId ?? 'u-1',
      accessedAt: e.accessedAt ?? new Date().toISOString(),
      action: e.action ?? 'viewed',
      ...(e.blobId ? { blobId: e.blobId } : {}),
      ...(e.slug ? { slug: e.slug } : {}),
      ...(e.title ? { title: e.title } : {}),
    });
  }
}

describe('recordEntry', () => {
  it('persists a HistoryDocument with snapshot fields and a generated id/timestamp', async () => {
    const before = new Date().toISOString();
    const saved = await recordEntry({
      userId: 'u-1',
      action: 'viewed',
      blobId: 'b-1',
      slug: 'abc123',
      title: 'My Blob',
    });
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.userId).toBe('u-1');
    expect(saved.blobId).toBe('b-1');
    expect(saved.slug).toBe('abc123');
    expect(saved.title).toBe('My Blob');
    expect(saved.action).toBe('viewed');
    expect(saved.accessedAt >= before).toBe(true);
    expect(fake.items).toHaveLength(1);
  });

  it('omits optional fields when not supplied', async () => {
    const saved = await recordEntry({ userId: 'u-1', action: 'viewed' });
    expect(saved).not.toHaveProperty('blobId');
    expect(saved).not.toHaveProperty('slug');
    expect(saved).not.toHaveProperty('title');
  });

  it('throws when userId is missing', async () => {
    await expect(recordEntry({ userId: '', action: 'viewed' })).rejects.toThrow(/userId/);
  });

  it('does not throw when prune fails after the write succeeds', async () => {
    const overflow = HISTORY_RETENTION_PER_USER + 5;
    preload(
      Array.from({ length: overflow }, (_, i) => ({
        id: `e-${i}`,
        userId: 'u-1',
        action: 'viewed',
        accessedAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.${String(i).padStart(3, '0')}Z`,
      })),
    );
    fake.forceDeleteError = { code: 500, message: 'cosmos hiccup' };
    await expect(recordEntry({ userId: 'u-1', action: 'viewed' })).resolves.toMatchObject({
      action: 'viewed',
    });
    expect(fake.items.some((e) => e.action === 'viewed' && e.id !== 'e-0')).toBe(true);
  });
});

describe('pruneFifo', () => {
  it('is a no-op when count <= retention cap', async () => {
    preload(
      Array.from({ length: 10 }, (_, i) => ({
        id: `e-${i}`,
        accessedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      })),
    );
    expect(await pruneFifo('u-1')).toBe(0);
    expect(fake.items).toHaveLength(10);
  });

  it('deletes the oldest entries until count == cap', async () => {
    const overflow = 7;
    const total = HISTORY_RETENTION_PER_USER + overflow;
    preload(
      Array.from({ length: total }, (_, i) => ({
        id: `e-${String(i).padStart(4, '0')}`,
        accessedAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
      })),
    );
    expect(await pruneFifo('u-1')).toBe(overflow);
    expect(fake.items).toHaveLength(HISTORY_RETENTION_PER_USER);
    expect(fake.items.find((e) => e.id === 'e-0000')).toBeUndefined();
    expect(fake.items.find((e) => e.id === 'e-0006')).toBeUndefined();
    expect(fake.items.find((e) => e.id === 'e-0007')).toBeDefined();
  });

  it('only prunes entries belonging to the requested user', async () => {
    preload([
      ...Array.from({ length: HISTORY_RETENTION_PER_USER + 3 }, (_, i) => ({
        id: `u1-${i}`,
        userId: 'u-1',
        accessedAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
      })),
      { id: 'u2-0', userId: 'u-2', accessedAt: '2025-01-01T00:00:00Z' },
    ]);
    await pruneFifo('u-1');
    expect(fake.items.find((e) => e.id === 'u2-0')).toBeDefined();
  });
});

describe('getRecentViewAt', () => {
  it('returns null when there are no viewed entries for the blob', async () => {
    preload([{ action: 'viewed', blobId: 'b-other', accessedAt: '2026-01-01T00:00:00Z' }]);
    expect(await getRecentViewAt('u-1', 'b-1')).toBeNull();
  });

  it('returns the newest viewed timestamp scoped to the blob', async () => {
    preload([
      { action: 'viewed', blobId: 'b-1', accessedAt: '2026-01-01T00:00:00Z' },
      { action: 'viewed', blobId: 'b-1', accessedAt: '2026-01-03T00:00:00Z' },
      { action: 'viewed', blobId: 'b-1', accessedAt: '2026-01-02T00:00:00Z' },
      { action: 'viewed', blobId: 'b-2', accessedAt: '2026-02-01T00:00:00Z' },
    ]);
    expect(await getRecentViewAt('u-1', 'b-1')).toBe('2026-01-03T00:00:00Z');
  });

  it('does not bleed across users', async () => {
    preload([
      { userId: 'u-1', action: 'viewed', blobId: 'b-1', accessedAt: '2025-01-01T00:00:00Z' },
      { userId: 'u-2', action: 'viewed', blobId: 'b-1', accessedAt: '2026-01-01T00:00:00Z' },
    ]);
    expect(await getRecentViewAt('u-1', 'b-1')).toBe('2025-01-01T00:00:00Z');
  });
});

describe('listEntries', () => {
  it('returns viewed entries newest-first', async () => {
    preload([
      { id: 'a', action: 'viewed', accessedAt: '2026-01-01T00:00:00Z' },
      { id: 'b', action: 'viewed', accessedAt: '2026-03-01T00:00:00Z' },
      { id: 'c', action: 'viewed', accessedAt: '2026-02-01T00:00:00Z' },
    ]);
    const result = await listEntries('u-1');
    expect(result.entries.map((e) => e.id)).toEqual(['b', 'c', 'a']);
  });

  it('returns an empty array when the user has no entries', async () => {
    expect(await listEntries('u-1')).toEqual({ entries: [] });
  });

  it('filters out legacy non-"viewed" rows', async () => {
    preload([
      { id: 'v', action: 'viewed', accessedAt: '2026-01-01T00:00:00Z' },
      // Legacy rows from before the v1 narrowing - cast since the type is
      // narrowed but raw stored docs may still carry old action values.
      { id: 's', action: 'saved' as unknown as 'viewed', accessedAt: '2026-01-02T00:00:00Z' },
      { id: 'p', action: 'pasted' as unknown as 'viewed', accessedAt: '2026-01-03T00:00:00Z' },
    ]);
    const result = await listEntries('u-1');
    expect(result.entries.map((e) => e.id)).toEqual(['v']);
  });

  it('filters by q against title and slug, case-insensitively', async () => {
    preload([
      { id: 'a', title: 'Auth payload', accessedAt: '2026-01-01T00:00:00Z' },
      { id: 'b', slug: 'AuthDemo', accessedAt: '2026-02-01T00:00:00Z' },
      { id: 'c', title: 'Cart', accessedAt: '2026-03-01T00:00:00Z' },
    ]);
    const result = await listEntries('u-1', { q: 'auth' });
    expect(result.entries.map((e) => e.id).sort()).toEqual(['a', 'b']);
  });

  it('treats an empty/whitespace q as no filter', async () => {
    preload([
      { id: 'a', title: 'Hello' },
      { id: 'b', title: 'World' },
    ]);
    const result = await listEntries('u-1', { q: '   ' });
    expect(result.entries.length).toBe(2);
  });

  it('returns no entries when q matches nothing', async () => {
    preload([{ id: 'a', title: 'Hello' }]);
    const result = await listEntries('u-1', { q: 'zzz' });
    expect(result.entries).toEqual([]);
  });

  it('filters by from (inclusive lower bound)', async () => {
    preload([
      { id: 'a', accessedAt: '2024-01-01T00:00:00Z' },
      { id: 'b', accessedAt: '2024-02-01T00:00:00Z' },
      { id: 'c', accessedAt: '2024-03-01T00:00:00Z' },
    ]);
    const result = await listEntries('u-1', { from: '2024-02-01T00:00:00Z' });
    expect(result.entries.map((e) => e.id)).toEqual(['c', 'b']);
  });

  it('filters by to (inclusive upper bound)', async () => {
    preload([
      { id: 'a', accessedAt: '2024-01-01T00:00:00Z' },
      { id: 'b', accessedAt: '2024-02-01T00:00:00Z' },
      { id: 'c', accessedAt: '2024-03-01T00:00:00Z' },
    ]);
    const result = await listEntries('u-1', { to: '2024-02-01T00:00:00Z' });
    expect(result.entries.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('combines from, to, and q', async () => {
    preload([
      { id: 'a', title: 'Auth', accessedAt: '2024-01-15T00:00:00Z' },
      { id: 'b', title: 'Auth', accessedAt: '2024-02-15T00:00:00Z' },
      { id: 'c', title: 'Auth', accessedAt: '2024-03-15T00:00:00Z' },
      { id: 'd', title: 'Cart', accessedAt: '2024-02-15T00:00:00Z' },
    ]);
    const result = await listEntries('u-1', {
      q: 'auth',
      from: '2024-02-01T00:00:00Z',
      to: '2024-03-31T23:59:59Z',
    });
    expect(result.entries.map((e) => e.id)).toEqual(['c', 'b']);
  });
});

describe('clearAll', () => {
  it("removes only the requested user's entries", async () => {
    preload([
      { id: 'u1-a', userId: 'u-1' },
      { id: 'u1-b', userId: 'u-1' },
      { id: 'u2-a', userId: 'u-2' },
    ]);
    expect(await clearAll('u-1')).toBe(2);
    expect(fake.items.map((e) => e.id)).toEqual(['u2-a']);
  });

  it('returns 0 when there is nothing to delete', async () => {
    expect(await clearAll('u-1')).toBe(0);
  });
});
