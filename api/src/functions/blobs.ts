/**
 * /api/blobs - JSON blob CRUD endpoints.
 *
 * POST   /api/blobs                -> create a new blob owned by the caller
 * GET    /api/blobs                -> list the caller's blobs (auth required)
 * GET    /api/blobs/{idOrSlug}     -> read any blob by UUID id or NanoID slug
 *                                     (auth optional - private/unlisted blobs
 *                                     are viewable by anyone with the link)
 * PUT    /api/blobs/{id}           -> update an owned blob in place
 * DELETE /api/blobs/{id}           -> delete an owned blob
 *
 * POST also enforces the 100-blob-per-user quota:
 *   - "auto_fifo" strategy (default): silently deletes the caller's oldest
 *     blob and includes `autoDeleted: { id, slug, title? }` on the response.
 *   - "manual" strategy: returns 409 with `code: "quota_exceeded"`.
 */
import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext
} from '@azure/functions';
import { AuthError, requireAuth, tryAuth } from '../shared/auth';
import {
  BlobValidationError,
  MAX_BLOBS_PER_USER,
  SlugGenerationError,
  createBlob,
  deleteBlobById,
  findBlobByIdOrSlug,
  listBlobsByOwner,
  updateBlob
} from '../shared/blobs';
import { recordEntry, type HistoryAction } from '../shared/history';
import { readUser } from '../shared/users';

function unauthorized(message: string): HttpResponseInit {
  return { status: 401, jsonBody: { error: message } };
}

function badRequest(message: string): HttpResponseInit {
  return { status: 400, jsonBody: { error: message } };
}

function notFound(message: string): HttpResponseInit {
  return { status: 404, jsonBody: { error: message } };
}

function forbidden(message: string): HttpResponseInit {
  return { status: 403, jsonBody: { error: message } };
}

function internalError(
  context: InvocationContext,
  where: string,
  err: unknown
): HttpResponseInit {
  context.error(`${where} error`, err);
  return { status: 500, jsonBody: { error: 'Internal error' } };
}

/**
 * Best-effort fire-and-forget history write. History tracking is a
 * bookkeeping concern; a Cosmos hiccup writing to the `history` container
 * must never fail the parent blob mutation. We await the write so test
 * doubles can assert it happened, but every failure is swallowed with a
 * warning.
 */
async function recordHistorySafely(
  context: InvocationContext,
  input: {
    userId: string;
    action: HistoryAction;
    blobId?: string;
    slug?: string;
    title?: string;
  }
): Promise<void> {
  try {
    await recordEntry(input);
  } catch (err) {
    context.warn('history record failed', { action: input.action, error: err });
  }
}

/**
 * Look up the caller's `historyTrackingMode` preference. Defaults to
 * `"save_only"` when the user document or preference is missing - matches
 * `DEFAULT_PREFERENCES` in shared/preferences.ts. Errors reading the user
 * doc fall through as `"save_only"` so a transient Cosmos error never
 * accidentally upgrades a user to `"all_actions"` tracking.
 */
async function readHistoryMode(
  context: InvocationContext,
  userId: string
): Promise<'save_only' | 'all_actions'> {
  try {
    const user = await readUser(userId);
    return user?.preferences?.historyTrackingMode ?? 'save_only';
  } catch (err) {
    context.warn('history pref read failed', err);
    return 'save_only';
  }
}

export async function postBlob(
  req: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message);
    return internalError(context, 'postBlob auth', err);
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
  const payload = body as { content?: unknown; title?: unknown; isPublic?: unknown };

  let autoDeleted: { id: string; slug: string; title?: string } | undefined;
  try {
    const existing = await listBlobsByOwner(principal.id);
    if (existing.length >= MAX_BLOBS_PER_USER) {
      const userDoc = await readUser(principal.id);
      const strategy = userDoc?.preferences?.blobQuotaStrategy ?? 'auto_fifo';
      if (strategy === 'manual') {
        return {
          status: 409,
          jsonBody: {
            error: `Blob quota of ${MAX_BLOBS_PER_USER} reached. Delete an existing blob and try again.`,
            code: 'quota_exceeded'
          }
        };
      }
      // auto_fifo: drop the oldest blob (by updatedAt, then createdAt as
      // tiebreaker - matches DESIGN_SPEC §Constraints).
      const oldest = [...existing].sort((a, b) => {
        if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
        return a.createdAt < b.createdAt ? -1 : 1;
      })[0]!;
      const removed = await deleteBlobById(oldest.id, oldest.ownerId);
      if (removed) {
        autoDeleted = {
          id: oldest.id,
          slug: oldest.slug,
          ...(oldest.title ? { title: oldest.title } : {})
        };
      }
    }
  } catch (err) {
    return internalError(context, 'postBlob quota', err);
  }

  try {
    const saved = await createBlob(principal.id, {
      content: payload.content as string,
      ...(payload.title !== undefined ? { title: payload.title as string } : {}),
      ...(payload.isPublic !== undefined ? { isPublic: payload.isPublic as boolean } : {})
    });
    // "saved" is always recorded regardless of historyTrackingMode - it is
    // the minimum surface a user needs to find their blobs in M5b. The
    // auto_fifo eviction above is intentionally NOT recorded as "deleted":
    // it is system-driven, not user-initiated.
    await recordHistorySafely(context, {
      userId: principal.id,
      action: 'saved',
      blobId: saved.id,
      slug: saved.slug,
      ...(saved.title ? { title: saved.title } : {})
    });
    return {
      status: 201,
      jsonBody: autoDeleted ? { ...saved, autoDeleted } : saved
    };
  } catch (err) {
    if (err instanceof BlobValidationError) return badRequest(err.message);
    if (err instanceof SlugGenerationError) {
      return { status: 503, jsonBody: { error: 'Could not allocate a unique slug - please retry' } };
    }
    return internalError(context, 'postBlob write', err);
  }
}

export async function getBlob(
  req: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const idOrSlug = req.params['idOrSlug'] ?? '';
  if (!idOrSlug) return badRequest('Missing idOrSlug path parameter');

  try {
    const blob = await findBlobByIdOrSlug(idOrSlug);
    if (!blob) return notFound('Blob not found');
    // Record a "viewed" entry only when the caller is authenticated, is
    // NOT the owner, and has opted into all_actions tracking. Anonymous
    // public-link viewers are never tracked. Owner reads (e.g. opening
    // their own saved link) are noise. Auth on this route is optional, so
    // tryAuth never throws on missing/invalid tokens.
    try {
      const principal = await tryAuth(req);
      if (principal && principal.id !== blob.ownerId) {
        const mode = await readHistoryMode(context, principal.id);
        if (mode === 'all_actions') {
          await recordHistorySafely(context, {
            userId: principal.id,
            action: 'viewed',
            blobId: blob.id,
            slug: blob.slug,
            ...(blob.title ? { title: blob.title } : {})
          });
        }
      }
    } catch (err) {
      // tryAuth swallows AuthError; only true infra failures land here.
      // Surface in logs but never fail the read.
      context.warn('getBlob history hook failed', err);
    }
    return { status: 200, jsonBody: blob };
  } catch (err) {
    return internalError(context, 'getBlob read', err);
  }
}

export async function listBlobs(
  req: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message);
    return internalError(context, 'listBlobs auth', err);
  }

  try {
    const blobs = await listBlobsByOwner(principal.id);
    return { status: 200, jsonBody: blobs };
  } catch (err) {
    return internalError(context, 'listBlobs read', err);
  }
}

export async function deleteBlob(
  req: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message);
    return internalError(context, 'deleteBlob auth', err);
  }

  const id = req.params['id'] ?? '';
  if (!id) return badRequest('Missing id path parameter');

  try {
    const existing = await findBlobByIdOrSlug(id);
    if (!existing) return notFound('Blob not found');
    if (existing.id !== id) {
      // Mirror PUT: never operate on a doc keyed by slug - forces callers
      // to use the stable UUID so this endpoint is idempotent.
      return badRequest('DELETE requires the blob UUID id, not the slug');
    }
    if (existing.ownerId !== principal.id) {
      return forbidden('You do not own this blob');
    }

    const deleted = await deleteBlobById(existing.id, existing.ownerId);
    if (!deleted) return notFound('Blob not found');
    if ((await readHistoryMode(context, principal.id)) === 'all_actions') {
      await recordHistorySafely(context, {
        userId: principal.id,
        action: 'deleted',
        blobId: existing.id,
        slug: existing.slug,
        ...(existing.title ? { title: existing.title } : {})
      });
    }
    return { status: 204 };
  } catch (err) {
    return internalError(context, 'deleteBlob write', err);
  }
}

export async function putBlob(
  req: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message);
    return internalError(context, 'putBlob auth', err);
  }

  const id = req.params['id'] ?? '';
  if (!id) return badRequest('Missing id path parameter');

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('Request body must be JSON');
  }
  if (!body || typeof body !== 'object') {
    return badRequest('Request body must be an object');
  }
  const patch = body as { content?: unknown; title?: unknown; isPublic?: unknown };

  try {
    const existing = await findBlobByIdOrSlug(id);
    if (!existing) return notFound('Blob not found');
    if (existing.id !== id) {
      // PUT is keyed by UUID id only; accepting a slug would change
      // update-semantics silently. Reject if the caller used the slug.
      return badRequest('PUT requires the blob UUID id, not the slug');
    }
    if (existing.ownerId !== principal.id) {
      return forbidden('You do not own this blob');
    }

    const saved = await updateBlob(existing, {
      ...(patch.content !== undefined ? { content: patch.content as string } : {}),
      ...(patch.title !== undefined ? { title: patch.title as string } : {}),
      ...(patch.isPublic !== undefined ? { isPublic: patch.isPublic as boolean } : {})
    });
    if ((await readHistoryMode(context, principal.id)) === 'all_actions') {
      await recordHistorySafely(context, {
        userId: principal.id,
        action: 'edited',
        blobId: saved.id,
        slug: saved.slug,
        ...(saved.title ? { title: saved.title } : {})
      });
    }
    return { status: 200, jsonBody: saved };
  } catch (err) {
    if (err instanceof BlobValidationError) return badRequest(err.message);
    return internalError(context, 'putBlob write', err);
  }
}

app.http('blobs-post', {
  methods: ['POST'],
  route: 'blobs',
  authLevel: 'anonymous',
  handler: postBlob
});

app.http('blobs-list', {
  methods: ['GET'],
  route: 'blobs',
  authLevel: 'anonymous',
  handler: listBlobs
});

app.http('blobs-get', {
  methods: ['GET'],
  route: 'blobs/{idOrSlug}',
  authLevel: 'anonymous',
  handler: getBlob
});

app.http('blobs-put', {
  methods: ['PUT'],
  route: 'blobs/{id}',
  authLevel: 'anonymous',
  handler: putBlob
});

app.http('blobs-delete', {
  methods: ['DELETE'],
  route: 'blobs/{id}',
  authLevel: 'anonymous',
  handler: deleteBlob
});
