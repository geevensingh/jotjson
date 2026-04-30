/**
 * /api/rule-sets - formatting rule-set CRUD endpoints (M6).
 *
 * POST   /api/rule-sets             -> create a new rule set; 201 + ETag
 * GET    /api/rule-sets             -> list caller's rule sets, sorted by createdAt
 * GET    /api/rule-sets/{id}        -> read one rule set; 200 + ETag, 403 if not owner
 * PUT    /api/rule-sets/{id}        -> full replace; requires `If-Match: <version>`,
 *                                       412 on mismatch, 403 if not owner
 * DELETE /api/rule-sets/{id}        -> remove the rule set + clean up the user's
 *                                       `defaultRuleSetIds` references;
 *                                       204, 403 if not owner
 *
 * Concurrency: each rule set carries an integer `version` field that is
 * surfaced to clients as a strong ETag and required via `If-Match` on
 * PUT. A mismatched `If-Match` returns 412 Precondition Failed (see
 * DESIGN_SPEC.md §Features 7, "Concurrency"). The client uses this to
 * detect cross-tab clobbering.
 *
 * Owner mismatch returns 403 (not 404) via the `forbidden()` helper
 * for parity with `blobs.ts`. We deliberately do NOT obscure the
 * existence of someone else's rule set - the URLs are server-issued
 * UUIDs and never user-discoverable.
 */
import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext
} from '@azure/functions';
import { AuthError, requireAuth } from '../shared/auth';
import {
  MAX_RULE_SETS_PER_USER,
  RuleSetValidationError,
  RuleSetVersionConflictError,
  assertRuleSetPayload,
  createRuleSet,
  deleteRuleSetById,
  findRuleSetById,
  listRuleSetsByOwner,
  readRuleSet,
  replaceRuleSet,
  type RuleSetDocument
} from '../shared/ruleSets';
import {
  findPreset,
  listPresets as listPresetsData,
  presetToCreatePayload
} from '../shared/ruleSetPresets';
import {
  badRequest,
  forbidden,
  internalError,
  notFound,
  unauthorized
} from '../shared/http';
import { readUser, upsertUser } from '../shared/users';

function preconditionFailed(message: string): HttpResponseInit {
  return { status: 412, jsonBody: { error: message } };
}

/**
 * Build a Cosmos response with the rule set's `version` echoed as a
 * strong ETag. Clients use the value as the `If-Match` header on
 * subsequent PUTs. We emit a strong validator (no `W/` prefix)
 * because the value identifies a specific bytewise revision of the
 * resource - any change to `name` or `rules` increments `version`.
 */
function withEtag(status: number, doc: RuleSetDocument): HttpResponseInit {
  return {
    status,
    headers: { ETag: `"${doc.version}"` },
    jsonBody: doc
  };
}

/**
 * Parse an `If-Match` request header into the integer version it
 * encodes. Accepts both quoted (`"3"`) and unquoted (`3`) forms;
 * rejects weak validators (`W/"3"`) since our resource semantics
 * mandate strong matches. Returns null when the header is absent or
 * malformed; the caller decides whether to 400 or 412.
 */
function parseIfMatch(headerValue: string | null | undefined): number | null {
  if (typeof headerValue !== 'string') return null;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0 || trimmed.startsWith('W/')) return null;
  const unquoted = trimmed.replace(/^"|"$/g, '');
  if (!/^\d+$/.test(unquoted)) return null;
  const value = Number.parseInt(unquoted, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export async function postRuleSet(
  req: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (error) {
    if (error instanceof AuthError) return unauthorized(error.message);
    return internalError(context, 'postRuleSet auth', error);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('Request body must be JSON');
  }

  let payload;
  try {
    payload = assertRuleSetPayload(body);
  } catch (error) {
    if (error instanceof RuleSetValidationError) return badRequest(error.message);
    return internalError(context, 'postRuleSet validate', error);
  }

  try {
    const existing = await listRuleSetsByOwner(principal.id);
    if (existing.length >= MAX_RULE_SETS_PER_USER) {
      return {
        status: 409,
        jsonBody: {
          error: `Rule set quota of ${MAX_RULE_SETS_PER_USER} reached. Delete an existing set and try again.`,
          code: 'quota_exceeded'
        }
      };
    }
    const created = await createRuleSet(principal.id, payload);
    return withEtag(201, created);
  } catch (error) {
    if (error instanceof RuleSetValidationError) return badRequest(error.message);
    return internalError(context, 'postRuleSet write', error);
  }
}

export async function listRuleSets(
  req: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (error) {
    if (error instanceof AuthError) return unauthorized(error.message);
    return internalError(context, 'listRuleSets auth', error);
  }
  try {
    const items = await listRuleSetsByOwner(principal.id);
    return { status: 200, jsonBody: items };
  } catch (error) {
    return internalError(context, 'listRuleSets read', error);
  }
}

export async function getRuleSet(
  req: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (error) {
    if (error instanceof AuthError) return unauthorized(error.message);
    return internalError(context, 'getRuleSet auth', error);
  }

  const id = req.params['id'] ?? '';
  if (!id) return badRequest('Missing id path parameter');
  // Defense-in-depth: the literal `presets` route is registered on
  // its own handler, but if the framework's router ever falls back
  // to the {id} pattern for `/api/rule-sets/presets`, we'd surface
  // the literal as a Cosmos lookup. Short-circuit to 404 - no user
  // rule set has the reserved kebab-case id `presets`.
  if (id === 'presets') return notFound('Rule set not found');

  try {
    // Cross-partition lookup so we can distinguish "doesn't exist"
    // from "exists but you're not the owner". The latter must return
    // 403 per the spec.
    const found = await findRuleSetById(id);
    if (!found) return notFound('Rule set not found');
    if (found.userId !== principal.id) {
      return forbidden('You do not own this rule set');
    }
    return withEtag(200, found);
  } catch (error) {
    return internalError(context, 'getRuleSet read', error);
  }
}

export async function putRuleSet(
  req: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (error) {
    if (error instanceof AuthError) return unauthorized(error.message);
    return internalError(context, 'putRuleSet auth', error);
  }

  const id = req.params['id'] ?? '';
  if (!id) return badRequest('Missing id path parameter');

  const expectedVersion = parseIfMatch(req.headers.get('If-Match'));
  if (expectedVersion === null) {
    return badRequest('PUT requires a valid If-Match header carrying the rule set version');
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('Request body must be JSON');
  }
  let payload;
  try {
    payload = assertRuleSetPayload(body);
  } catch (error) {
    if (error instanceof RuleSetValidationError) return badRequest(error.message);
    return internalError(context, 'putRuleSet validate', error);
  }

  try {
    const found = await findRuleSetById(id);
    if (!found) return notFound('Rule set not found');
    if (found.userId !== principal.id) {
      return forbidden('You do not own this rule set');
    }
    if (found.version !== expectedVersion) {
      return preconditionFailed(
        `Rule set was modified by another writer (expected version ${expectedVersion}, found ${found.version})`
      );
    }
    const next = await replaceRuleSet(found, payload, expectedVersion);
    return withEtag(200, next);
  } catch (error) {
    if (error instanceof RuleSetValidationError) return badRequest(error.message);
    if (error instanceof RuleSetVersionConflictError) {
      // Race: someone else replaced the doc between our read and write.
      return preconditionFailed(error.message);
    }
    return internalError(context, 'putRuleSet write', error);
  }
}

export async function deleteRuleSet(
  req: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (error) {
    if (error instanceof AuthError) return unauthorized(error.message);
    return internalError(context, 'deleteRuleSet auth', error);
  }

  const id = req.params['id'] ?? '';
  if (!id) return badRequest('Missing id path parameter');

  try {
    // Use the partitioned read first so we don't pay cross-partition RU
    // for the common owner-deletes-own-set path. Only fall back to the
    // cross-partition lookup if the owner-scoped read returns nothing
    // (could be missing, or could be in someone else's partition).
    let found = await readRuleSet(id, principal.id);
    if (!found) {
      const cross = await findRuleSetById(id);
      if (!cross) return notFound('Rule set not found');
      if (cross.userId !== principal.id) {
        return forbidden('You do not own this rule set');
      }
      found = cross;
    }

    const removed = await deleteRuleSetById(found.id, found.userId);
    if (!removed) return notFound('Rule set not found');

    // Best-effort cleanup of the user's preference references. A
    // failure here must not roll back the delete - the rule set is
    // already gone, and a stale id in `defaultRuleSetIds` is harmless
    // because the frontend filters unknown IDs at read time. We log
    // and move on.
    try {
      await cleanupUserReferences(principal.id, found.id);
    } catch (error) {
      context.warn('deleteRuleSet cleanup failed', error);
    }

    return { status: 204 };
  } catch (error) {
    return internalError(context, 'deleteRuleSet write', error);
  }
}

/**
 * Strip references to the deleted rule set from the owner's user
 * document. Filters the deleted ID out of `defaultRuleSetIds`.
 * Performs a single upsert when (and only when) the array actually
 * changes - we don't churn `updatedAt` for users who never
 * referenced the set.
 */
async function cleanupUserReferences(userId: string, deletedSetId: string): Promise<void> {
  const user = await readUser(userId);
  if (!user) return;
  const prefs = user.preferences as
    | (typeof user.preferences & {
        defaultRuleSetIds?: string[];
        // Legacy keys may still appear on stored docs that haven't
        // been re-saved since M6f-5. Mirror the migration logic from
        // normalizeStoredPreferences here so cleanup can run before
        // the next read-then-write cycle.
        activeRuleSetIds?: string[];
        defaultRuleSetId?: string;
      })
    | undefined;
  if (!prefs) return;

  const sourceArray = Array.isArray(prefs.defaultRuleSetIds)
    ? prefs.defaultRuleSetIds
    : Array.isArray(prefs.activeRuleSetIds)
      ? prefs.activeRuleSetIds
      : [];
  if (!sourceArray.includes(deletedSetId)) return;

  const nextPrefs = { ...prefs };
  nextPrefs.defaultRuleSetIds = sourceArray.filter((id) => id !== deletedSetId);
  delete (nextPrefs as { activeRuleSetIds?: string[] }).activeRuleSetIds;
  delete (nextPrefs as { defaultRuleSetId?: string }).defaultRuleSetId;

  await upsertUser({
    ...user,
    preferences: nextPrefs,
    updatedAt: new Date().toISOString()
  });
}

/**
 * `GET /api/rule-set-presets`
 *
 * Returns the static preset list. Auth-required because the whole
 * formatting-rules feature is registered-user-only (see the API
 * table in DESIGN_SPEC.md and the route guard from M6a.75) - we
 * keep the same posture so the endpoint isn't useful for
 * unauthenticated reconnaissance of the catalog.
 */
export async function listPresets(
  req: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    await requireAuth(req);
  } catch (error) {
    if (error instanceof AuthError) return unauthorized(error.message);
    return internalError(context, 'listPresets auth', error);
  }
  return { status: 200, jsonBody: listPresetsData() };
}

/**
 * `POST /api/rule-set-presets/:id/clone`
 *
 * Creates a user-owned copy of the named preset and returns the
 * new rule set with an `ETag` header (same shape as POST
 * /api/rule-sets). Reuses the per-user quota path so cloning
 * counts against `MAX_RULE_SETS_PER_USER` exactly like a
 * hand-built rule set.
 *
 * Returns 404 for unknown preset IDs (not 400) - the spec lists
 * preset IDs as path resources, so an unknown one is logically
 * "not found" rather than a malformed request.
 */
export async function clonePreset(
  req: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (error) {
    if (error instanceof AuthError) return unauthorized(error.message);
    return internalError(context, 'clonePreset auth', error);
  }

  const presetId = req.params['id'] ?? '';
  if (!presetId) return badRequest('Missing preset id path parameter');

  const preset = findPreset(presetId);
  if (!preset) return notFound('Preset not found');

  try {
    const existing = await listRuleSetsByOwner(principal.id);
    if (existing.length >= MAX_RULE_SETS_PER_USER) {
      return {
        status: 409,
        jsonBody: {
          error: `Rule set quota of ${MAX_RULE_SETS_PER_USER} reached. Delete an existing set and try again.`,
          code: 'quota_exceeded'
        }
      };
    }
    const payload = presetToCreatePayload(preset);
    const created = await createRuleSet(principal.id, payload);
    return withEtag(201, created);
  } catch (error) {
    if (error instanceof RuleSetValidationError) {
      // A preset that doesn't pass validation is a deployment bug,
      // not a user error - log and surface a 500 so we notice. The
      // ruleSetPresets.test.ts suite asserts every preset rule is
      // valid, so this branch should be unreachable in practice.
      return internalError(context, 'clonePreset preset invalid', error);
    }
    return internalError(context, 'clonePreset write', error);
  }
}

app.http('rule-sets-post', {
  methods: ['POST'],
  route: 'rule-sets',
  authLevel: 'anonymous',
  handler: postRuleSet
});

app.http('rule-sets-presets-list', {
  methods: ['GET'],
  // Registered under a separate top-level segment (`rule-set-presets`)
  // because the Azure Functions Node.js v4 router resolves
  // `/api/rule-sets/presets` to the parameterized `/rule-sets/{id}`
  // handler in registration order, even when a more-specific literal
  // route is registered. Confirmed in production: requests to
  // `/api/rule-sets/presets` were dispatched to `getRuleSet` and
  // short-circuited to 404. Using a non-conflicting path is the
  // simplest fix; the defensive 404 in `getRuleSet` for
  // `id === 'presets'` is retained to keep the behavior stable for
  // any client still hitting the old path.
  route: 'rule-set-presets',
  authLevel: 'anonymous',
  handler: listPresets
});

app.http('rule-sets-presets-clone', {
  methods: ['POST'],
  route: 'rule-set-presets/{id}/clone',
  authLevel: 'anonymous',
  handler: clonePreset
});

app.http('rule-sets-list', {
  methods: ['GET'],
  route: 'rule-sets',
  authLevel: 'anonymous',
  handler: listRuleSets
});

app.http('rule-sets-get', {
  methods: ['GET'],
  route: 'rule-sets/{id}',
  authLevel: 'anonymous',
  handler: getRuleSet
});

app.http('rule-sets-put', {
  methods: ['PUT'],
  route: 'rule-sets/{id}',
  authLevel: 'anonymous',
  handler: putRuleSet
});

app.http('rule-sets-delete', {
  methods: ['DELETE'],
  route: 'rule-sets/{id}',
  authLevel: 'anonymous',
  handler: deleteRuleSet
});
