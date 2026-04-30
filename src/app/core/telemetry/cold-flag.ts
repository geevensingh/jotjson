/**
 * Cold-flag registry for the `*.slow` family of telemetry events
 * (Phase A4). Each token (e.g., `parse.slow`, `tree.build.slow`)
 * carries a `cold: boolean` dimension that is `true` on the first
 * emission per session for that token, and `false` thereafter.
 *
 * The motivation: cold-start latencies (first parse of the page,
 * first tree build, etc.) are systematically slower than steady-state
 * because of code-path warm-up, JIT, and resource contention with
 * the rest of the bootstrap. Default KQL queries should
 * `where cold == false` so percentile dashboards report
 * steady-state user-perceived latency rather than a bimodal
 * mixture.
 *
 * Per-token (not global): a session that has already emitted
 * `parse.slow` once must still mark `tree.build.slow` as cold on
 * its first emission. They are independent code paths.
 *
 * Implementation: a `Set<TelemetryMessageId>` keyed by full token
 * name. `isColdAndMark(messageId)` returns `true` only the first
 * time per session per token; subsequent calls return `false` and
 * the set membership remains.
 */

import type { TelemetryMessageId } from './telemetry-message-ids';

const seenTokens = new Set<TelemetryMessageId>();

/**
 * Returns `true` if `messageId` has not yet been observed in this
 * session's cold-flag registry, then atomically marks it observed.
 * Subsequent calls with the same `messageId` return `false`.
 *
 * Callers should pass the result through to the event's `cold`
 * dimension exactly once per emission.
 */
export function isColdAndMark(messageId: TelemetryMessageId): boolean {
  if (seenTokens.has(messageId)) {
    return false;
  }
  seenTokens.add(messageId);
  return true;
}

/**
 * Test seam. Resets the cold-flag registry so each spec can run
 * with a known `cold === true` baseline. Production callers must
 * never reference this.
 */
export function __resetColdFlagsForTesting(): void {
  seenTokens.clear();
}
