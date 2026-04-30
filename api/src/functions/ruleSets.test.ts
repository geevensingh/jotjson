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

// We can't use `jest.requireActual('../shared/ruleSets')` for the
// validator because that module transitively imports `./cosmos`,
// which loads `@azure/identity` -> `uuid` (ESM) - a chain that Jest's
// CJS transform can't currently parse. Instead, we hand-roll a
// minimal validator with just enough behaviour to exercise the
// handler's success and validation-failure paths.
class _RuleSetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleSetValidationError';
  }
}
class _RuleSetVersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleSetVersionConflictError';
  }
}

jest.mock('../shared/ruleSets', () => ({
  createRuleSet: jest.fn(),
  deleteRuleSetById: jest.fn(),
  findRuleSetById: jest.fn(),
  listRuleSetsByOwner: jest.fn(),
  readRuleSet: jest.fn(),
  replaceRuleSet: jest.fn(),
  assertRuleSetPayload: (input: unknown) => {
    if (!input || typeof input !== 'object') {
      throw new _RuleSetValidationError('payload must be an object');
    }
    const obj = input as { name?: unknown; rules?: unknown };
    if (typeof obj.name !== 'string' || obj.name.trim().length === 0) {
      throw new _RuleSetValidationError('name is required');
    }
    if (!Array.isArray(obj.rules)) {
      throw new _RuleSetValidationError('rules must be an array');
    }
    return { name: obj.name.trim(), rules: obj.rules };
  },
  __resetRuleSetsContainerForTesting: jest.fn(),
  MAX_RULE_SETS_PER_USER: 20,
  MAX_RULES_PER_SET: 50,
  MAX_RULE_SET_NAME_LENGTH: 80,
  MAX_RULE_MATCH_VALUE_LENGTH: 200,
  RuleSetValidationError: _RuleSetValidationError,
  RuleSetVersionConflictError: _RuleSetVersionConflictError
}));

jest.mock('../shared/users', () => ({
  readUser: jest.fn(),
  upsertUser: jest.fn()
}));

import { AuthError, requireAuth as requireAuthMock } from '../shared/auth';
import { findPreset } from '../shared/ruleSetPresets';
import {
  createRuleSet as createRuleSetMock,
  deleteRuleSetById as deleteRuleSetByIdMock,
  findRuleSetById as findRuleSetByIdMock,
  listRuleSetsByOwner as listRuleSetsByOwnerMock,
  readRuleSet as readRuleSetMock,
  replaceRuleSet as replaceRuleSetMock,
  RuleSetValidationError,
  RuleSetVersionConflictError
} from '../shared/ruleSets';
import { readUser as readUserMock, upsertUser as upsertUserMock } from '../shared/users';
import {
  deleteRuleSet,
  clonePreset,
  getRuleSet,
  listPresets,
  listRuleSets,
  postRuleSet,
  putRuleSet
} from './ruleSets';
import type { TelemetryClient } from 'applicationinsights';
import {
  __resetTelemetryInitForTesting,
  __setTelemetryClientForTesting as __setTelemetryClientForTestingT
} from '../shared/telemetry';

// Silence the warn-once that shared/http.ts forbidden() would otherwise
// trigger via trackEvent when the connection string env var is missing.
// Specs that need to assert on emit install a real mock client in their
// own beforeEach.
__setTelemetryClientForTestingT(null);

const requireAuth = requireAuthMock as unknown as jest.Mock;
const createRuleSet = createRuleSetMock as unknown as jest.Mock;
const deleteRuleSetById = deleteRuleSetByIdMock as unknown as jest.Mock;
const findRuleSetById = findRuleSetByIdMock as unknown as jest.Mock;
const listRuleSetsByOwner = listRuleSetsByOwnerMock as unknown as jest.Mock;
const readRuleSet = readRuleSetMock as unknown as jest.Mock;
const replaceRuleSet = replaceRuleSetMock as unknown as jest.Mock;
const readUser = readUserMock as unknown as jest.Mock;
const upsertUser = upsertUserMock as unknown as jest.Mock;

function makeRequest(opts: {
  body?: unknown;
  params?: Record<string, string>;
  headers?: Record<string, string>;
} = {}): HttpRequest {
  const headers = opts.headers ?? {};
  return {
    headers: {
      get: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? null
    },
    params: opts.params ?? {},
    json: async () => {
      if (opts.body === undefined) throw new Error('no body');
      return opts.body;
    }
  } as unknown as HttpRequest;
}

const ctx = { log: jest.fn(), error: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const sampleRule = {
  id: 'r1',
  target: 'key' as const,
  matchType: 'contains' as const,
  matchValue: 'error',
  caseSensitive: false,
  style: { backgroundColor: '#ffeb3b' }
};

const sampleSet = {
  id: 'rs-1',
  userId: 'u-1',
  name: 'Errors',
  rules: [sampleRule],
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
};

beforeEach(() => {
  jest.resetAllMocks();
  requireAuth.mockResolvedValue({ id: 'u-1', displayName: 'Alice' });
  listRuleSetsByOwner.mockResolvedValue([]);
});

describe('POST /api/rule-sets', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuth.mockRejectedValueOnce(new AuthError('Missing bearer token'));
    const res = await postRuleSet(
      makeRequest({ body: { name: 'x', rules: [] } }),
      ctx
    );
    expect(res.status).toBe(401);
    expect(createRuleSet).not.toHaveBeenCalled();
  });

  it('returns 400 when the body is not JSON', async () => {
    expect((await postRuleSet(makeRequest(), ctx)).status).toBe(400);
  });

  it('returns 400 on a validation error from assertRuleSetPayload', async () => {
    const res = await postRuleSet(makeRequest({ body: { name: '', rules: [] } }), ctx);
    expect(res.status).toBe(400);
    expect(createRuleSet).not.toHaveBeenCalled();
  });

  it('creates a rule set and returns 201 + ETag header', async () => {
    createRuleSet.mockResolvedValueOnce(sampleSet);
    const res = await postRuleSet(
      makeRequest({ body: { name: 'Errors', rules: [sampleRule] } }),
      ctx
    );
    expect(res.status).toBe(201);
    expect(res.headers).toEqual({ ETag: '"1"' });
    expect(res.jsonBody).toEqual(sampleSet);
    expect(createRuleSet).toHaveBeenCalledWith('u-1', { name: 'Errors', rules: [sampleRule] });
  });

  it('returns 409 quota_exceeded when the user already has 20 sets', async () => {
    listRuleSetsByOwner.mockResolvedValueOnce(
      Array.from({ length: 20 }, (_, i) => ({ ...sampleSet, id: `rs-${i}` }))
    );
    const res = await postRuleSet(
      makeRequest({ body: { name: 'x', rules: [] } }),
      ctx
    );
    expect(res.status).toBe(409);
    const body = res.jsonBody as Record<string, unknown>;
    expect(body['code']).toBe('quota_exceeded');
    expect(createRuleSet).not.toHaveBeenCalled();
  });

  it('returns 500 when the create call fails unexpectedly', async () => {
    createRuleSet.mockRejectedValueOnce(new Error('boom'));
    const res = await postRuleSet(
      makeRequest({ body: { name: 'x', rules: [] } }),
      ctx
    );
    expect(res.status).toBe(500);
  });
});

describe('GET /api/rule-sets', () => {
  it('returns the caller rule sets', async () => {
    listRuleSetsByOwner.mockResolvedValueOnce([sampleSet]);
    const res = await listRuleSets(makeRequest(), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual([sampleSet]);
  });

  it('returns 401 when unauthenticated', async () => {
    requireAuth.mockRejectedValueOnce(new AuthError('Missing bearer token'));
    expect((await listRuleSets(makeRequest(), ctx)).status).toBe(401);
  });
});

describe('GET /api/rule-sets/:id', () => {
  it('returns 200 + ETag for the owner', async () => {
    findRuleSetById.mockResolvedValueOnce(sampleSet);
    const res = await getRuleSet(makeRequest({ params: { id: 'rs-1' } }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers).toEqual({ ETag: '"1"' });
    expect(res.jsonBody).toEqual(sampleSet);
  });

  it('returns 404 when the set does not exist', async () => {
    findRuleSetById.mockResolvedValueOnce(null);
    expect((await getRuleSet(makeRequest({ params: { id: 'rs-x' } }), ctx)).status).toBe(404);
  });

  it('returns 403 (not 404) when another user owns the set', async () => {
    findRuleSetById.mockResolvedValueOnce({ ...sampleSet, userId: 'someone-else' });
    const res = await getRuleSet(makeRequest({ params: { id: 'rs-1' } }), ctx);
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/rule-sets/:id', () => {
  it('rejects missing If-Match with 400', async () => {
    const res = await putRuleSet(
      makeRequest({ params: { id: 'rs-1' }, body: { name: 'x', rules: [] } }),
      ctx
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as Record<string, unknown>)['error']).toMatch(/If-Match/);
  });

  it('rejects weak If-Match validators', async () => {
    const res = await putRuleSet(
      makeRequest({
        params: { id: 'rs-1' },
        headers: { 'If-Match': 'W/"3"' },
        body: { name: 'x', rules: [] }
      }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  it('returns 412 when If-Match does not match stored version', async () => {
    findRuleSetById.mockResolvedValueOnce(sampleSet);
    const res = await putRuleSet(
      makeRequest({
        params: { id: 'rs-1' },
        headers: { 'If-Match': '"99"' },
        body: { name: 'Renamed', rules: [sampleRule] }
      }),
      ctx
    );
    expect(res.status).toBe(412);
    expect(replaceRuleSet).not.toHaveBeenCalled();
  });

  it('returns 412 when replaceRuleSet throws RuleSetVersionConflictError', async () => {
    findRuleSetById.mockResolvedValueOnce(sampleSet);
    replaceRuleSet.mockRejectedValueOnce(new RuleSetVersionConflictError('race'));
    const res = await putRuleSet(
      makeRequest({
        params: { id: 'rs-1' },
        headers: { 'If-Match': '"1"' },
        body: { name: 'Renamed', rules: [sampleRule] }
      }),
      ctx
    );
    expect(res.status).toBe(412);
  });

  it('returns 403 when the caller does not own the set', async () => {
    findRuleSetById.mockResolvedValueOnce({ ...sampleSet, userId: 'someone-else' });
    const res = await putRuleSet(
      makeRequest({
        params: { id: 'rs-1' },
        headers: { 'If-Match': '"1"' },
        body: { name: 'Renamed', rules: [sampleRule] }
      }),
      ctx
    );
    expect(res.status).toBe(403);
    expect(replaceRuleSet).not.toHaveBeenCalled();
  });

  it('returns 200 + bumped ETag on successful replace', async () => {
    findRuleSetById.mockResolvedValueOnce(sampleSet);
    replaceRuleSet.mockResolvedValueOnce({
      ...sampleSet,
      version: 2,
      name: 'Renamed',
      updatedAt: '2026-01-02T00:00:00Z'
    });
    const res = await putRuleSet(
      makeRequest({
        params: { id: 'rs-1' },
        headers: { 'If-Match': '"1"' },
        body: { name: 'Renamed', rules: [sampleRule] }
      }),
      ctx
    );
    expect(res.status).toBe(200);
    expect(res.headers).toEqual({ ETag: '"2"' });
    expect(replaceRuleSet).toHaveBeenCalledWith(sampleSet, { name: 'Renamed', rules: [sampleRule] }, 1);
  });

  it('returns 400 on RuleSetValidationError from the payload', async () => {
    const res = await putRuleSet(
      makeRequest({
        params: { id: 'rs-1' },
        headers: { 'If-Match': '"1"' },
        body: { name: '', rules: [] }
      }),
      ctx
    );
    expect(res.status).toBe(400);
    expect(findRuleSetById).not.toHaveBeenCalled();
  });

  it('translates RuleSetValidationError thrown post-load into 400', async () => {
    findRuleSetById.mockResolvedValueOnce(sampleSet);
    replaceRuleSet.mockRejectedValueOnce(new RuleSetValidationError('bad rule'));
    const res = await putRuleSet(
      makeRequest({
        params: { id: 'rs-1' },
        headers: { 'If-Match': '"1"' },
        body: { name: 'Renamed', rules: [sampleRule] }
      }),
      ctx
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/rule-sets/:id', () => {
  it('returns 404 when the set does not exist', async () => {
    readRuleSet.mockResolvedValueOnce(null);
    findRuleSetById.mockResolvedValueOnce(null);
    expect(
      (await deleteRuleSet(makeRequest({ params: { id: 'rs-x' } }), ctx)).status
    ).toBe(404);
  });

  it('returns 403 when another user owns the set', async () => {
    readRuleSet.mockResolvedValueOnce(null);
    findRuleSetById.mockResolvedValueOnce({ ...sampleSet, userId: 'someone-else' });
    const res = await deleteRuleSet(makeRequest({ params: { id: 'rs-1' } }), ctx);
    expect(res.status).toBe(403);
    expect(deleteRuleSetById).not.toHaveBeenCalled();
  });

  it('returns 204 on successful delete with no preference cleanup', async () => {
    readRuleSet.mockResolvedValueOnce(sampleSet);
    deleteRuleSetById.mockResolvedValueOnce(true);
    readUser.mockResolvedValueOnce({
      id: 'u-1',
      preferences: { defaultRuleSetIds: ['rs-other'] },
      createdAt: 't',
      updatedAt: 't'
    });
    const res = await deleteRuleSet(makeRequest({ params: { id: 'rs-1' } }), ctx);
    expect(res.status).toBe(204);
    expect(deleteRuleSetById).toHaveBeenCalledWith('rs-1', 'u-1');
    expect(upsertUser).not.toHaveBeenCalled();
  });

  it('strips the deleted ID from defaultRuleSetIds', async () => {
    readRuleSet.mockResolvedValueOnce(sampleSet);
    deleteRuleSetById.mockResolvedValueOnce(true);
    readUser.mockResolvedValueOnce({
      id: 'u-1',
      preferences: {
        defaultRuleSetIds: ['rs-other', 'rs-1', 'rs-also']
      },
      createdAt: 't',
      updatedAt: 't'
    });
    upsertUser.mockResolvedValueOnce({});
    await deleteRuleSet(makeRequest({ params: { id: 'rs-1' } }), ctx);
    const upserted = upsertUser.mock.calls[0]?.[0];
    expect(upserted.preferences.defaultRuleSetIds).toEqual(['rs-other', 'rs-also']);
  });

  it('migrates legacy activeRuleSetIds + defaultRuleSetId during delete cleanup', async () => {
    readRuleSet.mockResolvedValueOnce(sampleSet);
    deleteRuleSetById.mockResolvedValueOnce(true);
    readUser.mockResolvedValueOnce({
      id: 'u-1',
      preferences: {
        // Stored doc still has the legacy shape from before M6f-5.
        defaultRuleSetId: 'rs-1',
        activeRuleSetIds: ['rs-other', 'rs-1', 'rs-also']
      },
      createdAt: 't',
      updatedAt: 't'
    });
    upsertUser.mockResolvedValueOnce({});
    await deleteRuleSet(makeRequest({ params: { id: 'rs-1' } }), ctx);
    const upserted = upsertUser.mock.calls[0]?.[0];
    expect(upserted.preferences.defaultRuleSetIds).toEqual(['rs-other', 'rs-also']);
    expect(upserted.preferences.defaultRuleSetId).toBeUndefined();
    expect(upserted.preferences.activeRuleSetIds).toBeUndefined();
  });

  it('still returns 204 when preference cleanup throws', async () => {
    readRuleSet.mockResolvedValueOnce(sampleSet);
    deleteRuleSetById.mockResolvedValueOnce(true);
    readUser.mockRejectedValueOnce(new Error('cosmos hiccup'));
    const res = await deleteRuleSet(makeRequest({ params: { id: 'rs-1' } }), ctx);
    expect(res.status).toBe(204);
  });
});

describe('GET /api/rule-sets/:id when id="presets"', () => {
  it('short-circuits to 404 without a Cosmos lookup', async () => {
    const res = await getRuleSet(makeRequest({ params: { id: 'presets' } }), ctx);
    expect(res.status).toBe(404);
    expect(findRuleSetById).not.toHaveBeenCalled();
  });
});

describe('GET /api/rule-set-presets', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuth.mockRejectedValueOnce(new AuthError('Missing bearer token'));
    const res = await listPresets(makeRequest(), ctx);
    expect(res.status).toBe(401);
  });

  it('returns the preset catalog in the spec-defined order', async () => {
    const res = await listPresets(makeRequest(), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { id: string }[];
    expect(body.map((p) => p.id)).toEqual([
      'error-detection',
      'status-codes',
      'null-finder',
      'status-highlights'
    ]);
  });
});

describe('POST /api/rule-set-presets/:id/clone', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuth.mockRejectedValueOnce(new AuthError('Missing bearer token'));
    const res = await clonePreset(
      makeRequest({ params: { id: 'error-detection' } }),
      ctx
    );
    expect(res.status).toBe(401);
    expect(createRuleSet).not.toHaveBeenCalled();
  });

  it('returns 404 when the preset id is unknown', async () => {
    const res = await clonePreset(
      makeRequest({ params: { id: 'does-not-exist' } }),
      ctx
    );
    expect(res.status).toBe(404);
    expect(createRuleSet).not.toHaveBeenCalled();
  });

  it('clones the preset rules into a user-owned set with 201 + ETag', async () => {
    const preset = findPreset('null-finder')!;
    createRuleSet.mockResolvedValueOnce({
      ...sampleSet,
      id: 'rs-clone-1',
      name: preset.name,
      rules: preset.rules,
      version: 1
    });
    const res = await clonePreset(
      makeRequest({ params: { id: 'null-finder' } }),
      ctx
    );
    expect(res.status).toBe(201);
    expect(res.headers).toEqual({ ETag: '"1"' });
    expect(createRuleSet).toHaveBeenCalledTimes(1);
    const [userId, payload] = createRuleSet.mock.calls[0]!;
    expect(userId).toBe('u-1');
    expect(payload.name).toBe('Null Finder');
    expect(payload.rules).toHaveLength(1);
    expect(payload.rules[0].matchValue).toBe('null');
  });

  it('rejects clone with 409 when the user already has 20 sets', async () => {
    listRuleSetsByOwner.mockResolvedValueOnce(
      Array.from({ length: 20 }, (_, i) => ({ ...sampleSet, id: `rs-${i}` }))
    );
    const res = await clonePreset(
      makeRequest({ params: { id: 'error-detection' } }),
      ctx
    );
    expect(res.status).toBe(409);
    const body = res.jsonBody as Record<string, unknown>;
    expect(body['code']).toBe('quota_exceeded');
    expect(createRuleSet).not.toHaveBeenCalled();
  });

  it('hands the clone payload to createRuleSet (deep-cloned, mutation-safe)', async () => {
    createRuleSet.mockResolvedValueOnce({
      ...sampleSet,
      id: 'rs-clone-2',
      name: 'Error Detection',
      version: 1
    });
    await clonePreset(
      makeRequest({ params: { id: 'error-detection' } }),
      ctx
    );
    const [, payload] = createRuleSet.mock.calls[0]!;
    // mutating the cloned payload must not change the static preset
    payload.rules[0].matchValue = 'mutated';
    const preset = findPreset('error-detection')!;
    expect(preset.rules[0]!.matchValue).toBe('error');
  });

  it('returns 500 when createRuleSet itself fails', async () => {
    createRuleSet.mockRejectedValueOnce(new Error('cosmos down'));
    const res = await clonePreset(
      makeRequest({ params: { id: 'null-finder' } }),
      ctx
    );
    expect(res.status).toBe(500);
  });
});

describe('access.forbidden telemetry emission from rule-set handlers', () => {
  let mockTrackEvent: jest.Mock;

  beforeEach(() => {
    __resetTelemetryInitForTesting();
    mockTrackEvent = jest.fn();
    __setTelemetryClientForTestingT({ trackEvent: mockTrackEvent } as unknown as TelemetryClient);
  });

  afterEach(() => {
    __resetTelemetryInitForTesting();
    __setTelemetryClientForTestingT(null);
  });

  it('getRuleSet emits resource=ruleSet when the caller does not own the rule set', async () => {
    findRuleSetById.mockResolvedValueOnce({ ...sampleSet, userId: 'someone-else' });
    const res = await getRuleSet(makeRequest({ params: { id: 'rs-1' } }), ctx);
    expect(res.status).toBe(403);
    expect(mockTrackEvent).toHaveBeenCalledWith({
      name: 'access.forbidden',
      properties: { resource: 'ruleSet', authMode: 'required' },
      measurements: undefined
    });
  });

  it('deleteRuleSet emits resource=ruleSet when the caller does not own the rule set', async () => {
    readRuleSet.mockResolvedValueOnce(null);
    findRuleSetById.mockResolvedValueOnce({ ...sampleSet, userId: 'someone-else' });
    const res = await deleteRuleSet(makeRequest({ params: { id: 'rs-1' } }), ctx);
    expect(res.status).toBe(403);
    expect(mockTrackEvent).toHaveBeenCalledWith({
      name: 'access.forbidden',
      properties: { resource: 'ruleSet', authMode: 'required' },
      measurements: undefined
    });
  });
});
