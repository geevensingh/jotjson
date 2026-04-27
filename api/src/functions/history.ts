/**
 * /api/history - signed-in user's "Recently viewed" timeline.
 *
 * GET    /api/history?continuationToken=...&pageSize=...&q=...&from=...&to=...
 *   Returns the caller's `viewed` history entries newest-first.
 *   Response: { entries: HistoryEntry[], continuationToken?: string }
 *
 * DELETE /api/history
 *   Deletes every history entry for the caller. Returns 204.
 *
 * POST   /api/history
 *   Legacy no-op kept for one release of stale-client tolerance. Always
 *   returns 204 once auth is validated. TODO(remove next release).
 *
 * All routes require auth.
 */
import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext
} from '@azure/functions';
import { AuthError, requireAuth } from '../shared/auth';
import {
  clearAll,
  listEntries
} from '../shared/history';

function unauthorized(message: string): HttpResponseInit {
  return { status: 401, jsonBody: { error: message } };
}

function badRequest(message: string): HttpResponseInit {
  return { status: 400, jsonBody: { error: message } };
}

function isIsoTimestamp(value: string): boolean {
  // Require a full ISO 8601 date-time so that we don't silently accept
  // bare dates (which Cosmos would compare lexicographically as e.g.
  // '2024-01-01' < '2024-01-01T00:00:00Z'). The `T` separator and a
  // numeric timezone or `Z` are mandatory.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    return false;
  }
  const t = Date.parse(value);
  return Number.isFinite(t);
}

function internalError(
  context: InvocationContext,
  where: string,
  error: unknown
): HttpResponseInit {
  context.error(`${where} error`, error);
  return { status: 500, jsonBody: { error: 'Internal error' } };
}

export async function getHistory(
  req: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (error) {
    if (error instanceof AuthError) return unauthorized(error.message);
    return internalError(context, 'getHistory auth', error);
  }

  // pageSize is clamped inside listEntries; we pass the raw integer when
  // valid and let the accessor enforce min/max bounds.
  const pageSizeRaw = req.query.get('pageSize');
  const pageSize = pageSizeRaw ? Number.parseInt(pageSizeRaw, 10) : undefined;
  if (pageSizeRaw !== null && pageSizeRaw !== undefined && !Number.isFinite(pageSize)) {
    return badRequest('pageSize must be an integer');
  }
  const continuationToken = req.query.get('continuationToken') ?? undefined;
  const qRaw = req.query.get('q');
  let q: string | undefined;
  if (qRaw !== null && qRaw !== undefined) {
    const trimmed = qRaw.trim();
    if (trimmed.length === 0) {
      q = undefined;
    } else if (trimmed.length > 100) {
      return badRequest('q must be 100 characters or fewer');
    } else {
      q = trimmed;
    }
  }
  const actionsRaw = req.query.get('actions');
  if (actionsRaw !== null && actionsRaw !== undefined && actionsRaw.length > 0) {
    // Legacy `actions` filter accepted on the wire but ignored. The v1
    // narrowing collapsed history to a single action ("viewed"), so the
    // filter has no effect. TODO(remove next release): drop this stub
    // once stale clients have refreshed.
  }
  const fromRaw = req.query.get('from');
  let from: string | undefined;
  if (fromRaw !== null && fromRaw !== undefined && fromRaw.length > 0) {
    if (!isIsoTimestamp(fromRaw)) {
      return badRequest('from must be a valid ISO 8601 timestamp');
    }
    from = fromRaw;
  }
  const toRaw = req.query.get('to');
  let to: string | undefined;
  if (toRaw !== null && toRaw !== undefined && toRaw.length > 0) {
    if (!isIsoTimestamp(toRaw)) {
      return badRequest('to must be a valid ISO 8601 timestamp');
    }
    to = toRaw;
  }
  if (from !== undefined && to !== undefined && from > to) {
    return badRequest('from must be on or before to');
  }

  try {
    const result = await listEntries(principal.id, {
      ...(pageSize !== undefined ? { pageSize } : {}),
      ...(continuationToken ? { continuationToken } : {}),
      ...(q !== undefined ? { q } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {})
    });
    return { status: 200, jsonBody: result };
  } catch (error) {
    return internalError(context, 'getHistory read', error);
  }
}

export async function deleteHistory(
  req: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (error) {
    if (error instanceof AuthError) return unauthorized(error.message);
    return internalError(context, 'deleteHistory auth', error);
  }

  try {
    await clearAll(principal.id);
    return { status: 204 };
  } catch (error) {
    return internalError(context, 'deleteHistory write', error);
  }
}

/**
 * Legacy paste-recording endpoint. Kept as a no-op for one release of
 * stale-client tolerance: an SPA cached before the v1 narrowing will
 * still call this on every paste, and we want those calls to succeed
 * silently (no 404s in the user's network panel) rather than fail
 * loudly. Auth is still validated so we don't accept unauthenticated
 * traffic at this surface.
 *
 * TODO(remove next release): delete this handler and its registration
 * once stale clients have refreshed.
 */
export async function postHistory(
  req: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    await requireAuth(req);
  } catch (error) {
    if (error instanceof AuthError) return unauthorized(error.message);
    return internalError(context, 'postHistory auth', error);
  }
  return { status: 204 };
}

app.http('history-get', {
  methods: ['GET'],
  route: 'history',
  authLevel: 'anonymous',
  handler: getHistory
});

app.http('history-delete', {
  methods: ['DELETE'],
  route: 'history',
  authLevel: 'anonymous',
  handler: deleteHistory
});

app.http('history-post', {
  methods: ['POST'],
  route: 'history',
  authLevel: 'anonymous',
  handler: postHistory
});
