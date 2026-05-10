import type { HttpRequest, InvocationContext } from '@azure/functions';
import { DEFAULT_PREFERENCES } from '../shared/preferences';
import { VersionConflictError } from '../shared/cosmos';

// Intercept the app.http registration so importing me.ts doesn't try to
// register with the real Functions host at module load time.
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

class _UserAlreadyExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserAlreadyExistsError';
  }
}

jest.mock('../shared/users', () => ({
  readUser: jest.fn(),
  createUser: jest.fn(),
  replaceUser: jest.fn(),
  __resetUsersContainerForTesting: jest.fn(),
  UserAlreadyExistsError: _UserAlreadyExistsError,
}));

import { AuthError } from '../shared/auth';
import { requireAuth as requireAuthMock } from '../shared/auth';
import {
  readUser as readUserMock,
  createUser as createUserMock,
  replaceUser as replaceUserMock,
  UserAlreadyExistsError,
} from '../shared/users';
import { getMe, postMe, putMePreferences } from './me';

const requireAuth = requireAuthMock as unknown as jest.Mock;
const readUser = readUserMock as unknown as jest.Mock;
const createUser = createUserMock as unknown as jest.Mock;
const replaceUser = replaceUserMock as unknown as jest.Mock;

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
}

function makeRequest(options: RequestOptions = {}): HttpRequest {
  const headers = options.headers ?? {};
  return {
    headers: {
      get: (name: string) => {
        const lower = name.toLowerCase();
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === lower) return headers[key];
        }
        return null;
      },
    },
    json: async () => {
      if (options.body === undefined) throw new Error('no body');
      return options.body;
    },
  } as unknown as HttpRequest;
}

const ctx = { log: jest.fn(), error: jest.fn() } as unknown as InvocationContext;

beforeEach(() => {
  jest.resetAllMocks();
  requireAuth.mockResolvedValue({ id: 'u-1', displayName: 'Alice', email: 'a@b.com' });
});

describe('GET /api/me', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuth.mockRejectedValueOnce(new AuthError('Missing bearer token'));
    const res = await getMe(makeRequest(), ctx);
    expect(res.status).toBe(401);
  });

  it('returns 404 when user document does not exist', async () => {
    readUser.mockResolvedValueOnce(null);
    const res = await getMe(makeRequest(), ctx);
    expect(res.status).toBe(404);
    expect(createUser).not.toHaveBeenCalled();
    expect(replaceUser).not.toHaveBeenCalled();
  });

  it('returns the user doc with ETag header when it exists', async () => {
    const doc = {
      id: 'u-1',
      preferences: DEFAULT_PREFERENCES,
      version: 3,
      createdAt: 'x',
      updatedAt: 'y',
    };
    readUser.mockResolvedValueOnce(doc);
    const res = await getMe(makeRequest(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers).toEqual({ ETag: '"3"' });
    expect((res.jsonBody as Record<string, unknown>)['_etag']).toBeUndefined();
    expect(res.jsonBody).toEqual(doc);
  });

  it('strips Cosmos _etag from the response body', async () => {
    const doc = {
      id: 'u-1',
      preferences: DEFAULT_PREFERENCES,
      version: 3,
      createdAt: 'x',
      updatedAt: 'y',
      _etag: 'cosmos-etag',
    };
    readUser.mockResolvedValueOnce(doc);
    const res = await getMe(makeRequest(), ctx);
    expect(res.status).toBe(200);
    expect((res.jsonBody as Record<string, unknown>)['_etag']).toBeUndefined();
  });

  it('defaults activeRuleSetIds to [] and strips legacy defaultRuleSetIds on read', async () => {
    // Stale-shape stored doc carries the legacy `defaultRuleSetIds`
    // key without canonical `activeRuleSetIds`. The wire response
    // must default to [] and strip the legacy key. See
    // DESIGN_SPEC.md -> Versioning -> Schema evolution.
    const stored = {
      id: 'u-1',
      preferences: {
        ...DEFAULT_PREFERENCES,
        defaultRuleSetIds: ['rs-x'],
      },
      version: 1,
      createdAt: 'x',
      updatedAt: 'y',
    };
    delete (stored.preferences as Record<string, unknown>)['activeRuleSetIds'];
    readUser.mockResolvedValueOnce(stored);
    const res = await getMe(makeRequest(), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { preferences: Record<string, unknown> };
    expect(body.preferences['activeRuleSetIds']).toEqual([]);
    expect(body.preferences['defaultRuleSetIds']).toBeUndefined();
  });
});

describe('POST /api/me', () => {
  it('creates a new user doc when none exists and stamps version 1', async () => {
    readUser.mockResolvedValueOnce(null);
    createUser.mockImplementationOnce(async (doc) => doc);
    const res = await postMe(makeRequest({ body: { preferences: DEFAULT_PREFERENCES } }), ctx);
    expect(res.status).toBe(201);
    expect(res.headers).toEqual({ ETag: '"1"' });
    expect(createUser).toHaveBeenCalledTimes(1);
    const saved = createUser.mock.calls[0][0];
    expect(saved.id).toBe('u-1');
    expect(saved.version).toBe(1);
    expect(saved.preferences).toEqual(DEFAULT_PREFERENCES);
    expect(saved.createdAt).toEqual(saved.updatedAt);
  });

  it('returns 409 with ETag if the user already exists (pre-flight read path)', async () => {
    readUser.mockResolvedValueOnce({
      id: 'u-1',
      preferences: DEFAULT_PREFERENCES,
      version: 4,
    });
    const res = await postMe(makeRequest({ body: { preferences: DEFAULT_PREFERENCES } }), ctx);
    expect(res.status).toBe(409);
    expect(res.headers).toEqual({ ETag: '"4"' });
    expect(createUser).not.toHaveBeenCalled();
  });

  it('returns 409 with ETag on a true cross-tab create race', async () => {
    readUser.mockResolvedValueOnce(null);
    createUser.mockRejectedValueOnce(new UserAlreadyExistsError('User u-1 already exists'));
    readUser.mockResolvedValueOnce({
      id: 'u-1',
      preferences: DEFAULT_PREFERENCES,
      version: 1,
    });
    const res = await postMe(makeRequest({ body: { preferences: DEFAULT_PREFERENCES } }), ctx);
    expect(res.status).toBe(409);
    expect(res.headers).toEqual({ ETag: '"1"' });
    const body = res.jsonBody as { user: Record<string, unknown> };
    expect(body.user['_etag']).toBeUndefined();
  });

  it('rejects unknown preference keys', async () => {
    readUser.mockResolvedValueOnce(null);
    const bad = { ...DEFAULT_PREFERENCES, unknownThing: true };
    const res = await postMe(makeRequest({ body: { preferences: bad } }), ctx);
    expect(res.status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('rejects a missing preferences field', async () => {
    const res = await postMe(makeRequest({ body: {} }), ctx);
    expect(res.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    requireAuth.mockRejectedValueOnce(new AuthError('nope'));
    const res = await postMe(makeRequest({ body: { preferences: DEFAULT_PREFERENCES } }), ctx);
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/me/preferences', () => {
  function existingDoc(version = 1): Record<string, unknown> {
    return {
      id: 'u-1',
      preferences: DEFAULT_PREFERENCES,
      version,
      createdAt: 't0',
      updatedAt: 't0',
    };
  }

  it('returns 400 when If-Match header is missing', async () => {
    const res = await putMePreferences(
      makeRequest({ body: { ...DEFAULT_PREFERENCES, editorFontSize: 18 } }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(readUser).not.toHaveBeenCalled();
    expect(replaceUser).not.toHaveBeenCalled();
  });

  it('returns 400 when If-Match is malformed', async () => {
    const res = await putMePreferences(
      makeRequest({
        headers: { 'If-Match': 'not-a-number' },
        body: DEFAULT_PREFERENCES,
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(replaceUser).not.toHaveBeenCalled();
  });

  it('returns 404 when no user is seeded yet', async () => {
    readUser.mockResolvedValueOnce(null);
    const res = await putMePreferences(
      makeRequest({
        headers: { 'If-Match': '"1"' },
        body: DEFAULT_PREFERENCES,
      }),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(replaceUser).not.toHaveBeenCalled();
  });

  it('returns 412 when the in-memory version check fails', async () => {
    readUser.mockResolvedValueOnce(existingDoc(2));
    const res = await putMePreferences(
      makeRequest({
        headers: { 'If-Match': '"1"' },
        body: DEFAULT_PREFERENCES,
      }),
      ctx,
    );
    expect(res.status).toBe(412);
    expect(replaceUser).not.toHaveBeenCalled();
  });

  it('replaces preferences and returns ETag on success', async () => {
    readUser.mockResolvedValueOnce(existingDoc(1));
    replaceUser.mockImplementationOnce(async (existing, mutate) => {
      const draft = { ...existing };
      mutate(draft);
      return { ...draft, version: existing.version + 1 };
    });
    const updated = { ...DEFAULT_PREFERENCES, editorFontSize: 18 };
    const res = await putMePreferences(
      makeRequest({ headers: { 'If-Match': '"1"' }, body: updated }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers).toEqual({ ETag: '"2"' });
    expect((res.jsonBody as typeof DEFAULT_PREFERENCES).editorFontSize).toBe(18);
  });

  it('returns 412 when replaceUser throws VersionConflictError (cross-tab race)', async () => {
    readUser.mockResolvedValueOnce(existingDoc(1));
    replaceUser.mockRejectedValueOnce(new VersionConflictError('race'));
    const res = await putMePreferences(
      makeRequest({ headers: { 'If-Match': '"1"' }, body: DEFAULT_PREFERENCES }),
      ctx,
    );
    expect(res.status).toBe(412);
  });

  it('accepts valid manualHighlightColor values', async () => {
    readUser.mockResolvedValueOnce(existingDoc(1));
    replaceUser.mockImplementationOnce(async (existing, mutate) => {
      const draft = { ...existing };
      mutate(draft);
      return { ...draft, version: existing.version + 1 };
    });
    const updated = structuredClone(DEFAULT_PREFERENCES);
    updated.treeHighlightColors.dark.manualHighlightColor = '#abcdef';
    updated.treeHighlightColors.light.manualHighlightColor = '#123456';
    const res = await putMePreferences(
      makeRequest({ headers: { 'If-Match': '"1"' }, body: updated }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = res.jsonBody as typeof DEFAULT_PREFERENCES;
    expect(body.treeHighlightColors.dark.manualHighlightColor).toBe('#abcdef');
    expect(body.treeHighlightColors.light.manualHighlightColor).toBe('#123456');
  });

  it('rejects malformed manualHighlightColor values', async () => {
    const bad = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;
    const colors = bad['treeHighlightColors'] as Record<string, Record<string, unknown>>;
    colors['dark']['manualHighlightColor'] = '#fff';
    const res = await putMePreferences(
      makeRequest({ headers: { 'If-Match': '"1"' }, body: bad }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(replaceUser).not.toHaveBeenCalled();
  });

  it('rejects unknown keys', async () => {
    const res = await putMePreferences(
      makeRequest({
        headers: { 'If-Match': '"1"' },
        body: { ...DEFAULT_PREFERENCES, foo: 1 },
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(replaceUser).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    requireAuth.mockRejectedValueOnce(new AuthError('nope'));
    const res = await putMePreferences(
      makeRequest({ headers: { 'If-Match': '"1"' }, body: DEFAULT_PREFERENCES }),
      ctx,
    );
    expect(res.status).toBe(401);
  });
});
