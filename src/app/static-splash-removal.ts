/**
 * Removes the pre-bootstrap static splash (`#jot-static-splash` in
 * `src/index.html`) after the Angular splash has painted on top of it.
 *
 * The double-`requestAnimationFrame` defers the removal one full paint
 * past Angular's first commit. A single rAF can fire on the same tick as
 * the pending paint, leaving a flash gap; double-rAF guarantees the
 * browser has actually painted the Angular splash before the static
 * splash is detached, so the visual handoff is seamless (both render the
 * identical `.jot-splash` markup).
 *
 * Extracted into its own module so the double-rAF behavior can be tested
 * in isolation, without a `TestBed` fixture in the same Karma session
 * queuing cross-spec rAFs into a controlled rAF shim. See #170 and
 * `static-splash-removal.spec.ts` for the bleed-isolation rationale.
 *
 * The module uses the `__<verb>ForTesting` seam convention documented in
 * `AGENTS.md` §4 so callers (AppComponent) can be unit-tested via a spy
 * without depending on `spyOn(module, ...)` semantics, which do not work
 * with Angular's esbuild builder (ESM live bindings bypass the namespace
 * object). Mirrors the pattern in `core/telemetry/web-vitals.ts`.
 */

const realScheduleStaticSplashRemoval = (): void => {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.getElementById('jot-static-splash')?.remove();
    });
  });
};

let scheduleStaticSplashRemovalImpl: () => void = realScheduleStaticSplashRemoval;

export function __setScheduleStaticSplashRemovalImplForTesting(impl: () => void): void {
  scheduleStaticSplashRemovalImpl = impl;
}

export function __resetScheduleStaticSplashRemovalImplForTesting(): void {
  scheduleStaticSplashRemovalImpl = realScheduleStaticSplashRemoval;
}

export function scheduleStaticSplashRemoval(): void {
  scheduleStaticSplashRemovalImpl();
}
