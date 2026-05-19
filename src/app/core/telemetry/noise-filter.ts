import { TelemetryMessageId } from './telemetry-message-ids';

/**
 * Single seam where the global `TelemetryErrorHandler` decides whether
 * an escaped error is real signal worth forwarding to App Insights or
 * benign third-party-library noise that would otherwise pollute the
 * `exceptions` table and trip the unhandled-spike alert.
 *
 * Today the classifier has exactly one suppression rule: Monaco's
 * `CancellationError` (thrown during normal editor / completion-
 * provider disposal). When the next benign noise source appears
 * (e.g. stale-chunk fetch on post-deploy clients), add a new
 * `NoiseClassification` value here and route it from
 * `TelemetryErrorHandler.handleError`. Do NOT grow an if-ladder in
 * the handler.
 */

export type NoiseClassification = 'forward' | 'suppress';

export type SuppressReason = 'monacoCanceled';

export interface NoiseClassificationResult {
  readonly kind: NoiseClassification;
  readonly reasonBucket?: SuppressReason;
}

const FORWARD: NoiseClassificationResult = { kind: 'forward' };

export function classifyError(error: unknown): NoiseClassificationResult {
  try {
    if (isMonacoCancellation(error)) {
      return { kind: 'suppress', reasonBucket: 'monacoCanceled' };
    }
  } catch {
    // Defensive: a `Proxy` with a throwing `name` getter (or similar
    // pathological error value) must not escape the global handler.
    // Default to `forward` so the anomaly is still surfaced via the
    // normal `app.unhandled` path.
  }
  return FORWARD;
}

/**
 * Monaco's `class CancellationError extends Error` sets BOTH
 * `name === 'Canceled'` and `message === 'Canceled'` (see
 * `monaco-editor/src/vs/base/common/errors.ts`). Requiring both
 * narrows the predicate against an arbitrary library that happens to
 * set only `name`.
 *
 * As of this fix, no other dependency in `package.json` produces an
 * error with this combined shape (browser-native cancellation uses
 * `AbortError` / `DOMException`). Re-check this assumption when
 * adding new dependencies that perform async cancellation; if a
 * legitimate caller starts throwing the same shape, tighten this
 * predicate (e.g. add a stack-trace check) at that time.
 *
 * NOTE: `Error.ngOriginalError` unwrapping is intentionally NOT
 * performed today -- we have no evidence (in App Insights data for
 * this alert window) that Monaco cancellations arrive wrapped in
 * zone.js / Angular wrappers. If wrapped cancellations are observed
 * post-deploy, add an `error.ngOriginalError` walk here.
 */
function isMonacoCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { name?: unknown; message?: unknown };
  return candidate.name === 'Canceled' && candidate.message === 'Canceled';
}

/**
 * Convenience: the messageId used by the suppress-path counter event.
 * Re-exported as a typed `TelemetryMessageId` so call sites get the
 * literal-union safety check.
 */
export const SUPPRESSED_EVENT_ID: TelemetryMessageId = 'errorHandler.suppressed';
