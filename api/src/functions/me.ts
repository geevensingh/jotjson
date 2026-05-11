/**
 * /api/me - authenticated user endpoints.
 *
 * GET  /api/me                    -> read the current user document
 *                                   200 with doc + ETag, or 404 if not yet seeded.
 * POST /api/me                    -> first-time seed: create a user document
 *                                   with preferences taken from the request
 *                                   body (typically the anon user's local
 *                                   prefs). Idempotent - returns 409 if the
 *                                   document already exists. Response carries
 *                                   `ETag` so the client can immediately
 *                                   PUT /preferences without an extra round
 *                                   trip.
 * PUT  /api/me/preferences        -> replace the full preferences object
 *                                   with a validated + normalized copy.
 *                                   Requires a valid `If-Match: <version>`
 *                                   header; 412 on mismatch, 404 if the user
 *                                   has not yet been seeded (clients must
 *                                   POST /api/me first). Returns the
 *                                   normalized preferences with `ETag`.
 *
 * The design is deliberately GET-doesn't-upsert: clients that render
 * anonymously must not implicitly mutate the database on load. The
 * frontend explicitly calls POST /api/me only when it wants to seed.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { AuthError, requireAuth } from '../shared/auth';
import { stripCosmosMetadata, VersionConflictError } from '../shared/cosmos';
import { badRequest, internalError, unauthorized, withSecurityHeaders } from '../shared/http';
import {
  normalizePreferences,
  normalizeStoredPreferences,
  PreferenceValidationError,
} from '../shared/preferences';
import {
  createUser,
  readUser,
  replaceUser,
  UserAlreadyExistsError,
  UserDocument,
} from '../shared/users';

function preconditionFailed(message: string): HttpResponseInit {
  return { status: 412, jsonBody: { error: message } };
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

function withEtag<T>(status: number, version: number, jsonBody: T): HttpResponseInit {
  return { status, headers: { ETag: `"${version}"` }, jsonBody };
}

export async function getMe(
  req: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (error) {
    if (error instanceof AuthError) return unauthorized(error.message);
    return internalError(context, 'getMe auth', error);
  }

  try {
    const doc = await readUser(principal.id);
    if (!doc) return { status: 404, jsonBody: { error: 'User not seeded' } };
    const normalized: UserDocument = {
      ...doc,
      preferences: normalizeStoredPreferences(doc.preferences),
    };
    return withEtag(200, normalized.version, stripCosmosMetadata(normalized));
  } catch (error) {
    return internalError(context, 'getMe read', error);
  }
}

export async function postMe(
  req: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (error) {
    if (error instanceof AuthError) return unauthorized(error.message);
    return internalError(context, 'postMe auth', error);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('Request body must be JSON');
  }

  const payload = body as { preferences?: unknown } | null;
  if (!payload || typeof payload !== 'object') {
    return badRequest('Request body must be an object with "preferences"');
  }

  let preferences;
  try {
    preferences = normalizePreferences(payload.preferences);
  } catch (error) {
    if (error instanceof PreferenceValidationError) return badRequest(error.message);
    throw error;
  }

  // Pre-flight read so the common "already seeded" path returns 409
  // without spending a Cosmos write attempt. The post-create branch
  // below still handles the cross-tab race where two POSTs both pass
  // the pre-flight check.
  const preExisting = await readUser(principal.id);
  if (preExisting) {
    return withEtag(409, preExisting.version, {
      error: 'User already exists',
      user: stripCosmosMetadata(preExisting),
    });
  }

  const now = new Date().toISOString();
  const doc: UserDocument = {
    id: principal.id,
    displayName: principal.displayName,
    email: principal.email,
    preferences,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const saved = await createUser(doc);
    return withEtag(201, saved.version, stripCosmosMetadata(saved));
  } catch (error) {
    if (error instanceof UserAlreadyExistsError) {
      // Race: another POST created the doc between our preExisting
      // read and the create attempt. Re-read so the 409 body still
      // carries the winning doc.
      const racy = await readUser(principal.id);
      if (racy) {
        return withEtag(409, racy.version, {
          error: 'User already exists',
          user: stripCosmosMetadata(racy),
        });
      }
      return internalError(context, 'postMe race', error);
    }
    return internalError(context, 'postMe write', error);
  }
}

export async function putMePreferences(
  req: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (error) {
    if (error instanceof AuthError) return unauthorized(error.message);
    return internalError(context, 'putMePreferences auth', error);
  }

  const expectedVersion = parseIfMatch(req.headers.get('If-Match'));
  if (expectedVersion === null) {
    return badRequest('PUT requires a valid If-Match header carrying the user version');
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('Request body must be JSON');
  }

  let preferences;
  try {
    preferences = normalizePreferences(body);
  } catch (error) {
    if (error instanceof PreferenceValidationError) return badRequest(error.message);
    throw error;
  }

  const existing = await readUser(principal.id);
  if (!existing) {
    return { status: 404, jsonBody: { error: 'User not seeded' } };
  }
  if (existing.version !== expectedVersion) {
    return preconditionFailed(
      `User was modified by another writer (expected version ${expectedVersion}, found ${existing.version})`,
    );
  }

  try {
    const updated = await replaceUser(existing, (draft) => {
      draft.preferences = preferences;
      draft.updatedAt = new Date().toISOString();
    });
    return withEtag(200, updated.version, updated.preferences);
  } catch (error) {
    if (error instanceof VersionConflictError) {
      return preconditionFailed(error.message);
    }
    return internalError(context, 'putMePreferences write', error);
  }
}

app.http('me-get', {
  methods: ['GET'],
  route: 'me',
  authLevel: 'anonymous',
  handler: withSecurityHeaders(getMe),
});

app.http('me-post', {
  methods: ['POST'],
  route: 'me',
  authLevel: 'anonymous',
  handler: withSecurityHeaders(postMe),
});

app.http('me-preferences-put', {
  methods: ['PUT'],
  route: 'me/preferences',
  authLevel: 'anonymous',
  handler: withSecurityHeaders(putMePreferences),
});
