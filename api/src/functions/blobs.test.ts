import type { HttpRequest, InvocationContext } from '@azure/functions';

jest.mock('@azure/functions', () => {
  const actual = jest.requireActual('@azure/functions');
  return { ...actual, app: { http: jest.fn() } };
});

jest.mock('../shared/auth', () => {
  const actual = jest.requireActual('../shared/auth');
  return {
    ...actual,
    requireAuth: jest.fn(),
    tryAuth: jest.fn()
  };
});

jest.mock('../shared/blobs', () => ({
  createBlob: jest.fn(),
  deleteBlobById: jest.fn(),
  findBlobByIdOrSlug: jest.fn(),
  listBlobsByOwner: jest.fn(),
  updateBlob: jest.fn(),
  __resetBlobsContainerForTesting: jest.fn(),
  MAX_BLOBS_PER_USER: 100,
  BlobValidationError: class BlobValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'BlobValidationError';
    }
  },
  SlugGenerationError: class SlugGenerationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'SlugGenerationError';
    }
  }
}));

jest.mock('../shared/users', () => ({
  readUser: jest.fn()
}));

jest.mock('../shared/history', () => ({
  recordEntry: jest.fn(),
  getRecentViewAt: jest.fn(),
  VIEW_DEBOUNCE_SECONDS: 300
}));

import { AuthError, requireAuth as requireAuthMock, tryAuth as tryAuthMock } from '../shared/auth';
import {
  BlobValidationError,
  SlugGenerationError,
  createBlob as createBlobMock,
  deleteBlobById as deleteBlobByIdMock,
  findBlobByIdOrSlug as findBlobMock,
  listBlobsByOwner as listBlobsByOwnerMock,
  updateBlob as updateBlobMock
} from '../shared/blobs';
import { recordEntry as recordEntryMock, getRecentViewAt as getRecentViewAtMock } from '../shared/history';
import { readUser as readUserMock } from '../shared/users';
import { deleteBlob, getBlob, listBlobs, postBlob, putBlob } from './blobs';

const requireAuth = requireAuthMock as unknown as jest.Mock;
const tryAuth = tryAuthMock as unknown as jest.Mock;
const createBlob = createBlobMock as unknown as jest.Mock;
const readUser = readUserMock as unknown as jest.Mock;
const deleteBlobByIdSpy = deleteBlobByIdMock as unknown as jest.Mock;
const findBlob = findBlobMock as unknown as jest.Mock;
const listBlobsSpy = listBlobsByOwnerMock as unknown as jest.Mock;
const updateBlob = updateBlobMock as unknown as jest.Mock;
const recordEntry = recordEntryMock as unknown as jest.Mock;
const getRecentViewAt = getRecentViewAtMock as unknown as jest.Mock;

function makeRequest(opts: { body?: unknown; params?: Record<string, string> } = {}): HttpRequest {
  return {
    headers: { get: (_: string) => 'Bearer fake' },
    params: opts.params ?? {},
    json: async () => {
      if (opts.body === undefined) throw new Error('no body');
      return opts.body;
    }
  } as unknown as HttpRequest;
}

const ctx = { log: jest.fn(), error: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

beforeEach(() => {
  jest.resetAllMocks();
  requireAuth.mockResolvedValue({ id: 'u-1', displayName: 'Alice' });
  tryAuth.mockResolvedValue(null);
  recordEntry.mockResolvedValue(undefined);
  getRecentViewAt.mockResolvedValue(null);
  // Default: caller is well below the blob quota. Individual tests that
  // exercise the quota path override this mock.
  listBlobsSpy.mockResolvedValue([]);
});

const sampleBlob = {
  id: 'uuid-1',
  slug: 'abc123',
  content: '{"hello":"world"}',
  ownerId: 'u-1',
  isPublic: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
};

describe('POST /api/blobs', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuth.mockRejectedValueOnce(new AuthError('Missing bearer token'));
    const res = await postBlob(makeRequest({ body: { content: '{}' } }), ctx);
    expect(res.status).toBe(401);
    expect(createBlob).not.toHaveBeenCalled();
  });

  it('returns 400 when the body is not JSON', async () => {
    const res = await postBlob(makeRequest(), ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 when the body is not an object', async () => {
    const res = await postBlob(makeRequest({ body: 'nope' }), ctx);
    expect(res.status).toBe(400);
  });

  it('creates a blob for the authenticated caller', async () => {
    createBlob.mockResolvedValueOnce(sampleBlob);
    const res = await postBlob(
      makeRequest({ body: { content: '{}', title: 'hi', isPublic: false } }),
      ctx
    );
    expect(res.status).toBe(201);
    expect(res.jsonBody).toEqual(sampleBlob);
    expect(createBlob).toHaveBeenCalledWith('u-1', {
      content: '{}',
      title: 'hi',
      isPublic: false
    });
  });

  it('omits title/isPublic when missing from the payload', async () => {
    createBlob.mockResolvedValueOnce(sampleBlob);
    await postBlob(makeRequest({ body: { content: '{}' } }), ctx);
    expect(createBlob).toHaveBeenCalledWith('u-1', { content: '{}' });
  });

  it('translates BlobValidationError into 400', async () => {
    createBlob.mockRejectedValueOnce(new BlobValidationError('content too large'));
    const res = await postBlob(makeRequest({ body: { content: 'too big' } }), ctx);
    expect(res.status).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'content too large' });
  });

  it('translates SlugGenerationError into 503', async () => {
    createBlob.mockRejectedValueOnce(new SlugGenerationError('out of slugs'));
    const res = await postBlob(makeRequest({ body: { content: '{}' } }), ctx);
    expect(res.status).toBe(503);
  });

  it('returns 500 on unexpected errors', async () => {
    createBlob.mockRejectedValueOnce(new Error('boom'));
    const res = await postBlob(makeRequest({ body: { content: '{}' } }), ctx);
    expect(res.status).toBe(500);
  });
});

describe('POST /api/blobs - quota enforcement', () => {
  function manyBlobs(count: number): unknown[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `existing-${i}`,
      slug: `slug-${i}`,
      ownerId: 'u-1',
      content: '{}',
      isPublic: false,
      // Older indices are older (smaller updatedAt).
      createdAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      updatedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      title: i === 0 ? 'oldest title' : undefined
    }));
  }

  it('auto-deletes the oldest blob under the auto_fifo strategy', async () => {
    listBlobsSpy.mockResolvedValueOnce(manyBlobs(100));
    readUser.mockResolvedValueOnce({
      id: 'u-1',
      preferences: { blobQuotaStrategy: 'auto_fifo' }
    });
    deleteBlobByIdSpy.mockResolvedValueOnce(true);
    createBlob.mockResolvedValueOnce(sampleBlob);

    const res = await postBlob(makeRequest({ body: { content: '{}' } }), ctx);

    expect(res.status).toBe(201);
    expect(deleteBlobByIdSpy).toHaveBeenCalledWith('existing-0', 'u-1');
    const body = res.jsonBody as Record<string, unknown>;
    expect(body['id']).toBe('uuid-1');
    expect(body['autoDeleted']).toEqual({
      id: 'existing-0',
      slug: 'slug-0',
      title: 'oldest title'
    });
  });

  it('defaults to auto_fifo when the user doc is missing', async () => {
    listBlobsSpy.mockResolvedValueOnce(manyBlobs(100));
    readUser.mockResolvedValueOnce(null);
    deleteBlobByIdSpy.mockResolvedValueOnce(true);
    createBlob.mockResolvedValueOnce(sampleBlob);

    const res = await postBlob(makeRequest({ body: { content: '{}' } }), ctx);

    expect(res.status).toBe(201);
    expect(deleteBlobByIdSpy).toHaveBeenCalled();
  });

  it('returns 409 with code quota_exceeded under the manual strategy', async () => {
    listBlobsSpy.mockResolvedValueOnce(manyBlobs(100));
    readUser.mockResolvedValueOnce({
      id: 'u-1',
      preferences: { blobQuotaStrategy: 'manual' }
    });

    const res = await postBlob(makeRequest({ body: { content: '{}' } }), ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as Record<string, unknown>)['code']).toBe('quota_exceeded');
    expect(deleteBlobByIdSpy).not.toHaveBeenCalled();
    expect(createBlob).not.toHaveBeenCalled();
  });

  it('omits autoDeleted when the caller is well under the quota', async () => {
    listBlobsSpy.mockResolvedValueOnce(manyBlobs(5));
    createBlob.mockResolvedValueOnce(sampleBlob);

    const res = await postBlob(makeRequest({ body: { content: '{}' } }), ctx);

    expect(res.status).toBe(201);
    expect(readUser).not.toHaveBeenCalled();
    expect(deleteBlobByIdSpy).not.toHaveBeenCalled();
    expect((res.jsonBody as Record<string, unknown>)['autoDeleted']).toBeUndefined();
  });

  it('returns 500 when the quota check throws', async () => {
    listBlobsSpy.mockRejectedValueOnce(new Error('cosmos down'));
    const res = await postBlob(makeRequest({ body: { content: '{}' } }), ctx);
    expect(res.status).toBe(500);
    expect(createBlob).not.toHaveBeenCalled();
  });
});

describe('GET /api/blobs/:idOrSlug', () => {
  it('returns the blob when found (no auth required)', async () => {
    findBlob.mockResolvedValueOnce(sampleBlob);
    const res = await getBlob(makeRequest({ params: { idOrSlug: 'abc123' } }), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual(sampleBlob);
    expect(requireAuth).not.toHaveBeenCalled();
  });

  it('returns 404 when not found', async () => {
    findBlob.mockResolvedValueOnce(null);
    const res = await getBlob(makeRequest({ params: { idOrSlug: 'nope' } }), ctx);
    expect(res.status).toBe(404);
  });

  it('returns 400 when idOrSlug is missing', async () => {
    const res = await getBlob(makeRequest({}), ctx);
    expect(res.status).toBe(400);
  });

  it('returns 500 on unexpected errors', async () => {
    findBlob.mockRejectedValueOnce(new Error('cosmos unreachable'));
    const res = await getBlob(makeRequest({ params: { idOrSlug: 'abc' } }), ctx);
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/blobs/:id', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuth.mockRejectedValueOnce(new AuthError('nope'));
    const res = await putBlob(
      makeRequest({ params: { id: 'uuid-1' }, body: { content: '{}' } }),
      ctx
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 when id path param is missing', async () => {
    const res = await putBlob(makeRequest({ body: { content: '{}' } }), ctx);
    expect(res.status).toBe(400);
  });

  it('returns 404 when the blob does not exist', async () => {
    findBlob.mockResolvedValueOnce(null);
    const res = await putBlob(
      makeRequest({ params: { id: 'uuid-x' }, body: { content: '{}' } }),
      ctx
    );
    expect(res.status).toBe(404);
  });

  it('rejects the slug in the path and steers to the UUID id', async () => {
    findBlob.mockResolvedValueOnce(sampleBlob);
    const res = await putBlob(
      // caller passed the slug - sampleBlob.id !== 'abc123'
      makeRequest({ params: { id: 'abc123' }, body: { content: '{}' } }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  it('returns 403 when the blob belongs to another owner', async () => {
    findBlob.mockResolvedValueOnce({ ...sampleBlob, ownerId: 'u-2' });
    const res = await putBlob(
      makeRequest({ params: { id: 'uuid-1' }, body: { content: '{}' } }),
      ctx
    );
    expect(res.status).toBe(403);
  });

  it('updates the blob when the caller owns it', async () => {
    findBlob.mockResolvedValueOnce(sampleBlob);
    const updated = { ...sampleBlob, content: '{"b":2}', updatedAt: '2026-01-02' };
    updateBlob.mockResolvedValueOnce(updated);

    const res = await putBlob(
      makeRequest({
        params: { id: 'uuid-1' },
        body: { content: '{"b":2}', title: 'renamed' }
      }),
      ctx
    );
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual(updated);
    expect(updateBlob).toHaveBeenCalledWith(sampleBlob, {
      content: '{"b":2}',
      title: 'renamed'
    });
  });

  it('translates BlobValidationError into 400', async () => {
    findBlob.mockResolvedValueOnce(sampleBlob);
    updateBlob.mockRejectedValueOnce(new BlobValidationError('content too large'));
    const res = await putBlob(
      makeRequest({ params: { id: 'uuid-1' }, body: { content: 'big' } }),
      ctx
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/blobs (list)', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuth.mockRejectedValueOnce(new AuthError('nope'));
    const res = await listBlobs(makeRequest(), ctx);
    expect(res.status).toBe(401);
    expect(listBlobsSpy).not.toHaveBeenCalled();
  });

  it('returns the caller\u0027s blobs', async () => {
    listBlobsSpy.mockResolvedValueOnce([sampleBlob]);
    const res = await listBlobs(makeRequest(), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual([sampleBlob]);
    expect(listBlobsSpy).toHaveBeenCalledWith('u-1');
  });

  it('returns an empty array when the caller has no blobs', async () => {
    listBlobsSpy.mockResolvedValueOnce([]);
    const res = await listBlobs(makeRequest(), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual([]);
  });

  it('returns 500 on unexpected errors', async () => {
    listBlobsSpy.mockRejectedValueOnce(new Error('cosmos down'));
    const res = await listBlobs(makeRequest(), ctx);
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/blobs/:id', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuth.mockRejectedValueOnce(new AuthError('nope'));
    const res = await deleteBlob(
      makeRequest({ params: { id: 'uuid-1' } }),
      ctx
    );
    expect(res.status).toBe(401);
    expect(deleteBlobByIdSpy).not.toHaveBeenCalled();
  });

  it('returns 400 when id is missing', async () => {
    const res = await deleteBlob(makeRequest(), ctx);
    expect(res.status).toBe(400);
  });

  it('returns 404 when the blob does not exist', async () => {
    findBlob.mockResolvedValueOnce(null);
    const res = await deleteBlob(
      makeRequest({ params: { id: 'uuid-1' } }),
      ctx
    );
    expect(res.status).toBe(404);
    expect(deleteBlobByIdSpy).not.toHaveBeenCalled();
  });

  it('returns 400 when the path param is the slug, not a UUID', async () => {
    findBlob.mockResolvedValueOnce({ ...sampleBlob, id: 'uuid-1' });
    const res = await deleteBlob(
      makeRequest({ params: { id: 'abc123' } }),
      ctx
    );
    expect(res.status).toBe(400);
    expect(deleteBlobByIdSpy).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller does not own the blob', async () => {
    findBlob.mockResolvedValueOnce({ ...sampleBlob, ownerId: 'someone-else' });
    const res = await deleteBlob(
      makeRequest({ params: { id: 'uuid-1' } }),
      ctx
    );
    expect(res.status).toBe(403);
    expect(deleteBlobByIdSpy).not.toHaveBeenCalled();
  });

  it('returns 204 on successful deletion', async () => {
    findBlob.mockResolvedValueOnce(sampleBlob);
    deleteBlobByIdSpy.mockResolvedValueOnce(true);
    const res = await deleteBlob(
      makeRequest({ params: { id: 'uuid-1' } }),
      ctx
    );
    expect(res.status).toBe(204);
    expect(deleteBlobByIdSpy).toHaveBeenCalledWith('uuid-1', 'u-1');
  });

  it('returns 404 when the doc disappears between find and delete', async () => {
    findBlob.mockResolvedValueOnce(sampleBlob);
    deleteBlobByIdSpy.mockResolvedValueOnce(false);
    const res = await deleteBlob(
      makeRequest({ params: { id: 'uuid-1' } }),
      ctx
    );
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected errors', async () => {
    findBlob.mockResolvedValueOnce(sampleBlob);
    deleteBlobByIdSpy.mockRejectedValueOnce(new Error('cosmos down'));
    const res = await deleteBlob(
      makeRequest({ params: { id: 'uuid-1' } }),
      ctx
    );
    expect(res.status).toBe(500);
  });
});

describe('history recording hooks (v1: viewed only)', () => {
  describe('POST /api/blobs (saved) - no history recorded', () => {
    it('does not record any history on create', async () => {
      createBlob.mockResolvedValueOnce({ ...sampleBlob, title: 'Notes' });
      const res = await postBlob(makeRequest({ body: { content: '{}' } }), ctx);
      expect(res.status).toBe(201);
      expect(recordEntry).not.toHaveBeenCalled();
      expect(readUser).not.toHaveBeenCalled();
    });
  });

  describe('PUT /api/blobs/{id} (edited) - no history recorded', () => {
    it('does not record any history on update', async () => {
      findBlob.mockResolvedValueOnce({ ...sampleBlob, id: 'uuid-1' });
      updateBlob.mockResolvedValueOnce({ ...sampleBlob, id: 'uuid-1' });
      await putBlob(
        makeRequest({ params: { id: 'uuid-1' }, body: { content: '{}' } }),
        ctx
      );
      expect(recordEntry).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/blobs/{id} (deleted) - no history recorded', () => {
    it('does not record any history on delete', async () => {
      findBlob.mockResolvedValueOnce({ ...sampleBlob, id: 'uuid-1' });
      deleteBlobByIdSpy.mockResolvedValueOnce(true);
      const res = await deleteBlob(makeRequest({ params: { id: 'uuid-1' } }), ctx);
      expect(res.status).toBe(204);
      expect(recordEntry).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/blobs/{idOrSlug} (viewed)', () => {
    const otherOwnersBlob = { ...sampleBlob, ownerId: 'someone-else', title: 'Other' };

    it('records "viewed" by default (no preferences set)', async () => {
      findBlob.mockResolvedValueOnce(otherOwnersBlob);
      tryAuth.mockResolvedValueOnce({ id: 'u-1' });
      readUser.mockResolvedValue({ preferences: {} });
      const res = await getBlob(makeRequest({ params: { idOrSlug: 'abc123' } }), ctx);
      expect(res.status).toBe(200);
      expect(recordEntry).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'viewed', userId: 'u-1', title: 'Other' })
      );
    });

    it('records "viewed" when recentlyViewedEnabled is true', async () => {
      findBlob.mockResolvedValueOnce(otherOwnersBlob);
      tryAuth.mockResolvedValueOnce({ id: 'u-1' });
      readUser.mockResolvedValue({ preferences: { recentlyViewedEnabled: true } });
      await getBlob(makeRequest({ params: { idOrSlug: 'abc123' } }), ctx);
      expect(recordEntry).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'viewed' })
      );
    });

    it('does NOT record when recentlyViewedEnabled is false', async () => {
      findBlob.mockResolvedValueOnce(otherOwnersBlob);
      tryAuth.mockResolvedValueOnce({ id: 'u-1' });
      readUser.mockResolvedValue({ preferences: { recentlyViewedEnabled: false } });
      await getBlob(makeRequest({ params: { idOrSlug: 'abc123' } }), ctx);
      expect(recordEntry).not.toHaveBeenCalled();
    });

    it('coerces legacy historyTrackingMode "save_only" to enabled (records)', async () => {
      findBlob.mockResolvedValueOnce(otherOwnersBlob);
      tryAuth.mockResolvedValueOnce({ id: 'u-1' });
      readUser.mockResolvedValue({ preferences: { historyTrackingMode: 'save_only' } });
      await getBlob(makeRequest({ params: { idOrSlug: 'abc123' } }), ctx);
      expect(recordEntry).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'viewed' })
      );
    });

    it('coerces legacy historyTrackingMode "all_actions" to enabled (records)', async () => {
      findBlob.mockResolvedValueOnce(otherOwnersBlob);
      tryAuth.mockResolvedValueOnce({ id: 'u-1' });
      readUser.mockResolvedValue({ preferences: { historyTrackingMode: 'all_actions' } });
      await getBlob(makeRequest({ params: { idOrSlug: 'abc123' } }), ctx);
      expect(recordEntry).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'viewed' })
      );
    });

    it('fails closed: when readUser throws, no record is written', async () => {
      findBlob.mockResolvedValueOnce(otherOwnersBlob);
      tryAuth.mockResolvedValueOnce({ id: 'u-1' });
      readUser.mockRejectedValueOnce(new Error('cosmos hiccup'));
      const res = await getBlob(makeRequest({ params: { idOrSlug: 'abc123' } }), ctx);
      expect(res.status).toBe(200);
      expect(recordEntry).not.toHaveBeenCalled();
    });

    it('debounces a second view within VIEW_DEBOUNCE_SECONDS', async () => {
      findBlob.mockResolvedValueOnce(otherOwnersBlob);
      tryAuth.mockResolvedValueOnce({ id: 'u-1' });
      readUser.mockResolvedValue({ preferences: { recentlyViewedEnabled: true } });
      const recent = new Date(Date.now() - 60_000).toISOString();
      getRecentViewAt.mockResolvedValueOnce(recent);
      await getBlob(makeRequest({ params: { idOrSlug: 'abc123' } }), ctx);
      expect(recordEntry).not.toHaveBeenCalled();
    });

    it('records again when the previous view is older than the debounce window', async () => {
      findBlob.mockResolvedValueOnce(otherOwnersBlob);
      tryAuth.mockResolvedValueOnce({ id: 'u-1' });
      readUser.mockResolvedValue({ preferences: { recentlyViewedEnabled: true } });
      const old = new Date(Date.now() - 10 * 60_000).toISOString();
      getRecentViewAt.mockResolvedValueOnce(old);
      await getBlob(makeRequest({ params: { idOrSlug: 'abc123' } }), ctx);
      expect(recordEntry).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'viewed' })
      );
    });

    it('does NOT record when caller is the owner', async () => {
      findBlob.mockResolvedValueOnce({ ...sampleBlob, ownerId: 'u-1' });
      tryAuth.mockResolvedValueOnce({ id: 'u-1' });
      readUser.mockResolvedValue({ preferences: { recentlyViewedEnabled: true } });
      await getBlob(makeRequest({ params: { idOrSlug: 'abc123' } }), ctx);
      expect(recordEntry).not.toHaveBeenCalled();
    });

    it('does NOT record when caller is anonymous', async () => {
      findBlob.mockResolvedValueOnce(otherOwnersBlob);
      tryAuth.mockResolvedValueOnce(null);
      const res = await getBlob(makeRequest({ params: { idOrSlug: 'abc123' } }), ctx);
      expect(res.status).toBe(200);
      expect(recordEntry).not.toHaveBeenCalled();
      expect(readUser).not.toHaveBeenCalled();
    });

    it('does not fail the read when the history write throws', async () => {
      findBlob.mockResolvedValueOnce(otherOwnersBlob);
      tryAuth.mockResolvedValueOnce({ id: 'u-1' });
      readUser.mockResolvedValue({ preferences: { recentlyViewedEnabled: true } });
      recordEntry.mockRejectedValueOnce(new Error('cosmos hiccup'));
      const res = await getBlob(makeRequest({ params: { idOrSlug: 'abc123' } }), ctx);
      expect(res.status).toBe(200);
    });
  });
});
