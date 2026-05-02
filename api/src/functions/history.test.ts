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
  };
});

jest.mock('../shared/history', () => ({
  listEntries: jest.fn(),
  clearAll: jest.fn(),
}));

import { AuthError, requireAuth as requireAuthMock } from '../shared/auth';
import { clearAll as clearAllMock, listEntries as listEntriesMock } from '../shared/history';
import { deleteHistory, getHistory } from './history';

const requireAuth = requireAuthMock as unknown as jest.Mock;
const listEntries = listEntriesMock as unknown as jest.Mock;
const clearAll = clearAllMock as unknown as jest.Mock;

function makeRequest(
  opts: {
    body?: unknown;
    query?: Record<string, string>;
    authed?: boolean;
  } = {},
): HttpRequest {
  const params = new URLSearchParams(opts.query ?? {});
  return {
    headers: { get: () => (opts.authed === false ? null : 'Bearer fake') },
    query: { get: (k: string) => params.get(k) },
    json: async () => {
      if (opts.body === undefined) throw new Error('no body');
      return opts.body;
    },
  } as unknown as HttpRequest;
}

const ctx = {
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
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
      entries: [{ id: 'h-1', userId: 'u-1', action: 'viewed', accessedAt: '2026-01-01T00:00:00Z' }],
      continuationToken: 'next',
    });
    const res = await getHistory(makeRequest(), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({
      entries: [{ id: 'h-1', userId: 'u-1', action: 'viewed', accessedAt: '2026-01-01T00:00:00Z' }],
      continuationToken: 'next',
    });
    expect(listEntries).toHaveBeenCalledWith('u-1', {});
  });

  it('forwards pageSize and continuationToken to listEntries', async () => {
    listEntries.mockResolvedValueOnce({ entries: [] });
    await getHistory(makeRequest({ query: { pageSize: '25', continuationToken: 'abc' } }), ctx);
    expect(listEntries).toHaveBeenCalledWith('u-1', {
      pageSize: 25,
      continuationToken: 'abc',
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
    const res = await getHistory(makeRequest({ query: { q: 'a'.repeat(101) } }), ctx);
    expect(res.status).toBe(400);
    expect(listEntries).not.toHaveBeenCalled();
  });

  it('forwards from and to ISO timestamps', async () => {
    listEntries.mockResolvedValueOnce({ entries: [] });
    await getHistory(
      makeRequest({
        query: {
          from: '2024-01-01T00:00:00Z',
          to: '2024-01-31T23:59:59Z',
        },
      }),
      ctx,
    );
    expect(listEntries).toHaveBeenCalledWith('u-1', {
      from: '2024-01-01T00:00:00Z',
      to: '2024-01-31T23:59:59Z',
    });
  });

  it('rejects a malformed from value', async () => {
    const res = await getHistory(makeRequest({ query: { from: 'not-a-date' } }), ctx);
    expect(res.status).toBe(400);
    expect(listEntries).not.toHaveBeenCalled();
  });

  it('rejects a bare-date from value', async () => {
    const res = await getHistory(makeRequest({ query: { from: '2024-01-01' } }), ctx);
    expect(res.status).toBe(400);
    expect(listEntries).not.toHaveBeenCalled();
  });

  it('rejects from after to', async () => {
    const res = await getHistory(
      makeRequest({
        query: {
          from: '2024-02-01T00:00:00Z',
          to: '2024-01-01T00:00:00Z',
        },
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(listEntries).not.toHaveBeenCalled();
  });

  it('treats an empty from/to as no filter', async () => {
    listEntries.mockResolvedValueOnce({ entries: [] });
    await getHistory(makeRequest({ query: { from: '', to: '' } }), ctx);
    expect(listEntries).toHaveBeenCalledWith('u-1', {});
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
