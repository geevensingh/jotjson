/**
 * /api/blobs - JSON blob CRUD endpoints.
 *
 * POST /api/blobs                -> create a new blob owned by the caller
 * GET  /api/blobs/{idOrSlug}     -> read any blob by UUID id or NanoID slug
 *                                   (auth optional - private/unlisted blobs
 *                                   are viewable by anyone with the link)
 * PUT  /api/blobs/{id}           -> update an owned blob in place
 *
 * DELETE and listing endpoints land in M4b.
 */
import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext
} from '@azure/functions';
import { AuthError, requireAuth } from '../shared/auth';
import {
  BlobValidationError,
  SlugGenerationError,
  createBlob,
  findBlobByIdOrSlug,
  updateBlob
} from '../shared/blobs';

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

  try {
    const saved = await createBlob(principal.id, {
      content: payload.content as string,
      ...(payload.title !== undefined ? { title: payload.title as string } : {}),
      ...(payload.isPublic !== undefined ? { isPublic: payload.isPublic as boolean } : {})
    });
    return { status: 201, jsonBody: saved };
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
    return { status: 200, jsonBody: blob };
  } catch (err) {
    return internalError(context, 'getBlob read', err);
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
