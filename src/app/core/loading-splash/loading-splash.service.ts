import { Injectable, Signal, inject, signal } from '@angular/core';
import {
  Event as RouterEvent,
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  NavigationStart,
  Router,
} from '@angular/router';
import { LoggerService } from '../telemetry/logger.service';

/**
 * Drives the Angular-side loading splash that bridges the gap between the
 * static cold-boot splash in `src/index.html` and the first rendered
 * route. The user-visible goal: a cold-boot deep-link to `/s/:slug`
 * shows the same logo + label + (optional) progress bar from the moment
 * the page loads, with the label transitioning through three discrete
 * lifecycle stages instead of pinning at "Loading JSON..." while the
 * tree silently mounts.
 *
 * **Three lifecycle stages**:
 * - **bootstrap** (`kind === 'jotjson'`, `renderPending === false`):
 *   "Loading JotJSON..." splash matching the static splash in
 *   index.html. Shown during the first navigation when the target is
 *   not a share blob, and as the brief window before the very first
 *   NavigationStart fires.
 * - **download** (`kind === 'blob'`, `renderPending === false`):
 *   "Downloading JSON..." variant. Shown whenever any `/s/:slug`
 *   navigation is in flight during the first-navigation window.
 *   Progress bar is determinate when the resolver is reporting
 *   fractions, indeterminate otherwise.
 * - **render-pending** (`kind === null`, `renderPending === true`):
 *   "Rendering tree..." variant. Entered when the first cold-boot
 *   blob nav settles via `NavigationEnd`; covers the synchronous
 *   change-detection pass that mounts `HomeComponent` and renders
 *   the JSON tree. The bar is intentionally HIDDEN during this
 *   stage - we have no honest progress signal to show, and a
 *   pinned-at-100% bar reads as "stuck" (the very perception this
 *   stage exists to fix). Cleared by `HomeComponent` calling
 *   `markBlobRenderComplete` after first browser paint.
 * - hidden (`kind === null`, `renderPending === false`): the splash
 *   is no longer in the DOM. After the first navigation terminates
 *   the in-app route progress bar takes over per Option 2 of M8 -
 *   in-app navigation never re-shows the splash.
 *
 * **Why a Set of nav IDs**: same rationale as
 * `NavigationProgressService` - a `/s/:slug` resolver redirect on 404
 * produces a Cancel-then-Start sequence and we want the splash to
 * track in-flight navigations consistently. Once the first nav
 * settles (`firstNavComplete`), the splash latches to `null` and never
 * re-appears for in-app navigations.
 *
 * **Render-pending only on NavigationEnd**: NavigationCancel /
 * NavigationError / NavigationSkipped of a blob nav goes straight to
 * `kind=null` with `renderPending` unchanged (false). This matters
 * because `share-blob.resolver.ts` redirects bad slugs to `/404` via
 * `router.navigateByUrl('/404')` which fires a NavigationCancel for
 * the original `/s/:slug` nav, not a NavigationError - and there is
 * no tree to render in that case.
 *
 * **Cancel-redirect blank gap (accepted)**: on a `/s/badSlug -> /404`
 * redirect, NavigationCancel(1) fires with no further in-flight nav
 * in the same task as the synchronous NavigationStart(2,'/404').
 * Because `inFlight.size === 0` between those two events,
 * `firstNavComplete` latches and the splash hides momentarily before
 * the /404 page mounts. The alternative (deferring latch until the
 * actual final terminal, or carrying the blob label into /404 via an
 * extra "ever-seen-blob" flag) adds real complexity for a sub-second
 * blank in a path most users will never hit. Documented as known
 * UX papercut.
 *
 * **No cleanup**: root singleton, lives for the app lifetime.
 *
 * **Initial-navigation assumption**: this design depends on
 * `Router.initialNavigation` not being disabled. `app.config.ts`
 * provides Router without `withDisabledInitialNavigation()`, so the
 * very first NavigationStart fires reliably during bootstrap. If a
 * future change disables initial navigation, `firstNavStarted` would
 * never flip and the splash would stick on the bootstrap label
 * forever.
 */
@Injectable({ providedIn: 'root' })
export class LoadingSplashService {
  private readonly _kind = signal<'jotjson' | 'blob' | null>('jotjson');
  readonly kind: Signal<'jotjson' | 'blob' | null> = this._kind.asReadonly();

  /**
   * `true` while the splash is held on the "Rendering tree..." label
   * after the first cold-boot blob nav has settled via NavigationEnd
   * but before `HomeComponent` has signalled first browser paint via
   * `markBlobRenderComplete`. Orthogonal to {@link kind} so the kind
   * state machine doesn't have to know about render-side events.
   *
   * Cleared (false) by:
   * - `markBlobRenderComplete()` on first paint (the success path);
   *   emits `blob.coldBoot.firstPaint` telemetry.
   * - `NavigationStart` while `renderPending === true` (user navigated
   *   away mid-render); does NOT emit telemetry.
   *
   * Never set on subsequent navs because of the `firstNavComplete`
   * latch - in-app `/` -> `/s/:slug` is covered by the route progress
   * bar instead.
   */
  private readonly _renderPending = signal<boolean>(false);
  readonly renderPending: Signal<boolean> = this._renderPending.asReadonly();

  /**
   * Determinate progress fraction in `[0, 1]` for the in-flight blob
   * fetch, or `null` to indicate indeterminate (no progress signal
   * available). Drives the smooth-fill variant of the splash bar and
   * the in-app route progress bar.
   *
   * Lifecycle is fully router-driven so the resolver does not need to
   * coordinate clears:
   * - reset to `null` on every `NavigationStart` (covers
   *   cancelled-then-restarted blob navs and overlapping in-app navs
   *   without explicit owner tokens),
   * - reset to `null` when `kind` transitions to `null` on
   *   first-nav-settle (covers splash hide).
   *
   * The resolver pushes values via `reportBlobProgress` while a fetch
   * is in flight and snaps to `1.0` on the terminal `Response` event
   * so the bar visually completes before the splash disappears.
   */
  private readonly _progress = signal<number | null>(null);
  readonly progress: Signal<number | null> = this._progress.asReadonly();

  private readonly inFlight = new Set<number>();
  private readonly inFlightBlob = new Set<number>();
  private firstNavStarted = false;
  private firstNavComplete = false;

  /**
   * `performance.now()` timestamp captured at the moment
   * `_renderPending` flips to `true` (i.e., the NavigationEnd of the
   * cold-boot blob nav). Used to compute the `durationMs` measurement
   * on the `blob.coldBoot.firstPaint` telemetry event when
   * `markBlobRenderComplete` fires. `null` whenever `_renderPending`
   * is `false`.
   */
  private renderPendingStartedAt: number | null = null;

  private readonly logger = inject(LoggerService);

  constructor() {
    inject(Router).events.subscribe((event) => this.handle(event));
  }

  /**
   * Push a progress update for the in-flight blob fetch. Clamps the
   * fraction to `[0, 1]` when `total` is a positive finite number;
   * otherwise sets progress back to indeterminate (`null`). Safe to
   * call repeatedly during a fetch and once more with
   * `reportBlobProgress(total, total)` on the terminal event to snap
   * the bar to `1.0` for visual closure before the splash hides.
   *
   * Lifecycle note: callers MUST NOT clear progress manually -- the
   * service resets on `NavigationStart` and on `kind=null` transitions
   * automatically. This is what keeps overlapping or cancelled-and-
   * restarted blob navs from leaking stale fractions.
   */
  reportBlobProgress(loaded: number, total: number | null): void {
    if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) {
      this._progress.set(null);
      return;
    }
    if (typeof loaded !== 'number' || !Number.isFinite(loaded)) {
      this._progress.set(null);
      return;
    }
    const fraction = loaded / total;
    if (fraction < 0) {
      this._progress.set(0);
      return;
    }
    if (fraction > 1) {
      this._progress.set(1);
      return;
    }
    this._progress.set(fraction);
  }

  /**
   * Called by `HomeComponent` after the first browser paint of the
   * blob's tree (deferred via `afterNextRender` + double-rAF, the
   * established paint-barrier idiom in this repo). Clears
   * `renderPending` and emits the `blob.coldBoot.firstPaint`
   * telemetry event with a `durationMs` measurement covering the
   * NavigationEnd -> first-paint gap.
   *
   * Idempotent: a guard short-circuits when `renderPending === false`
   * so re-renders, `HomeComponent` re-instantiation across in-app
   * navs, and accidental double-calls never re-trigger telemetry.
   * The HomeComponent constructor's hook fires for every instance
   * (including the in-app `/` -> `/s/:slug` case) but the guard
   * ensures only the cold-boot blob nav actually emits.
   */
  markBlobRenderComplete(): void {
    if (!this._renderPending()) {
      return;
    }
    const startedAt = this.renderPendingStartedAt;
    this._renderPending.set(false);
    this.renderPendingStartedAt = null;
    const elapsed = startedAt !== null ? performance.now() - startedAt : 0;
    const durationMs = Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
    this.logger.event('blob.coldBoot.firstPaint', undefined, { durationMs });
  }

  private handle(event: RouterEvent): void {
    if (event instanceof NavigationStart) {
      if (this._renderPending()) {
        // User navigated away mid-render. Drop the pending state
        // without emitting telemetry - the abandoned render is not a
        // useful sample for the first-paint distribution.
        this._renderPending.set(false);
        this.renderPendingStartedAt = null;
      }
      this.firstNavStarted = true;
      this.inFlight.add(event.id);
      if (this.isBlobUrl(event.url)) {
        this.inFlightBlob.add(event.id);
      }
      this._progress.set(null);
      this.recomputeKind();
      return;
    }
    if (
      event instanceof NavigationEnd ||
      event instanceof NavigationCancel ||
      event instanceof NavigationError ||
      event instanceof NavigationSkipped
    ) {
      const previousKind = this._kind();
      this.inFlight.delete(event.id);
      this.inFlightBlob.delete(event.id);
      const willLatchFirstNavComplete =
        this.firstNavStarted && !this.firstNavComplete && this.inFlight.size === 0;
      if (willLatchFirstNavComplete) {
        this.firstNavComplete = true;
        if (event instanceof NavigationEnd && previousKind === 'blob') {
          // Enter render-pending: hide the bar and switch the label
          // to "Rendering tree..." while HomeComponent mounts and
          // first paints. Cleared by markBlobRenderComplete.
          this.renderPendingStartedAt = performance.now();
          this._renderPending.set(true);
          this._kind.set(null);
          this._progress.set(null);
          return;
        }
      }
      this.recomputeKind();
    }
  }

  private recomputeKind(): void {
    if (this.firstNavComplete) {
      this._kind.set(null);
      this._progress.set(null);
      return;
    }
    if (this.inFlightBlob.size > 0) {
      this._kind.set('blob');
      return;
    }
    this._kind.set('jotjson');
  }

  /**
   * Matches the actual share route shape (`/s/:slug`) - one segment
   * after `/s/`, no trailing path. Avoids false positives like
   * `/s/foo/bar` or bare `/s/` that `startsWith('/s/')` would catch.
   */
  private isBlobUrl(url: string): boolean {
    const beforeQuery = url.split('?')[0] ?? url;
    const path = beforeQuery.split('#')[0] ?? beforeQuery;
    return /^\/s\/[^\/]+$/.test(path);
  }
}
