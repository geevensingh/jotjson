// This service worker exists solely to satisfy Chromium's PWA
// installability check, which requires a registered SW with a fetch
// handler. The fetch handler intentionally does nothing. If Chromium
// ever decouples installability from this requirement, this entire
// file becomes a candidate for `self.registration.unregister()` in
// `activate` plus deletion of the registration in `main.ts`.
//
// The `activate` handler also wipes any legacy `@angular/service-worker`
// caches left over from the pre-migration ngsw, and writes a
// one-shot IndexedDB sentinel so the page can emit telemetry on
// the next boot of NEW `main.ts`. The sentinel mechanism is
// required because the stuck cohort arrives here via the
// `/ngsw-worker.js` byte-check while still running OLD `main.ts`
// (which has no message listener); the IDB sentinel is the only
// mechanism that survives the navigation boundary into NEW `main.ts`
// where the telemetry helper exists.
//
// Do NOT graft caching back on under the rationale "well, the SW is
// already there". The sole functional purpose is install-button
// satisfaction. Re-adding caching requires amending DESIGN_SPEC.md
// PWA section and the SW migration history entry.

/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

const SENTINEL_DB_NAME = 'jotjson-sw-migration';
const SENTINEL_STORE = 'sentinel';
const SENTINEL_KEY = 'legacyCacheWiped';

function openSentinelDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SENTINEL_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(SENTINEL_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function writeSentinel(): Promise<void> {
  const db = await openSentinelDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SENTINEL_STORE, 'readwrite');
      tx.objectStore(SENTINEL_STORE).put('1', SENTINEL_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const hadLegacyCaches = keys.length > 0;
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.clients.claim();

      // Write IDB sentinel so the next boot of NEW main.ts can fire
      // the `sw.legacyCacheWiped` telemetry. Must be in IDB (not
      // sessionStorage / localStorage -- SW context can't reach those)
      // and must survive the navigation boundary into NEW main.ts.
      // Best-effort: failing to write the sentinel does NOT fail
      // activation (caches are still wiped, app still works).
      // The `hadLegacyCaches` guard ensures the sentinel only writes
      // when we actually migrated a stuck user, so the second
      // install/activate cycle is a no-op and the event fires
      // exactly once per stuck-user migration.
      if (hadLegacyCaches) {
        try {
          await writeSentinel();
        } catch {
          // Best-effort; do not throw out of activate.
        }
      }
    })(),
  );
});

// Empty fetch handler. Required for Chrome PWA installability checks.
// Defaults to network because we do not call event.respondWith().
self.addEventListener('fetch', () => {});
