/**
 * /api/me - authenticated user endpoints.
 *
 * GET  /api/me                    -> read the current user document
 *                                   200 with doc, or 404 if not yet seeded
 * POST /api/me                    -> first-time seed: create a user document
 *                                   with preferences taken from the request
 *                                   body (typically the anon user's local
 *                                   prefs). Idempotent - returns 409 if the
 *                                   document already exists.
 * PUT  /api/me/preferences        -> replace the full preferences object
 *                                   with a validated + normalized copy.
 *                                   Returns the normalized preferences.
 *
 * The design is deliberately GET-doesn't-upsert: clients that render
 * anonymously must not implicitly mutate the database on load. The
 * frontend explicitly calls POST /api/me only when it wants to seed.
 */
import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext
} from '@azure/functions';
import { AuthError, requireAuth } from '../shared/auth';
import {
  PreferenceValidationError,
  normalizePreferences,
  normalizeStoredPreferences
} from '../shared/preferences';
import { readUser, upsertUser, UserDocument } from '../shared/users';

function unauthorized(message: string): HttpResponseInit {
  return { status: 401, jsonBody: { error: message } };
}

function badRequest(message: string): HttpResponseInit {
  return { status: 400, jsonBody: { error: message } };
}

export async function getMe(
  req: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message);
    context.error('getMe auth error', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }

  try {
    const doc = await readUser(principal.id);
    if (!doc) return { status: 404, jsonBody: { error: 'User not seeded' } };
    // Coerce any legacy `historyTrackingMode` field into the new
    // `recentlyViewedEnabled` boolean so clients never see the old
    // shape. TODO(remove next release): no longer needed once all
    // stored docs have been re-saved.
    const normalized: UserDocument = {
      ...doc,
      preferences: normalizeStoredPreferences(doc.preferences)
    };
    return { status: 200, jsonBody: normalized };
  } catch (err) {
    context.error('getMe read error', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

export async function postMe(
  req: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message);
    context.error('postMe auth error', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
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
  } catch (err) {
    if (err instanceof PreferenceValidationError) return badRequest(err.message);
    throw err;
  }

  const existing = await readUser(principal.id);
  if (existing) {
    return { status: 409, jsonBody: { error: 'User already exists', user: existing } };
  }

  const now = new Date().toISOString();
  const doc: UserDocument = {
    id: principal.id,
    displayName: principal.displayName,
    email: principal.email,
    preferences,
    createdAt: now,
    updatedAt: now
  };

  try {
    const saved = await upsertUser(doc);
    return { status: 201, jsonBody: saved };
  } catch (err) {
    context.error('postMe write error', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

export async function putMePreferences(
  req: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message);
    context.error('putMePreferences auth error', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
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
  } catch (err) {
    if (err instanceof PreferenceValidationError) return badRequest(err.message);
    throw err;
  }

  const now = new Date().toISOString();
  const existing = await readUser(principal.id);
  const doc: UserDocument = existing
    ? { ...existing, preferences, updatedAt: now }
    : {
        id: principal.id,
        displayName: principal.displayName,
        email: principal.email,
        preferences,
        createdAt: now,
        updatedAt: now
      };

  try {
    const saved = await upsertUser(doc);
    return { status: 200, jsonBody: saved.preferences };
  } catch (err) {
    context.error('putMePreferences write error', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('me-get', {
  methods: ['GET'],
  route: 'me',
  authLevel: 'anonymous',
  handler: getMe
});

app.http('me-post', {
  methods: ['POST'],
  route: 'me',
  authLevel: 'anonymous',
  handler: postMe
});

app.http('me-preferences-put', {
  methods: ['PUT'],
  route: 'me/preferences',
  authLevel: 'anonymous',
  handler: putMePreferences
});
