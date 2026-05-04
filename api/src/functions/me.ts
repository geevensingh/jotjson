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
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { AuthError, requireAuth } from '../shared/auth';
import { badRequest, internalError, unauthorized } from '../shared/http';
import {
  PreferenceValidationError,
  normalizePreferences,
  normalizeStoredPreferences,
} from '../shared/preferences';
import { readUser, upsertUser, UserDocument } from '../shared/users';

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
    return { status: 200, jsonBody: normalized };
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
    updatedAt: now,
  };

  try {
    const saved = await upsertUser(doc);
    return { status: 201, jsonBody: saved };
  } catch (error) {
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
        updatedAt: now,
      };

  try {
    const saved = await upsertUser(doc);
    return { status: 200, jsonBody: saved.preferences };
  } catch (error) {
    return internalError(context, 'putMePreferences write', error);
  }
}

app.http('me-get', {
  methods: ['GET'],
  route: 'me',
  authLevel: 'anonymous',
  handler: getMe,
});

app.http('me-post', {
  methods: ['POST'],
  route: 'me',
  authLevel: 'anonymous',
  handler: postMe,
});

app.http('me-preferences-put', {
  methods: ['PUT'],
  route: 'me/preferences',
  authLevel: 'anonymous',
  handler: putMePreferences,
});
