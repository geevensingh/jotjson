/**
 * HTTP response helpers shared by every Azure Function handler in api/.
 *
 * Each helper returns an HttpResponseInit with a canonical status code +
 * JSON body shape, so handlers do not have to re-spell the same literals
 * at every call site. internalError additionally writes a structured
 * error log via context.error so unhandled exceptions are surfaced to
 * App Insights traces; the customEvents telemetry surface is wired
 * separately in shared/telemetry.ts.
 *
 * `withSecurityHeaders` (further down) wraps a route handler so every
 * response leaving the API surface carries a defense-in-depth set of
 * security headers (nosniff, frame-deny, no-referrer, default-src
 * 'none' CSP). Use it at every `app.http(...)` registration.
 */
import type {
  HttpHandler,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from '@azure/functions';
import { trackEvent } from './telemetry';

/**
 * Closed enum of resources that can return 403 due to ownership mismatch.
 * Extending this requires updating the `forbidden()` callers and the
 * access.forbidden customDimensions schema documented in docs/telemetry.md.
 */
export type ForbiddenResource = 'blob' | 'ruleSet';

/**
 * Closed enum of resources that can return 409 due to quota exhaustion.
 * Currently identical to ForbiddenResource but kept as a separate alias
 * so each event's schema can drift independently if a future quota
 * applies to a resource that has no ownership-mismatch path (or vice
 * versa).
 */
export type QuotaResource = 'blob' | 'ruleSet';

/**
 * Closed enum of creation flows that can hit a quota. `'create'` covers
 * both POST /api/blobs and POST /api/rule-sets; `'clone'` is reserved
 * for POST /api/rule-sets/presets/{id}/clone (cloning a built-in
 * preset). Extending this requires updating the `quotaExceeded()`
 * callers and the quota.exceeded customDimensions schema documented in
 * docs/telemetry.md.
 */
export type QuotaVia = 'create' | 'clone';

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

/**
 * 403 Forbidden. Emits a single access.forbidden customEvent with
 * `{ resource, authMode: 'required' }` so authorization rejections are
 * queryable in App Insights. authMode is hardcoded 'required' because
 * every current caller invokes forbidden() AFTER requireAuth has
 * resolved, never from an optional-auth path.
 */
export function forbidden(message: string, resource: ForbiddenResource): HttpResponseInit {
  trackEvent('access.forbidden', { resource, authMode: 'required' });
  return { status: 403, jsonBody: { error: message } };
}

/**
 * 409 Conflict for free-tier quota exhaustion. Emits a single
 * `quota.exceeded` customEvent with `{ resource, authMode: 'required',
 * via }` properties and `{ count, limit }` measurements so quota
 * pressure is queryable in App Insights. authMode is hardcoded
 * 'required' because every current caller invokes quotaExceeded()
 * AFTER requireAuth has resolved. `count` is the raw observed size at
 * rejection time (not clamped to `limit`) so historical overages or
 * post-deployment quota reductions remain visible in measurements.
 *
 * The response body keeps the pre-existing `code: 'quota_exceeded'`
 * literal so any client code switching on it stays compatible.
 */
export function quotaExceeded(
  message: string,
  {
    resource,
    via,
    count,
    limit,
  }: {
    resource: QuotaResource;
    via: QuotaVia;
    count: number;
    limit: number;
  },
): HttpResponseInit {
  trackEvent('quota.exceeded', { resource, authMode: 'required', via }, { count, limit });
  return {
    status: 409,
    jsonBody: { error: message, code: 'quota_exceeded' },
  };
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
  error: unknown,
): HttpResponseInit {
  context.error(`${where} error`, error);
  return { status: 500, jsonBody: { error: 'Internal error' } };
}

/**
 * Defense-in-depth security headers attached to every response leaving
 * the API surface via `withSecurityHeaders`. These complement, but do
 * not duplicate, the `globalHeaders` block in `staticwebapp.config.json`
 * (which only covers static-served paths and does NOT propagate to
 * managed Functions API responses).
 *
 * Header rationale:
 *   - X-Content-Type-Options: nosniff -- prevent MIME sniffing if a
 *     response ever leaks HTML or non-JSON content (e.g., an error
 *     page from a misconfigured upstream).
 *   - X-Frame-Options: DENY -- API responses must never be framed.
 *     Tighter than the static surface (SAMEORIGIN, which exists to
 *     permit MSAL silent-refresh iframes); the API has no analogous
 *     same-origin frame requirement.
 *   - Referrer-Policy: no-referrer -- safer than the static surface's
 *     `strict-origin-when-cross-origin` for an API: an API response's
 *     Referrer-Policy rarely affects the page that fetched it, but
 *     when an API URL is opened directly in a browser the no-referrer
 *     value avoids leaking the API path to any later navigations.
 *   - Content-Security-Policy: default-src 'none'; frame-ancestors
 *     'none' -- if a response ever returns HTML (error path, debug
 *     page), the browser will not load any embedded resources.
 *     Frame-ancestors duplicates X-Frame-Options for browsers that
 *     prefer the CSP form.
 *
 * HSTS is intentionally NOT set here -- the Functions runtime sets a
 * platform-managed `Strict-Transport-Security` (max-age=31536000;
 * includeSubDomains) on every response upstream; replicating it would
 * risk drift if the platform tightens the value.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

/**
 * Wraps a route handler so every successful or error response carries
 * the SECURITY_HEADERS set. Apply at the `app.http(...)` registration:
 *
 *   app.http('blobs-get', {
 *     methods: ['GET'],
 *     route: 'blobs/{idOrSlug}',
 *     handler: withSecurityHeaders(getBlob),
 *   });
 *
 * Behaviour:
 *   - Success path: spreads SECURITY_HEADERS LAST into the response's
 *     `headers` object, so security headers override any handler-set
 *     value for the same key. Disjoint keys (ETag, Cache-Control, ...)
 *     are preserved.
 *   - Error path (handler throws): logs the error via `context.error`
 *     and synthesizes a 500 response with the security headers and a
 *     generic JSON body. Without this branch, an uncaught throw would
 *     bypass the wrapper and the platform's default 500 response would
 *     ship without our headers -- exactly the case where leaked HTML
 *     in an error body would benefit most from nosniff and CSP.
 */
export function withSecurityHeaders(handler: HttpHandler): HttpHandler {
  return async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    try {
      const response = await handler(request, context);
      return {
        ...response,
        headers: { ...response.headers, ...SECURITY_HEADERS },
      };
    } catch (error) {
      context.error('Unhandled handler error:', error);
      return {
        status: 500,
        headers: { ...SECURITY_HEADERS },
        jsonBody: { error: 'Internal error' },
      };
    }
  };
}
