/**
 * HTTP response helpers shared by every Azure Function handler in api/.
 *
 * Each helper returns an HttpResponseInit with a canonical status code +
 * JSON body shape, so handlers do not have to re-spell the same literals
 * at every call site. internalError additionally writes a structured
 * error log via context.error so unhandled exceptions are surfaced to
 * App Insights traces; the customEvents telemetry surface is wired
 * separately in shared/telemetry.ts.
 */
import type {
  HttpResponseInit,
  InvocationContext
} from '@azure/functions';

/** 401 Unauthorized. */
export function unauthorized(message: string): HttpResponseInit {
  return { status: 401, jsonBody: { error: message } };
}

/** 400 Bad Request. */
export function badRequest(message: string): HttpResponseInit {
  return { status: 400, jsonBody: { error: message } };
}

/** 404 Not Found. */
export function notFound(message: string): HttpResponseInit {
  return { status: 404, jsonBody: { error: message } };
}

/** 403 Forbidden. */
export function forbidden(message: string): HttpResponseInit {
  return { status: 403, jsonBody: { error: message } };
}

/**
 * 500 Internal Server Error with structured logging.
 *
 * `where` is a short label identifying the call site (e.g.
 * 'postMe write'); it is interpolated into the log message verbatim
 * and the underlying error is passed through to context.error.
 */
export function internalError(
  context: InvocationContext,
  where: string,
  error: unknown
): HttpResponseInit {
  context.error(`${where} error`, error);
  return { status: 500, jsonBody: { error: 'Internal error' } };
}
