/**
 * /api/history - signed-in user's blob activity timeline.
 *
 * GET    /api/history?continuationToken=...&pageSize=...
 *   Returns the caller's history entries newest-first.
 *   Response: { entries: HistoryEntry[], continuationToken?: string }
 *
 * DELETE /api/history
 *   Deletes every history entry for the caller. Returns 204.
 *
 * POST   /api/history
 *   Body: { action: "pasted", slug?: string, title?: string }
 *   Records a `"pasted"` entry. Server enforces a per-user
 *   PASTE_DEBOUNCE_SECONDS window: rapid repeats return 204 with no
 *   side effects so clients can fire-and-forget without bookkeeping.
 *   First write returns 201 with the new entry.
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
  HISTORY_ACTIONS,
  PASTE_DEBOUNCE_SECONDS,
  type HistoryAction,
  clearAll,
  getRecentPasteAt,
  listEntries,
  recordEntry
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
  err: unknown
): HttpResponseInit {
  context.error(`${where} error`, err);
  return { status: 500, jsonBody: { error: 'Internal error' } };
}

export async function getHistory(
  req: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message);
    return internalError(context, 'getHistory auth', err);
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
  let actions: HistoryAction[] | undefined;
  if (actionsRaw !== null && actionsRaw !== undefined) {
    const parts = actionsRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const part of parts) {
      if (!HISTORY_ACTIONS.has(part as HistoryAction)) {
        return badRequest(
          `actions contains an unknown value: ${part}`
        );
      }
    }
    const dedup = Array.from(new Set(parts)) as HistoryAction[];
    if (dedup.length > 0) actions = dedup;
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
      ...(actions !== undefined ? { actions } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {})
    });
    return { status: 200, jsonBody: result };
  } catch (err) {
    return internalError(context, 'getHistory read', err);
  }
}

export async function deleteHistory(
  req: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message);
    return internalError(context, 'deleteHistory auth', err);
  }

  try {
    await clearAll(principal.id);
    return { status: 204 };
  } catch (err) {
    return internalError(context, 'deleteHistory write', err);
  }
}

export async function postHistory(
  req: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message);
    return internalError(context, 'postHistory auth', err);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('Request body must be JSON');
  }
  if (!body || typeof body !== 'object') {
    return badRequest('Request body must be an object');
  }
  const payload = body as { action?: unknown; slug?: unknown; title?: unknown };
  // For now POST only accepts action="pasted". Other actions are produced
  // server-side from the blob endpoints; rejecting them here keeps the
  // surface narrow until M5b/later milestones expand it.
  if (payload.action !== 'pasted') {
    return badRequest('action must be "pasted"');
  }
  if (payload.slug !== undefined && typeof payload.slug !== 'string') {
    return badRequest('slug must be a string when provided');
  }
  if (payload.title !== undefined && typeof payload.title !== 'string') {
    return badRequest('title must be a string when provided');
  }

  try {
    const recent = await getRecentPasteAt(principal.id);
    if (recent) {
      const ageMs = Date.now() - new Date(recent).getTime();
      if (Number.isFinite(ageMs) && ageMs < PASTE_DEBOUNCE_SECONDS * 1000) {
        // Silently no-op: clients call this on every paste; debouncing
        // server-side keeps the timeline clean without forcing every
        // caller to track its own throttle.
        return { status: 204 };
      }
    }
    const saved = await recordEntry({
      userId: principal.id,
      action: 'pasted',
      ...(typeof payload.slug === 'string' ? { slug: payload.slug } : {}),
      ...(typeof payload.title === 'string' ? { title: payload.title } : {})
    });
    return { status: 201, jsonBody: saved };
  } catch (err) {
    return internalError(context, 'postHistory write', err);
  }
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
