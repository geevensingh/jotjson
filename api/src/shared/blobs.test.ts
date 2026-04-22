import {
  BlobValidationError,
  MAX_BLOB_BYTES,
  MAX_TITLE_LENGTH,
  SlugGenerationError,
  createBlob,
  findBlobByIdOrSlug,
  updateBlob,
  __resetBlobsContainerForTesting,
  type BlobDocument
} from './blobs';

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
            query: ({ query, parameters }: { query: string; parameters: { name: string; value: unknown }[] }) => ({
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
                } else {
                  throw new Error(`Unexpected query in test: ${query}`);
                }
                return { resources };
              }
            }),
            create: async (doc: BlobDocument) => {
              fake.items.push(doc);
              return { resource: doc };
            }
          },
          item: (id: string, partitionKey: string) => ({
            replace: async (doc: BlobDocument) => {
              const idx = fake.items.findIndex(
                (b) => b.id === id && b.ownerId === partitionKey
              );
              if (idx === -1) throw Object.assign(new Error('not found'), { code: 404 });
              fake.items[idx] = doc;
              return { resource: doc };
            }
          })
        })
      }
    })
  };
});

beforeEach(() => {
  fake = makeFakeContainer();
  __resetBlobsContainerForTesting();
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

  it('rejects content larger than MAX_BLOB_BYTES', async () => {
    const tooBig = 'a'.repeat(MAX_BLOB_BYTES + 1);
    await expect(createBlob('owner-1', { content: tooBig })).rejects.toBeInstanceOf(
      BlobValidationError
    );
  });

  it('rejects non-string content', async () => {
    await expect(
      createBlob('owner-1', { content: 42 as unknown as string })
    ).rejects.toBeInstanceOf(BlobValidationError);
  });

  it('rejects title longer than MAX_TITLE_LENGTH', async () => {
    const tooLong = 'x'.repeat(MAX_TITLE_LENGTH + 1);
    await expect(
      createBlob('owner-1', { content: '[]', title: tooLong })
    ).rejects.toBeInstanceOf(BlobValidationError);
  });

  it('rejects missing ownerId', async () => {
    await expect(createBlob('', { content: '[]' })).rejects.toBeInstanceOf(
      BlobValidationError
    );
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
    await expect(
      createBlob('owner-2', { content: '[]' })
    ).rejects.toBeInstanceOf(SlugGenerationError);
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
      new Date(orig.updatedAt).getTime()
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

  it('enforces size limit on content updates', async () => {
    const orig = await seed();
    const tooBig = 'a'.repeat(MAX_BLOB_BYTES + 1);
    await expect(updateBlob(orig, { content: tooBig })).rejects.toBeInstanceOf(
      BlobValidationError
    );
  });

  it('ignores undefined patch fields', async () => {
    const orig = await seed();
    const updated = await updateBlob(orig, {});
    expect(updated.content).toBe(orig.content);
    expect(updated.title).toBe(orig.title);
    expect(updated.isPublic).toBe(orig.isPublic);
  });
});
