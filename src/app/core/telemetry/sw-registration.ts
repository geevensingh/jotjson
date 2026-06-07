// LOCK-IN COMMENT: this file STATICALLY imports `BUILD_INFO` from
// `../../../generated/build-info`. This is a DELIBERATE reversal of
// the pattern at `src/main.ts` which dynamic-imports `BUILD_INFO`
// with the comment "Dynamic import keeps LoggerService (and App
// Insights SDK) out of the entry bundle in production".
//
// Why the reversal?
//
// The migration's stuck-cohort unstick mechanism REQUIRES that SW
// registration runs pre-bootstrap -- the user's browser may not
// reach `bootstrapApplication().then(...)` at all if the cached
// bundle is broken, but it WILL reach the top of main.ts. Per
// skeptic v2 #17 (in the SW migration plan), registering inside
// `.then()` means a stuck user with a broken bundle never reaches
// the unstick. Therefore the SW registration block, including the
// build-identity capture, must run synchronously above
// `bootstrapApplication(...)`. That rules out dynamic imports for
// `BUILD_INFO` here -- they would add an await boundary that the
// registration sequence cannot tolerate, AND they would defeat
// the entire point (we'd be awaiting `BUILD_INFO` while the SW is
// supposed to be registering NOW to maximize the unstick window).
//
// Bundle-size impact: minimal. `generated/build-info.ts` is a
// flat module with six string constants and no dependencies (no
// imports of its own). Pulling it into the entry bundle adds
// ~200 bytes gzipped. The dynamic-import pattern in main.ts was
// motivated by keeping the App Insights SDK out of the entry
// bundle, NOT BUILD_INFO -- the SDK is large; the build-info
// strings are not.
//
// If a future contributor sees this static import and tries to
// "fix" it to match the lazy pattern in main.ts, please read this
// comment first AND check `scripts/check-sw-shape.mjs` -- which
// asserts the static import as a load-bearing invariant.

import { BUILD_INFO } from '../../../generated/build-info';

interface BuildIdentity {
  readonly version: string;
  readonly sha: string;
  readonly branch: string;
  readonly buildNumber: string;
}

export interface BrowserBucket {
  readonly browser: 'chrome' | 'edge' | 'firefox' | 'safari' | 'other';
  readonly os: 'windows' | 'mac' | 'linux' | 'android' | 'ios' | 'other';
}

export type SwRegisterFailReason =
  | 'security'
  | 'syntax'
  | 'fetch'
  | 'type'
  | 'network'
  | 'abort'
  | 'other';

export type SwEvent =
  | { name: 'sw.registered'; props: BuildIdentity; timestamp: number }
  | { name: 'sw.activated'; props: BuildIdentity; timestamp: number }
  | {
      name: 'sw.registerFailed';
      props: BuildIdentity & { reason: SwRegisterFailReason };
      timestamp: number;
    }
  | {
      name: 'sw.legacyCacheWiped';
      props: BuildIdentity & BrowserBucket;
      timestamp: number;
    };

export const SW_EVENTS_KEY = 'jotjson.sw.events';

const SENTINEL_DB_NAME = 'jotjson-sw-migration';
const SENTINEL_STORE = 'sentinel';
const SENTINEL_KEY = 'legacyCacheWiped';

function buildIdentity(): BuildIdentity {
  return {
    version: BUILD_INFO.version,
    sha: BUILD_INFO.sha,
    branch: BUILD_INFO.branch,
    buildNumber: BUILD_INFO.buildNumber,
  };
}

let loggerConnected = false;
let directEmit: ((event: SwEvent) => void) | undefined;

/**
 * Called by `LoggerService.flushSessionStorage()` once the App
 * Insights SDK has connected. Reads any pre-bootstrap events from
 * `sessionStorage`, drains them via the supplied callback, then
 * flips the module-scoped flag so subsequent `queueSwEvent` calls
 * emit directly instead of touching `sessionStorage`.
 *
 * Invariants:
 * - **Idempotent**: a second call is a no-op so a future code path
 *   that accidentally re-invokes attach (e.g., a retry after
 *   auth-bridge late-init) cannot drop in-flight events or
 *   double-drain.
 * - **Exception-safe**: any `sessionStorage` failure (private mode,
 *   blocked storage, quota / SecurityError) is swallowed; direct-
 *   emit attachment ALWAYS completes so post-bootstrap events still
 *   flow even when the pre-bootstrap queue is unreachable.
 * - **Drain-only-on-clear**: events are dispatched ONLY when the
 *   `removeItem` clear succeeded. If `getItem` returned a queue but
 *   `removeItem` threw, the queue remains in sessionStorage and the
 *   drain is skipped on this attach so the same envelopes are not
 *   emitted twice on the next page load (where `removeItem` may
 *   succeed). Tradeoff: a user who hits the rare `getItem-ok /
 *   removeItem-fail` sequence AND closes the tab before the next
 *   navigation loses those queued envelopes. Acceptable: tab-bounded
 *   sessionStorage wipes them anyway, and clean once-per-event
 *   semantics matter more to the migration alert thresholds than
 *   over-counting noise.
 * - Per skeptic v5 S1: direct-emit attachment runs even when the
 *   stored queue is empty, so post-bootstrap events for the
 *   dominant non-stuck cohort do not silently re-queue to a
 *   never-drained sessionStorage slot.
 * - Per skeptic v5 S4: each emit is wrapped in its own try/catch so
 *   a single throwing dispatch does NOT drop the rest of the batch.
 * - Per SP4 (v5): the flag is flipped AFTER the read+drain to
 *   prevent a sync re-entrant queue write from bypassing both the
 *   sessionStorage path AND the safety-belt re-read.
 */
export function attachSwEventDirectEmit(emit: (event: SwEvent) => void): void {
  if (loggerConnected) return;

  let raw: string | null = null;
  let canDrain = false;
  try {
    raw = sessionStorage.getItem(SW_EVENTS_KEY);
    if (raw !== null) {
      sessionStorage.removeItem(SW_EVENTS_KEY);
      canDrain = true;
    }
  } catch {
    // sessionStorage unavailable OR removeItem failed after getItem
    // succeeded. In the latter case, raw is non-null but canDrain is
    // still false; the queued envelopes stay in sessionStorage so
    // the next page load can drain them once instead of this load
    // emitting + the next load re-emitting. Direct-emit attachment
    // below is unconditional so post-bootstrap events still flow.
  }
  if (canDrain && raw !== null) {
    try {
      const events: unknown = JSON.parse(raw);
      if (Array.isArray(events)) {
        for (const event of events) {
          if (!isSwEvent(event)) continue;
          try {
            emit(event);
          } catch {
            // intentional swallow: one bad emit must not drop others.
          }
        }
      }
    } catch {
      // malformed; drop.
    }
  }
  directEmit = emit;
  loggerConnected = true;
}

export function isSwEvent(value: unknown): value is SwEvent {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as { name?: unknown };
  if (typeof obj.name !== 'string') return false;
  return obj.name.startsWith('sw.');
}

export type QueueSwEventInput =
  | { name: 'sw.registered' }
  | { name: 'sw.activated' }
  | { name: 'sw.registerFailed'; reason: SwRegisterFailReason }
  | { name: 'sw.legacyCacheWiped' };

export function queueSwEvent(partial: QueueSwEventInput): void {
  const id = buildIdentity();
  const timestamp = Date.now();
  let event: SwEvent;
  switch (partial.name) {
    case 'sw.registered':
      event = { name: 'sw.registered', props: id, timestamp };
      break;
    case 'sw.activated':
      event = { name: 'sw.activated', props: id, timestamp };
      break;
    case 'sw.registerFailed':
      event = {
        name: 'sw.registerFailed',
        props: { ...id, reason: partial.reason },
        timestamp,
      };
      break;
    case 'sw.legacyCacheWiped':
      event = {
        name: 'sw.legacyCacheWiped',
        props: { ...id, ...detectBrowserBucket() },
        timestamp,
      };
      break;
  }

  if (loggerConnected && directEmit) {
    try {
      directEmit(event);
    } catch {
      // best-effort; do not propagate.
    }
    return;
  }

  try {
    const raw = sessionStorage.getItem(SW_EVENTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const queue: SwEvent[] = Array.isArray(parsed) ? (parsed as SwEvent[]) : [];
    queue.push(event);
    sessionStorage.setItem(SW_EVENTS_KEY, JSON.stringify(queue));
  } catch {
    // sessionStorage may be unavailable (private mode, quota); best-effort.
  }
}

export function classifyRegistrationError(err: unknown): SwRegisterFailReason {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  if (name === 'SecurityError') return 'security';
  if (name === 'SyntaxError') return 'syntax';
  if (name === 'NetworkError') return 'network';
  if (name === 'AbortError') return 'abort';
  if (name === 'TypeError') return 'type';
  if (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string' &&
    /script|fetch|load/i.test((err as { message: string }).message)
  ) {
    return 'fetch';
  }
  return 'other';
}

export function detectBrowserBucket(): BrowserBucket {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const lc = ua.toLowerCase();
  // Skeptic v5 S7: iOS Chrome (`CriOS/`), Firefox iOS (`FxiOS/`), and
  // Edge iOS (`EdgiOS/`) UAs all also contain `Safari/` because iOS
  // forces all browsers to use the WebKit engine. Check iOS-specific
  // tokens FIRST so they bucket correctly.
  let browser: BrowserBucket['browser'];
  if (lc.includes('edgios')) browser = 'edge';
  else if (lc.includes('fxios')) browser = 'firefox';
  else if (lc.includes('crios')) browser = 'chrome';
  else if (lc.includes('edg/')) browser = 'edge';
  else if (lc.includes('firefox')) browser = 'firefox';
  else if (lc.includes('chrome')) browser = 'chrome';
  else if (lc.includes('safari')) browser = 'safari';
  else browser = 'other';

  let os: BrowserBucket['os'];
  if (lc.includes('windows')) os = 'windows';
  else if (lc.includes('android')) os = 'android';
  else if (lc.includes('iphone') || lc.includes('ipad')) os = 'ios';
  else if (lc.includes('mac os')) os = 'mac';
  else if (lc.includes('linux')) os = 'linux';
  else os = 'other';

  return { browser, os };
}

/**
 * Reads the IndexedDB sentinel set by `src/sw.worker.ts` on
 * activate-with-non-empty-cache, and deletes it atomically (the
 * get+delete is one readwrite transaction, so a tab crash mid-tx
 * rolls back; worst case the sentinel re-fires `sw.legacyCacheWiped`
 * on the next boot, which is acceptable idempotent telemetry).
 *
 * Returns `true` if the sentinel was set (i.e., the SW just wiped
 * legacy caches), `false` otherwise (including all error paths --
 * private-mode IDB, quota exhaustion, etc. The migration completes
 * correctly without this signal; only the telemetry is lost.)
 */
export async function readAndClearLegacyCacheSentinel(): Promise<boolean> {
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(SENTINEL_DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(SENTINEL_STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      const value = await new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction(SENTINEL_STORE, 'readwrite');
        const store = tx.objectStore(SENTINEL_STORE);
        const getReq = store.get(SENTINEL_KEY);
        let result: unknown;
        getReq.onsuccess = () => {
          result = getReq.result;
          if (result !== undefined) {
            store.delete(SENTINEL_KEY);
          }
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      return value !== undefined;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/**
 * Eagerly registers the canonical `/sw.js` service worker and wires
 * activation telemetry. Idempotency is owned by the browser
 * registration cache.
 *
 * Caller MUST gate on `environment.production`,
 * `'serviceWorker' in navigator`, and `!isInMsalSilentIframe()`
 * before calling. The function does NOT re-check these.
 */
export function registerServiceWorker(): void {
  navigator.serviceWorker.register('/sw.js').then(
    (reg) => {
      queueSwEvent({ name: 'sw.registered' });

      let activatedReported = false;
      const reportActivatedOnce = (): void => {
        if (activatedReported) return;
        activatedReported = true;
        queueSwEvent({ name: 'sw.activated' });
      };

      const watchActivation = (sw: ServiceWorker | null): void => {
        if (!sw) return;
        if (sw.state === 'activated') {
          // Skeptic v3 #2: only fire if the activated worker is at the
          // canonical URL (filters out the legacy-alias worker that may
          // briefly be `reg.active` during the second cycle of a
          // stuck-user migration).
          if (sw.scriptURL.endsWith('/sw.js')) reportActivatedOnce();
          return;
        }
        sw.addEventListener('statechange', () => {
          if (sw.state === 'activated' && sw.scriptURL.endsWith('/sw.js')) {
            reportActivatedOnce();
          }
        });
      };
      watchActivation(reg.installing);
      watchActivation(reg.waiting);
      watchActivation(reg.active);

      // Advocate v4 A4 / skeptic v5 S3: reset the closure guard when a
      // NEW SW is discovered so a second activation within the same
      // page-load re-fires sw.activated. `updatefound` fires before
      // the new SW begins installing; reg.installing then points at
      // the new worker, so re-attaching watchActivation captures its
      // statechange.
      reg.addEventListener('updatefound', () => {
        activatedReported = false;
        watchActivation(reg.installing);
      });
    },
    (err: unknown) => {
      queueSwEvent({
        name: 'sw.registerFailed',
        reason: classifyRegistrationError(err),
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Test-only seams (see AGENTS.md §4 "Test-only seams on production classes").
// ---------------------------------------------------------------------------

/** Resets the module-scoped state. Test-only seam. */
export function __resetSwRegistrationForTesting(): void {
  loggerConnected = false;
  directEmit = undefined;
  try {
    sessionStorage.removeItem(SW_EVENTS_KEY);
  } catch {
    // ignore
  }
}
