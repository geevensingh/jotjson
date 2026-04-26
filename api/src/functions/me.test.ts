import type { HttpRequest, InvocationContext } from '@azure/functions';
import { DEFAULT_PREFERENCES } from '../shared/preferences';

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
    requireAuth: jest.fn()
  };
});

jest.mock('../shared/users', () => ({
  readUser: jest.fn(),
  upsertUser: jest.fn(),
  __resetUsersContainerForTesting: jest.fn()
}));

import { AuthError } from '../shared/auth';
import { requireAuth as requireAuthMock } from '../shared/auth';
import { readUser as readUserMock, upsertUser as upsertUserMock } from '../shared/users';
import { getMe, postMe, putMePreferences } from './me';

const requireAuth = requireAuthMock as unknown as jest.Mock;
const readUser = readUserMock as unknown as jest.Mock;
const upsertUser = upsertUserMock as unknown as jest.Mock;

function makeRequest(body?: unknown): HttpRequest {
  return {
    headers: { get: (_: string) => 'Bearer fake' },
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    }
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
    expect(upsertUser).not.toHaveBeenCalled();
  });

  it('returns the user doc when it exists', async () => {
    const doc = {
      id: 'u-1',
      preferences: DEFAULT_PREFERENCES,
      createdAt: 'x',
      updatedAt: 'y'
    };
    readUser.mockResolvedValueOnce(doc);
    const res = await getMe(makeRequest(), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual(doc);
  });
});

describe('POST /api/me', () => {
  it('creates a new user doc when none exists', async () => {
    readUser.mockResolvedValueOnce(null);
    upsertUser.mockImplementationOnce(async (doc) => doc);
    const res = await postMe(makeRequest({ preferences: DEFAULT_PREFERENCES }), ctx);
    expect(res.status).toBe(201);
    expect(upsertUser).toHaveBeenCalledTimes(1);
    const saved = upsertUser.mock.calls[0][0];
    expect(saved.id).toBe('u-1');
    expect(saved.preferences).toEqual(DEFAULT_PREFERENCES);
    expect(saved.createdAt).toEqual(saved.updatedAt);
  });

  it('returns 409 if the user already exists', async () => {
    readUser.mockResolvedValueOnce({ id: 'u-1', preferences: DEFAULT_PREFERENCES });
    const res = await postMe(makeRequest({ preferences: DEFAULT_PREFERENCES }), ctx);
    expect(res.status).toBe(409);
    expect(upsertUser).not.toHaveBeenCalled();
  });

  it('rejects unknown preference keys', async () => {
    readUser.mockResolvedValueOnce(null);
    const bad = { ...DEFAULT_PREFERENCES, unknownThing: true };
    const res = await postMe(makeRequest({ preferences: bad }), ctx);
    expect(res.status).toBe(400);
    expect(upsertUser).not.toHaveBeenCalled();
  });

  it('rejects a missing preferences field', async () => {
    const res = await postMe(makeRequest({}), ctx);
    expect(res.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    requireAuth.mockRejectedValueOnce(new AuthError('nope'));
    const res = await postMe(makeRequest({ preferences: DEFAULT_PREFERENCES }), ctx);
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/me/preferences', () => {
  it('upserts normalized preferences and returns them', async () => {
    readUser.mockResolvedValueOnce({
      id: 'u-1',
      preferences: DEFAULT_PREFERENCES,
      createdAt: 't0',
      updatedAt: 't0'
    });
    upsertUser.mockImplementationOnce(async (doc) => doc);
    const updated = { ...DEFAULT_PREFERENCES, editorFontSize: 18 };
    const res = await putMePreferences(makeRequest(updated), ctx);
    expect(res.status).toBe(200);
    expect((res.jsonBody as typeof DEFAULT_PREFERENCES).editorFontSize).toBe(18);
    const saved = upsertUser.mock.calls[0][0];
    expect(saved.createdAt).toBe('t0');
    expect(saved.updatedAt).not.toBe('t0');
  });

  it('creates the document on first write if it does not exist', async () => {
    readUser.mockResolvedValueOnce(null);
    upsertUser.mockImplementationOnce(async (doc) => doc);
    const res = await putMePreferences(makeRequest(DEFAULT_PREFERENCES), ctx);
    expect(res.status).toBe(200);
    expect(upsertUser).toHaveBeenCalled();
  });

  it('rejects unknown keys', async () => {
    const res = await putMePreferences(
      makeRequest({ ...DEFAULT_PREFERENCES, foo: 1 }),
      ctx
    );
    expect(res.status).toBe(400);
    expect(upsertUser).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    requireAuth.mockRejectedValueOnce(new AuthError('nope'));
    const res = await putMePreferences(makeRequest(DEFAULT_PREFERENCES), ctx);
    expect(res.status).toBe(401);
  });
});
