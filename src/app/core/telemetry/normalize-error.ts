import { HttpErrorResponse } from '@angular/common/http';
import { redactPii, truncate } from './redact-pii';

/**
 * Strict, privacy-safe normalization of an unknown error value into a
 * shape that is safe to forward to App Insights.
 *
 * The raw `Error.message` of an `HttpErrorResponse` typically embeds the
 * full request URL (with query string) and the response body
 * `error.error` may contain server-side payloads. We never forward
 * either - we extract a curated allowlist of fields and drop the rest.
 *
 * For arbitrary `Error` instances we forward the name and a redacted +
 * truncated message and stack. For non-Error throws we record only that
 * the throw happened, never the value.
 */
export type NormalizedError =
  | {
      kind: 'http';
      status: number;
      statusText?: string;
      method?: string;
      pathTemplate?: string;
      backendCode?: string;
    }
  | { kind: 'error'; name: string; message: string; stack?: string }
  | { kind: 'unknown'; repr: string };

const MAX_MESSAGE = 500;
const MAX_STACK = 4000;

export interface HttpErrorContext {
  method?: string;
  pathTemplate?: string;
}

/**
 * Strip URL query and fragment so blob slugs and history filters
 * (`q`, `from`, `to`, `continuationToken`) never leak into telemetry.
 */
export function sanitizePath(rawUrl: string | null | undefined): string | undefined {
  if (!rawUrl) {
    return undefined;
  }
  const queryIdx = rawUrl.indexOf('?');
  const hashIdx = rawUrl.indexOf('#');
  let end = rawUrl.length;
  if (queryIdx >= 0) {
    end = Math.min(end, queryIdx);
  }
  if (hashIdx >= 0) {
    end = Math.min(end, hashIdx);
  }
  return rawUrl.slice(0, end);
}

export function normalizeError(error: unknown, ctx?: HttpErrorContext): NormalizedError {
  if (error instanceof HttpErrorResponse) {
    let backendCode: string | undefined;
    const body = error.error as unknown;
    if (
      body !== null &&
      typeof body === 'object' &&
      typeof (body as { code?: unknown }).code === 'string'
    ) {
      backendCode = (body as { code: string }).code;
    }
    return {
      kind: 'http',
      status: error.status,
      statusText: error.statusText || undefined,
      method: ctx?.method,
      pathTemplate: ctx?.pathTemplate ?? sanitizePath(error.url ?? undefined),
      backendCode,
    };
  }

  if (error instanceof Error) {
    return {
      kind: 'error',
      name: error.name || 'Error',
      message: redactPii(truncate(error.message ?? '', MAX_MESSAGE)),
      stack: error.stack ? redactPii(truncate(error.stack, MAX_STACK)) : undefined,
    };
  }

  return {
    kind: 'unknown',
    repr:
      typeof error === 'string'
        ? redactPii(truncate(error, MAX_MESSAGE))
        : `<non-error thrown: ${typeof error}>`,
  };
}
