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
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { AuthError, requireAuth, tryAuth } from '../shared/auth';
import {
  BlobValidationError,
  BlobVersionConflictError,
  MAX_BLOBS_PER_USER,
  SlugGenerationError,
  createBlob,
  deleteBlobById,
  findBlobByIdOrSlug,
  listBlobsByOwner,
  updateBlob,
  type BlobDocument,
  type BlobHighlight,
} from '../shared/blobs';
import { getRecentViewAt, recordEntry, VIEW_DEBOUNCE_SECONDS } from '../shared/history';
import {
  badRequest,
  forbidden,
  internalError,
  notFound,
  quotaExceeded,
  unauthorized,
} from '../shared/http';
import { readUser } from '../shared/users';

/**
 * Best-effort fire-and-forget history write. History tracking is a
 * bookkeeping concern; a Cosmos hiccup writing to the `history` container
 * must never fail the parent blob mutation. We await the write so test
 * doubles can assert it happened, but every failure is swallowed with a
 * warning.
 */
async function recordViewedSafely(
  context: InvocationContext,
  input: {
    userId: string;
    blobId: string;
    slug?: string;
    title?: string;
  },
): Promise<void> {
  try {
    await recordEntry({ ...input, action: 'viewed' });
  } catch (error) {
    context.warn('history record failed', { action: 'viewed', error });
  }
}

type PublicBlobDocument = Omit<BlobDocument, '_etag'>;
type BlobResponseBody = PublicBlobDocument & { highlights: BlobHighlight[] };

function publicBlob(blob: BlobDocument): PublicBlobDocument {
  const { _etag: _cosmosEtag, ...doc } = blob;
  void _cosmosEtag;
  return doc;
}

function withResponseHighlights(blob: BlobDocument): BlobResponseBody {
  const doc = publicBlob(blob);
  return { ...doc, highlights: doc.highlights ?? [] };
}

function preconditionFailed(message: string): HttpResponseInit {
  return { status: 412, jsonBody: { error: message } };
}

function withEtag(status: number, doc: BlobDocument): HttpResponseInit {
  return {
    status,
    headers: { ETag: `"${doc.version}"` },
    jsonBody: publicBlob(doc),
  };
}

/**
 * GET-only response helper that takes ownership of body serialization so we
 * can advertise the uncompressed body byte count via X-Jotjson-Body-Length.
 *
 * Why a custom header instead of relying on Content-Length? Azure Front Door
 * (in front of Static Web Apps) compresses application/json on the fly with
 * gzip/br and switches the response to Transfer-Encoding: chunked, dropping
 * Content-Length entirely. The frontend needs the uncompressed total to drive
 * a determinate progress bar for share-link blob loads. AFD passes unknown
 * custom headers through unchanged, so X-Jotjson-Body-Length survives the
 * compression pipeline.
 *
 * Browsers report decompressed bytes on XHR `progress` events, so dividing
 * `loaded` by this header value yields a clean 0..1 fraction without clamping.
 *
 * Only the GET handler uses this helper; PUT continues with `withEtag` because
 * its response is consumed as a parsed body, not streamed for progress.
 */
function withEtagAndBodyLength(status: number, blob: BlobDocument): HttpResponseInit {
  const responseBody = withResponseHighlights(blob);
  const body = JSON.stringify(responseBody);
  return {
    status,
    headers: {
      ETag: `"${blob.version}"`,
      'Content-Type': 'application/json',
      'X-Jotjson-Body-Length': String(Buffer.byteLength(body, 'utf8')),
    },
    body,
  };
}

function parseIfMatch(headerValue: string | null | undefined): number | null {
  if (typeof headerValue !== 'string') return null;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0 || trimmed.startsWith('W/')) return null;
  const unquoted = trimmed.replace(/^"|"$/g, '');
  if (!/^\d+$/.test(unquoted)) return null;
  const value = Number.parseInt(unquoted, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Read whether the caller has the "Recently viewed" tracking enabled.
 *
 * - Missing user doc / missing field -> default `true` (new-user
 *   default; the feature is on unless explicitly turned off).
 * - Read failure -> `false` (fail closed). A transient Cosmos hiccup
 *   must never silently turn tracking on for a user who opted out.
 */
async function readRecentlyViewedEnabled(
  context: InvocationContext,
  userId: string,
): Promise<boolean> {
  try {
    const user = await readUser(userId);
    const prefs = user?.preferences as
      | (Record<string, unknown> & { recentlyViewedEnabled?: unknown })
      | undefined;
    if (typeof prefs?.recentlyViewedEnabled === 'boolean') {
      return prefs.recentlyViewedEnabled;
    }
    return true;
  } catch (error) {
    context.warn('recentlyViewedEnabled read failed; failing closed', error);
    return false;
  }
}

export async function postBlob(
  req: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (error) {
    if (error instanceof AuthError) return unauthorized(error.message);
    return internalError(context, 'postBlob auth', error);
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
  const payload = body as {
    content?: unknown;
    title?: unknown;
    isPublic?: unknown;
    highlights?: unknown;
  };

  let autoDeleted: { id: string; slug: string; title?: string } | undefined;
  try {
    const existing = await listBlobsByOwner(principal.id);
    if (existing.length >= MAX_BLOBS_PER_USER) {
      const userDoc = await readUser(principal.id);
      const strategy = userDoc?.preferences?.blobQuotaStrategy ?? 'auto_fifo';
      if (strategy === 'manual') {
        return quotaExceeded(
          `Blob quota of ${MAX_BLOBS_PER_USER} reached. Delete an existing blob and try again.`,
          {
            resource: 'blob',
            via: 'create',
            count: existing.length,
            limit: MAX_BLOBS_PER_USER,
          },
        );
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
          ...(oldest.title ? { title: oldest.title } : {}),
        };
      }
    }
  } catch (error) {
    return internalError(context, 'postBlob quota', error);
  }

  try {
    const saved = await createBlob(principal.id, {
      content: payload.content,
      ...(payload.title !== undefined ? { title: payload.title } : {}),
      ...(payload.isPublic !== undefined ? { isPublic: payload.isPublic } : {}),
      ...(payload.highlights !== undefined ? { highlights: payload.highlights } : {}),
    });
    const response = withEtag(201, saved);
    if (!autoDeleted) return response;
    return {
      ...response,
      jsonBody: { ...(response.jsonBody as PublicBlobDocument), autoDeleted },
    };
  } catch (error) {
    if (error instanceof BlobValidationError) return badRequest(error.message);
    if (error instanceof SlugGenerationError) {
      return {
        status: 503,
        jsonBody: { error: 'Could not allocate a unique slug - please retry' },
      };
    }
    return internalError(context, 'postBlob write', error);
  }
}

export async function getBlob(
  req: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const idOrSlug = req.params['idOrSlug'] ?? '';
  if (!idOrSlug) return badRequest('Missing idOrSlug path parameter');

  try {
    const blob = await findBlobByIdOrSlug(idOrSlug);
    if (!blob) return notFound('Blob not found');
    // Record a "viewed" entry only when the caller is authenticated, is
    // NOT the owner, has the "Recently viewed" tracking enabled, and has
    // not already recorded a view for this same blob within
    // VIEW_DEBOUNCE_SECONDS. Anonymous public-link viewers are never
    // tracked. Owner reads (e.g. opening their own saved link) are noise.
    // Auth on this route is optional, so tryAuth never throws on
    // missing/invalid tokens.
    try {
      const principal = await tryAuth(req);
      if (principal && principal.id !== blob.ownerId) {
        const enabled = await readRecentlyViewedEnabled(context, principal.id);
        if (enabled) {
          const recent = await getRecentViewAt(principal.id, blob.id);
          let withinDebounce = false;
          if (recent) {
            const ageMs = Date.now() - new Date(recent).getTime();
            withinDebounce = Number.isFinite(ageMs) && ageMs < VIEW_DEBOUNCE_SECONDS * 1000;
          }
          if (!withinDebounce) {
            await recordViewedSafely(context, {
              userId: principal.id,
              blobId: blob.id,
              slug: blob.slug,
              ...(blob.title ? { title: blob.title } : {}),
            });
          }
        }
      }
    } catch (error) {
      // tryAuth swallows AuthError; only true infra failures land here.
      // Surface in logs but never fail the read.
      context.warn('getBlob history hook failed', error);
    }
    return withEtagAndBodyLength(200, blob);
  } catch (error) {
    return internalError(context, 'getBlob read', error);
  }
}

export async function listBlobs(
  req: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (error) {
    if (error instanceof AuthError) return unauthorized(error.message);
    return internalError(context, 'listBlobs auth', error);
  }

  try {
    const blobs = await listBlobsByOwner(principal.id);
    return { status: 200, jsonBody: blobs.map(withResponseHighlights) };
  } catch (error) {
    return internalError(context, 'listBlobs read', error);
  }
}

export async function deleteBlob(
  req: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (error) {
    if (error instanceof AuthError) return unauthorized(error.message);
    return internalError(context, 'deleteBlob auth', error);
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
      return forbidden('You do not own this blob', 'blob');
    }

    const deleted = await deleteBlobById(existing.id, existing.ownerId);
    if (!deleted) return notFound('Blob not found');
    return { status: 204 };
  } catch (error) {
    return internalError(context, 'deleteBlob write', error);
  }
}

export async function putBlob(
  req: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  let principal;
  try {
    principal = await requireAuth(req);
  } catch (error) {
    if (error instanceof AuthError) return unauthorized(error.message);
    return internalError(context, 'putBlob auth', error);
  }

  const id = req.params['id'] ?? '';
  if (!id) return badRequest('Missing id path parameter');

  const expectedVersion = parseIfMatch(req.headers.get('If-Match'));
  if (expectedVersion === null) {
    return badRequest('PUT requires a valid If-Match header carrying the blob version');
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
  const patch = body as {
    content?: unknown;
    title?: unknown;
    isPublic?: unknown;
    highlights?: unknown;
  };

  try {
    const existing = await findBlobByIdOrSlug(id);
    if (!existing) return notFound('Blob not found');
    if (existing.id !== id) {
      // PUT is keyed by UUID id only; accepting a slug would change
      // update-semantics silently. Reject if the caller used the slug.
      return badRequest('PUT requires the blob UUID id, not the slug');
    }
    if (existing.ownerId !== principal.id) {
      return forbidden('You do not own this blob', 'blob');
    }
    if (existing.version !== expectedVersion) {
      return preconditionFailed(
        `Blob was modified by another writer (expected version ${expectedVersion}, found ${existing.version})`,
      );
    }

    const saved = await updateBlob(
      existing,
      {
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.isPublic !== undefined ? { isPublic: patch.isPublic } : {}),
        ...(patch.highlights !== undefined ? { highlights: patch.highlights } : {}),
      },
      expectedVersion,
    );
    return withEtag(200, saved);
  } catch (error) {
    if (error instanceof BlobValidationError) return badRequest(error.message);
    if (error instanceof BlobVersionConflictError) return preconditionFailed(error.message);
    return internalError(context, 'putBlob write', error);
  }
}

app.http('blobs-post', {
  methods: ['POST'],
  route: 'blobs',
  authLevel: 'anonymous',
  handler: postBlob,
});

app.http('blobs-list', {
  methods: ['GET'],
  route: 'blobs',
  authLevel: 'anonymous',
  handler: listBlobs,
});

app.http('blobs-get', {
  methods: ['GET'],
  route: 'blobs/{idOrSlug}',
  authLevel: 'anonymous',
  handler: getBlob,
});

app.http('blobs-put', {
  methods: ['PUT'],
  route: 'blobs/{id}',
  authLevel: 'anonymous',
  handler: putBlob,
});

app.http('blobs-delete', {
  methods: ['DELETE'],
  route: 'blobs/{id}',
  authLevel: 'anonymous',
  handler: deleteBlob,
});
