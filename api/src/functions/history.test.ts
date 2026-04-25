import type { HttpRequest, InvocationContext } from '@azure/functions';

jest.mock('@azure/functions', () => {
  const actual = jest.requireActual('@azure/functions');
  return { ...actual, app: { http: jest.fn() } };
});

jest.mock('../shared/auth', () => {
  const actual = jest.requireActual('../shared/auth');
  return {
    ...actual,
    requireAuth: jest.fn()
  };
});

jest.mock('../shared/history', () => ({
  PASTE_DEBOUNCE_SECONDS: 60,
  listEntries: jest.fn(),
  clearAll: jest.fn(),
  recordEntry: jest.fn(),
  getRecentPasteAt: jest.fn()
}));

import { AuthError, requireAuth as requireAuthMock } from '../shared/auth';
import {
  clearAll as clearAllMock,
  getRecentPasteAt as getRecentPasteAtMock,
  listEntries as listEntriesMock,
  recordEntry as recordEntryMock
} from '../shared/history';
import { deleteHistory, getHistory, postHistory } from './history';

const requireAuth = requireAuthMock as unknown as jest.Mock;
const listEntries = listEntriesMock as unknown as jest.Mock;
const clearAll = clearAllMock as unknown as jest.Mock;
const recordEntry = recordEntryMock as unknown as jest.Mock;
const getRecentPasteAt = getRecentPasteAtMock as unknown as jest.Mock;

function makeRequest(opts: {
  body?: unknown;
  query?: Record<string, string>;
  authed?: boolean;
} = {}): HttpRequest {
  const params = new URLSearchParams(opts.query ?? {});
  return {
    headers: { get: () => (opts.authed === false ? null : 'Bearer fake') },
    query: { get: (k: string) => params.get(k) },
    json: async () => {
      if (opts.body === undefined) throw new Error('no body');
      return opts.body;
    }
  } as unknown as HttpRequest;
}

const ctx = {
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
} as unknown as InvocationContext;

beforeEach(() => {
  jest.resetAllMocks();
  requireAuth.mockResolvedValue({ id: 'u-1' });
});

describe('GET /api/history', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuth.mockRejectedValueOnce(new AuthError('Missing bearer token'));
    const res = await getHistory(makeRequest(), ctx);
    expect(res.status).toBe(401);
    expect(listEntries).not.toHaveBeenCalled();
  });

  it('returns the paged result from listEntries', async () => {
    listEntries.mockResolvedValueOnce({
      entries: [{ id: 'h-1', userId: 'u-1', action: 'saved', accessedAt: '2026-01-01T00:00:00Z' }],
      continuationToken: 'next'
    });
    const res = await getHistory(makeRequest(), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({
      entries: [{ id: 'h-1', userId: 'u-1', action: 'saved', accessedAt: '2026-01-01T00:00:00Z' }],
      continuationToken: 'next'
    });
    expect(listEntries).toHaveBeenCalledWith('u-1', {});
  });

  it('forwards pageSize and continuationToken to listEntries', async () => {
    listEntries.mockResolvedValueOnce({ entries: [] });
    await getHistory(
      makeRequest({ query: { pageSize: '25', continuationToken: 'abc' } }),
      ctx
    );
    expect(listEntries).toHaveBeenCalledWith('u-1', {
      pageSize: 25,
      continuationToken: 'abc'
    });
  });

  it('rejects a non-numeric pageSize', async () => {
    const res = await getHistory(makeRequest({ query: { pageSize: 'lots' } }), ctx);
    expect(res.status).toBe(400);
    expect(listEntries).not.toHaveBeenCalled();
  });

  it('forwards a trimmed q to listEntries', async () => {
    listEntries.mockResolvedValueOnce({ entries: [] });
    await getHistory(makeRequest({ query: { q: '  Auth  ' } }), ctx);
    expect(listEntries).toHaveBeenCalledWith('u-1', { q: 'Auth' });
  });

  it('drops an empty q so the server returns the unfiltered timeline', async () => {
    listEntries.mockResolvedValueOnce({ entries: [] });
    await getHistory(makeRequest({ query: { q: '   ' } }), ctx);
    expect(listEntries).toHaveBeenCalledWith('u-1', {});
  });

  it('rejects q longer than 100 characters', async () => {
    const res = await getHistory(
      makeRequest({ query: { q: 'a'.repeat(101) } }),
      ctx
    );
    expect(res.status).toBe(400);
    expect(listEntries).not.toHaveBeenCalled();
  });

  it('returns 500 when Cosmos blows up', async () => {
    listEntries.mockRejectedValueOnce(new Error('boom'));
    const res = await getHistory(makeRequest(), ctx);
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/history', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuth.mockRejectedValueOnce(new AuthError('Missing bearer token'));
    const res = await deleteHistory(makeRequest(), ctx);
    expect(res.status).toBe(401);
    expect(clearAll).not.toHaveBeenCalled();
  });

  it('clears entries for the caller and returns 204', async () => {
    clearAll.mockResolvedValueOnce(42);
    const res = await deleteHistory(makeRequest(), ctx);
    expect(res.status).toBe(204);
    expect(clearAll).toHaveBeenCalledWith('u-1');
  });

  it('returns 500 when clearAll throws', async () => {
    clearAll.mockRejectedValueOnce(new Error('boom'));
    const res = await deleteHistory(makeRequest(), ctx);
    expect(res.status).toBe(500);
  });
});

describe('POST /api/history', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuth.mockRejectedValueOnce(new AuthError('Missing bearer token'));
    const res = await postHistory(makeRequest({ body: { action: 'pasted' } }), ctx);
    expect(res.status).toBe(401);
    expect(recordEntry).not.toHaveBeenCalled();
  });

  it('returns 400 when the body is not JSON', async () => {
    const res = await postHistory(makeRequest(), ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 when action is missing or wrong', async () => {
    expect((await postHistory(makeRequest({ body: {} }), ctx)).status).toBe(400);
    expect((await postHistory(makeRequest({ body: { action: 'saved' } }), ctx)).status).toBe(400);
    expect(recordEntry).not.toHaveBeenCalled();
  });

  it('returns 400 when slug is the wrong type', async () => {
    const res = await postHistory(
      makeRequest({ body: { action: 'pasted', slug: 123 } }),
      ctx
    );
    expect(res.status).toBe(400);
    expect(recordEntry).not.toHaveBeenCalled();
  });

  it('returns 400 when title is the wrong type', async () => {
    const res = await postHistory(
      makeRequest({ body: { action: 'pasted', title: ['no'] } }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  it('records a paste when there is no recent paste', async () => {
    getRecentPasteAt.mockResolvedValueOnce(null);
    recordEntry.mockResolvedValueOnce({
      id: 'h-1',
      userId: 'u-1',
      action: 'pasted',
      accessedAt: '2026-01-01T00:00:00Z'
    });
    const res = await postHistory(
      makeRequest({ body: { action: 'pasted', slug: 'abc', title: 'Notes' } }),
      ctx
    );
    expect(res.status).toBe(201);
    expect(recordEntry).toHaveBeenCalledWith({
      userId: 'u-1',
      action: 'pasted',
      slug: 'abc',
      title: 'Notes'
    });
  });

  it('debounces a second paste within 60s and returns 204 with no record', async () => {
    const recent = new Date(Date.now() - 5_000).toISOString();
    getRecentPasteAt.mockResolvedValueOnce(recent);
    const res = await postHistory(
      makeRequest({ body: { action: 'pasted' } }),
      ctx
    );
    expect(res.status).toBe(204);
    expect(recordEntry).not.toHaveBeenCalled();
  });

  it('records a paste when the previous paste is older than the debounce window', async () => {
    const recent = new Date(Date.now() - 120_000).toISOString();
    getRecentPasteAt.mockResolvedValueOnce(recent);
    recordEntry.mockResolvedValueOnce({
      id: 'h-2',
      userId: 'u-1',
      action: 'pasted',
      accessedAt: '2026-01-01T00:02:00Z'
    });
    const res = await postHistory(
      makeRequest({ body: { action: 'pasted' } }),
      ctx
    );
    expect(res.status).toBe(201);
    expect(recordEntry).toHaveBeenCalled();
  });

  it('returns 500 when recordEntry throws', async () => {
    getRecentPasteAt.mockResolvedValueOnce(null);
    recordEntry.mockRejectedValueOnce(new Error('boom'));
    const res = await postHistory(
      makeRequest({ body: { action: 'pasted' } }),
      ctx
    );
    expect(res.status).toBe(500);
  });
});
