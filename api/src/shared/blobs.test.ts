import {
  BlobValidationError,
  MAX_BLOB_BYTES,
  MAX_HIGHLIGHT_PATH_LENGTH,
  MAX_HIGHLIGHTS,
  MAX_TITLE_LENGTH,
  SlugGenerationError,
  assertHighlightPath,
  assertHighlights,
  createBlob,
  deleteBlobById,
  findBlobByIdOrSlug,
  listBlobsByOwner,
  updateBlob,
  __resetBlobsContainerForTesting,
  type BlobDocument,
  type BlobHighlight,
} from './blobs';
import { HIGHLIGHT_PATH_FIXTURES } from '../../../src/testing/fixtures/highlight-paths.fixture';

// In-memory fake Cosmos container. Tracks items + exposes the query / create /
// replace entry points that blobs.ts uses.
interface FakeContainer {
  items: BlobDocument[];
  forceSlugCollision?: boolean;
}

function makeFakeContainer(): FakeContainer {
  return { items: [] };
}

let fake: FakeContainer;

jest.mock('./cosmos', () => {
  return {
    getCosmos: () => ({
      database: {
        container: () => ({
          items: {
            query: ({
              query,
              parameters,
            }: {
              query: string;
              parameters: { name: string; value: unknown }[];
            }) => ({
              fetchAll: async () => {
                const params = Object.fromEntries(parameters.map((p) => [p.name, p.value]));
                let resources: unknown[];
                if (/VALUE c\.id FROM c WHERE c\.slug/.test(query)) {
                  if (fake.forceSlugCollision) {
                    resources = ['always-colliding'];
                  } else {
                    resources = fake.items
                      .filter((b) => b.slug === params['@slug'])
                      .map((b) => b.id);
                  }
                } else if (/c\.id = @key OR c\.slug = @key/.test(query)) {
                  const key = params['@key'];
                  resources = fake.items.filter((b) => b.id === key || b.slug === key);
                } else if (/WHERE c\.ownerId = @ownerId ORDER BY c\.updatedAt DESC/.test(query)) {
                  const ownerId = params['@ownerId'];
                  resources = fake.items
                    .filter((b) => b.ownerId === ownerId)
                    .slice()
                    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
                } else {
                  throw new Error(`Unexpected query in test: ${query}`);
                }
                return { resources };
              },
            }),
            create: async (doc: BlobDocument) => {
              fake.items.push(doc);
              return { resource: doc };
            },
          },
          item: (id: string, partitionKey: string) => ({
            replace: async (doc: BlobDocument) => {
              const idx = fake.items.findIndex((b) => b.id === id && b.ownerId === partitionKey);
              if (idx === -1) throw Object.assign(new Error('not found'), { code: 404 });
              fake.items[idx] = doc;
              return { resource: doc };
            },
            delete: async () => {
              const idx = fake.items.findIndex((b) => b.id === id && b.ownerId === partitionKey);
              if (idx === -1) throw Object.assign(new Error('not found'), { code: 404 });
              fake.items.splice(idx, 1);
              return {};
            },
          }),
        }),
      },
    }),
  };
});

beforeEach(() => {
  fake = makeFakeContainer();
  __resetBlobsContainerForTesting();
});

const VALID_HIGHLIGHT: BlobHighlight = {
  path: '$.foo',
  color: '#ffeb3b',
  cascade: false,
};

function makeHighlight(overrides: Partial<BlobHighlight> = {}): BlobHighlight {
  return { ...VALID_HIGHLIGHT, ...overrides };
}

describe('highlight validators', () => {
  it('accepts every canonical path from the shared corpus', () => {
    for (const fixtureEntry of HIGHLIGHT_PATH_FIXTURES) {
      expect(assertHighlightPath(fixtureEntry.path)).toBe(fixtureEntry.path);
    }
  });

  it('rejects non-hex colors', () => {
    expect(() => assertHighlights([{ ...VALID_HIGHLIGHT, color: 'yellow' }])).toThrow(
      BlobValidationError,
    );
  });

  it('rejects non-canonical paths', () => {
    const invalidPaths = ['foo', '$.foo..bar', '$.foo[01]', '$[abc]', '$["weird\\u0020key"]'];
    for (const path of invalidPaths) {
      expect(() => assertHighlights([makeHighlight({ path })])).toThrow(BlobValidationError);
    }
  });

  it('rejects empty and over-long paths', () => {
    expect(() => assertHighlights([makeHighlight({ path: '' })])).toThrow(BlobValidationError);
    const overLongPath = `$.${'a'.repeat(MAX_HIGHLIGHT_PATH_LENGTH)}`;
    expect(() => assertHighlights([makeHighlight({ path: overLongPath })])).toThrow(
      BlobValidationError,
    );
  });

  it('rejects duplicate paths', () => {
    expect(() =>
      assertHighlights([makeHighlight({ color: '#111111' }), makeHighlight({ color: '#222222' })]),
    ).toThrow(BlobValidationError);
  });

  it('rejects oversize arrays', () => {
    const tooManyHighlights = Array.from({ length: MAX_HIGHLIGHTS + 1 }, (_unused, index) =>
      makeHighlight({ path: `$.path${index}` }),
    );
    expect(() => assertHighlights(tooManyHighlights)).toThrow(BlobValidationError);
  });

  it('rejects non-boolean cascade values', () => {
    expect(() => assertHighlights([{ ...VALID_HIGHLIGHT, cascade: 'yes' }])).toThrow(
      BlobValidationError,
    );
  });
});

describe('createBlob', () => {
  it('persists a new blob with generated id, slug, and timestamps', async () => {
    const doc = await createBlob('owner-1', { content: '{"a":1}' });
    expect(doc.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(doc.slug).toMatch(/^[A-Za-z0-9]{6}$/);
    expect(doc.content).toBe('{"a":1}');
    expect(doc.ownerId).toBe('owner-1');
    expect(doc.isPublic).toBe(false);
    expect(doc.title).toBeUndefined();
    expect(doc.createdAt).toBe(doc.updatedAt);
    expect(fake.items).toHaveLength(1);
  });

  it('accepts an optional title and trims whitespace', async () => {
    const doc = await createBlob('owner-1', { content: '[]', title: '  hello  ' });
    expect(doc.title).toBe('hello');
  });

  it('drops empty-string titles to undefined', async () => {
    const doc = await createBlob('owner-1', { content: '[]', title: '   ' });
    expect(doc.title).toBeUndefined();
  });

  it('honors isPublic when supplied, defaulting to false', async () => {
    const a = await createBlob('owner-1', { content: '[]' });
    const b = await createBlob('owner-1', { content: '[]', isPublic: true });
    expect(a.isPublic).toBe(false);
    expect(b.isPublic).toBe(true);
  });

  it('stores highlights supplied on create', async () => {
    const highlights = [makeHighlight({ path: '$.created', cascade: true })];
    const doc = await createBlob('owner-1', { content: '{"created":{}}', highlights });
    expect(doc.highlights).toEqual(highlights);
    expect(fake.items).toHaveLength(1);
    expect(fake.items[0]?.highlights).toEqual(highlights);
  });

  it('rejects content larger than MAX_BLOB_BYTES', async () => {
    const tooBig = 'a'.repeat(MAX_BLOB_BYTES + 1);
    await expect(createBlob('owner-1', { content: tooBig })).rejects.toBeInstanceOf(
      BlobValidationError,
    );
  });

  it('accepts content of length exactly MAX_BLOB_BYTES', async () => {
    const exact = 'a'.repeat(MAX_BLOB_BYTES);
    const doc = await createBlob('owner-1', { content: exact });
    expect(doc.content).toBe(exact);
  });

  it('rejects content whose serialized document exceeds the total cap', async () => {
    const escapingContent = '"'.repeat(MAX_BLOB_BYTES);
    await expect(
      createBlob('owner-1', { content: escapingContent, highlights: [VALID_HIGHLIGHT] }),
    ).rejects.toThrow(/blob document too large/);
  });

  it('rejects non-string content', async () => {
    await expect(createBlob('owner-1', { content: 42 })).rejects.toBeInstanceOf(
      BlobValidationError,
    );
  });

  it('rejects title longer than MAX_TITLE_LENGTH', async () => {
    const tooLong = 'x'.repeat(MAX_TITLE_LENGTH + 1);
    await expect(createBlob('owner-1', { content: '[]', title: tooLong })).rejects.toBeInstanceOf(
      BlobValidationError,
    );
  });

  it('rejects missing ownerId', async () => {
    await expect(createBlob('', { content: '[]' })).rejects.toBeInstanceOf(BlobValidationError);
  });

  it('retries on slug collision and produces distinct slugs', async () => {
    const slugs = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const doc = await createBlob('owner-1', { content: `[${i}]` });
      slugs.add(doc.slug);
    }
    expect(slugs.size).toBe(20);
  });

  it('throws SlugGenerationError when every generated slug already exists', async () => {
    fake.forceSlugCollision = true;
    await expect(createBlob('owner-2', { content: '[]' })).rejects.toBeInstanceOf(
      SlugGenerationError,
    );
  });
});

describe('findBlobByIdOrSlug', () => {
  it('finds by slug', async () => {
    const created = await createBlob('owner-1', { content: '{}' });
    const found = await findBlobByIdOrSlug(created.slug);
    expect(found?.id).toBe(created.id);
  });

  it('finds by UUID id', async () => {
    const created = await createBlob('owner-1', { content: '{}' });
    const found = await findBlobByIdOrSlug(created.id);
    expect(found?.slug).toBe(created.slug);
  });

  it('returns null when not found', async () => {
    expect(await findBlobByIdOrSlug('nope')).toBeNull();
  });

  it('returns null for empty input', async () => {
    expect(await findBlobByIdOrSlug('')).toBeNull();
  });
});

describe('updateBlob', () => {
  async function seed(): Promise<BlobDocument> {
    return createBlob('owner-1', { content: '{"a":1}', title: 'original' });
  }

  it('replaces content and stamps updatedAt', async () => {
    const orig = await seed();
    await new Promise((r) => setTimeout(r, 2));
    const updated = await updateBlob(orig, { content: '{"b":2}' });
    expect(updated.content).toBe('{"b":2}');
    expect(updated.id).toBe(orig.id);
    expect(updated.slug).toBe(orig.slug);
    expect(updated.createdAt).toBe(orig.createdAt);
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
      new Date(orig.updatedAt).getTime(),
    );
  });

  it('updates title and isPublic independently', async () => {
    const orig = await seed();
    const updated = await updateBlob(orig, { title: 'new', isPublic: true });
    expect(updated.title).toBe('new');
    expect(updated.isPublic).toBe(true);
    expect(updated.content).toBe(orig.content);
  });

  it('clears the title when patched to an empty string', async () => {
    const orig = await seed();
    const updated = await updateBlob(orig, { title: '' });
    expect(updated.title).toBeUndefined();
  });

  it('round-trips replaced highlights across create, read, update, and read', async () => {
    const created = await createBlob('owner-1', { content: '{"foo":1}' });
    expect((await findBlobByIdOrSlug(created.id))?.highlights).toBeUndefined();

    const highlights = [makeHighlight({ path: '$.foo', color: '#00ffaa', cascade: true })];
    await updateBlob(created, { highlights });

    const found = await findBlobByIdOrSlug(created.id);
    expect(found?.highlights).toEqual(highlights);
  });

  it('preserves stored highlights when the update omits highlights', async () => {
    const highlights = [makeHighlight({ path: '$.foo', color: '#abcdef', cascade: true })];
    const original = await createBlob('owner-1', { content: '{"foo":1}', highlights });

    const updated = await updateBlob(original, { title: 'renamed' });

    expect(updated.highlights).toEqual(highlights);
    expect((await findBlobByIdOrSlug(original.id))?.highlights).toEqual(highlights);
  });

  it('enforces size limit on content updates', async () => {
    const orig = await seed();
    const tooBig = 'a'.repeat(MAX_BLOB_BYTES + 1);
    await expect(updateBlob(orig, { content: tooBig })).rejects.toBeInstanceOf(BlobValidationError);
  });

  it('ignores undefined patch fields', async () => {
    const orig = await seed();
    const updated = await updateBlob(orig, {});
    expect(updated.content).toBe(orig.content);
    expect(updated.title).toBe(orig.title);
    expect(updated.isPublic).toBe(orig.isPublic);
  });
});

describe('deleteBlobById', () => {
  it('removes a blob owned by the user and returns true', async () => {
    const created = await createBlob('owner-1', { content: '{"a":1}' });
    const ok = await deleteBlobById(created.id, 'owner-1');
    expect(ok).toBe(true);
    expect(fake.items).toHaveLength(0);
  });

  it('returns false when the blob does not exist', async () => {
    const ok = await deleteBlobById('missing-id', 'owner-1');
    expect(ok).toBe(false);
  });

  it('returns false when the owner does not match (404 from Cosmos)', async () => {
    const created = await createBlob('owner-1', { content: '{"a":1}' });
    const ok = await deleteBlobById(created.id, 'someone-else');
    expect(ok).toBe(false);
    // Original blob still present.
    expect(fake.items).toHaveLength(1);
  });
});

describe('listBlobsByOwner', () => {
  it('returns only the caller\u0027s blobs, newest first', async () => {
    const a = await createBlob('owner-a', { content: '{"a":1}', title: 'A' });
    // Nudge timestamps so ordering is deterministic.
    await new Promise((r) => setTimeout(r, 5));
    const b = await createBlob('owner-a', { content: '{"b":2}', title: 'B' });
    await new Promise((r) => setTimeout(r, 5));
    const c = await createBlob('owner-a', { content: '{"c":3}', title: 'C' });
    await createBlob('owner-b', { content: '{"x":9}' });

    const list = await listBlobsByOwner('owner-a');
    expect(list.map((x) => x.id)).toEqual([c.id, b.id, a.id]);
    expect(list.every((x) => x.ownerId === 'owner-a')).toBe(true);
  });

  it('returns an empty list for an unknown owner', async () => {
    const list = await listBlobsByOwner('nobody');
    expect(list).toEqual([]);
  });

  it('returns an empty list when given an empty ownerId', async () => {
    const list = await listBlobsByOwner('');
    expect(list).toEqual([]);
  });
});
