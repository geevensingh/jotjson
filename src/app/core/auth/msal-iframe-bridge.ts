// LEGACY: compensating code for `redirectUri = origin root`. When the
// /blank.html migration (issue #230) ships, iframes will load
// /blank.html instead of main.ts and this helper becomes dead code -
// delete the file at that time.
//
// BROWSER ONLY. Never import from app.config.server.ts or any
// prerendered path (would throw at parse time on the server platform).
//
// Caveat (skeptic Medium #4): the early-return in main.ts skips
// bootstrapApplication and the entire provider tree instantiation
// (router, AppUpdateService, MSAL provider factory, APP_INITIALIZER,
// SW registration). It does NOT skip parse of `AppComponent`,
// `appConfig`, and their transitive imports - those static imports at
// the top of main.ts evaluate on every load. If measured impact
// warrants it later, a pre-bootstrap inline script in index.html
// could push detection even earlier; deferred until measured.

import type { broadcastResponseToMainFrame } from '@azure/msal-browser/redirect-bridge';

type BridgeModule = { broadcastResponseToMainFrame: typeof broadcastResponseToMainFrame };

const BRIDGE_FAIL_KEY = 'jotjson.msalBridgeErr';

// state= is base64url and always 20+ chars (libraryState JSON encoded
// by MSAL's ProtocolUtils). Tighter than `\bstate=` alone - reduces
// false-positive surface for hypothetical same-origin embeds with
// short tracker strings like "state=ok".
const RESPONSE_MARKERS = /[?&#]state=[A-Za-z0-9_-]{20,}/;
const CODE_OR_ERROR = /[?&#](?:code|error)=/;

/**
 * True when running inside an iframe whose URL carries an MSAL
 * authentication response (code+state or error+state). Does NOT
 * detect popup flows - if we ever add `acquireTokenPopup`, the
 * detection must be extended. Same-origin only by virtue of CSP
 * `frame-ancestors 'self'`.
 *
 * Returns false in non-browser contexts (no global `window`) and
 * when the cross-origin check on `window.top` throws (defense in
 * depth - CSP frame-ancestors 'self' makes this impossible today
 * but we fail-closed regardless).
 *
 * @param win - test seam; when omitted, resolves to the global
 *   `window` if defined, else `undefined` (which causes the function
 *   to return false without attempting any property access).
 */
export function isInMsalSilentIframe(win?: Window): boolean {
  const w = win ?? (typeof window !== 'undefined' ? window : undefined);
  if (!w) return false;
  try {
    if (w.self === w.top) return false;
  } catch {
    return false;
  }
  const hash = w.location.hash;
  const search = w.location.search;
  const looksLikeMsalResponse = (urlPart: string): boolean =>
    RESPONSE_MARKERS.test(urlPart) && CODE_OR_ERROR.test(urlPart);
  return looksLikeMsalResponse(hash) || looksLikeMsalResponse(search);
}

/**
 * Dynamic-imports `@azure/msal-browser/redirect-bridge` and posts the
 * auth response to the parent over BroadcastChannel. On any failure,
 * persists a sanitized record to sessionStorage so `LoggerService` can
 * replay it as a `auth.msalBridge.failed` warning on the parent's next
 * bootstrap. The parent will see `redirect_bridge_timeout` from
 * `acquireTokenSilent` regardless; this replay is the diagnostic
 * channel telling us *why* the iframe-side bridge failed.
 *
 * @param loader - test seam; defaults to a real dynamic import of the
 *   MSAL `redirect-bridge` subpath export.
 */
export async function postAuthResponseToParent(
  loader: () => Promise<BridgeModule> = () => import('@azure/msal-browser/redirect-bridge'),
): Promise<void> {
  try {
    const mod = await loader();
    await mod.broadcastResponseToMainFrame();
  } catch (error: unknown) {
    try {
      const name = error instanceof Error ? error.name || 'Error' : 'BridgeError';
      const message =
        error instanceof Error
          ? (error.message ?? '').slice(0, 500)
          : '<non-error thrown in bridge>';
      sessionStorage.setItem(BRIDGE_FAIL_KEY, JSON.stringify({ name, message }));
    } catch {
      // sessionStorage may be unavailable (privacy mode); nothing
      // more we can do from outside Angular.
    }
  }
}
