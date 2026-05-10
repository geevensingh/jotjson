import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, Signal, inject, signal } from '@angular/core';
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
 *   "Rendering tree..." variant. Entered when `BlobService` signals
 *   the body bytes are fully received but BEFORE the synchronous
 *   `JSON.parse` runs (via `markBlobBytesComplete`). Covers parse +
 *   activate + construct + CD + paint -- the heavy-work window for
 *   huge blobs, which would otherwise be mislabelled as "Downloading
 *   JSON..." with the bar pinned at 100%. The bar is intentionally
 *   HIDDEN during this stage - we have no honest progress signal to
 *   show, and a pinned-at-100% bar reads as "stuck" (the very
 *   perception this stage exists to fix). Cleared by `HomeComponent`
 *   calling `markBlobRenderComplete` after first browser paint.
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
 * **Render-pending is entered by bytesComplete, not NavigationEnd**:
 * the canonical entry trigger is `markBlobBytesComplete`, called by
 * the share resolver when `BlobService` emits its synthetic
 * `bytesComplete` event. NavigationEnd / Cancel / Error / Skipped
 * never enter render-pending; they only DRIVE THE FIRST-NAV LATCH.
 * If `markBlobBytesComplete` was already called (success path),
 * `_renderPending` stays `true` through NavigationEnd and is cleared
 * by `markBlobRenderComplete` on first paint. If a non-`End` terminal
 * fires while `_renderPending === true` (e.g., resolver redirected
 * to `/404` after parse error), the terminal branch clears
 * `_renderPending` defensively without emitting telemetry -- an
 * abandoned render is not a useful sample.
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
/**
 * Returns `true` only on the server platform during the static
 * prerender pass. Used both for the initial `kind` (null on server
 * so the prerendered <app-loading-splash> serializes to an empty
 * placeholder, leaving crawlers with the route's own server-side
 * content) and to pre-latch `firstNavComplete` (irrelevant on
 * server, but cheap defense in depth).
 *
 * **Browser-side intentionally always returns `false`**, regardless
 * of the postbuild-injected `<meta name="prerendered">` marker.
 * Prior to v0.12.1 the browser branch checked the marker so the
 * Angular splash would not paint on top of already-rendered
 * prerender content; in practice that meant the home server-skeleton
 * (brand + tagline + description, intended for crawlers) bled through
 * to users for hundreds of ms during cold-boot of `/`. The fix is
 * to (a) render the static splash as a `<body>` sibling of
 * `<app-root>` so the prerender pipeline cannot strip it, and
 * (b) always boot the Angular splash on browser so it covers the
 * server-skeleton as Angular bootstraps. AppComponent removes the
 * static splash via `afterNextRender + double-rAF` once the Angular
 * splash has painted on top -- see AppComponent for the handoff.
 *
 * The `<meta name="prerendered">` marker is still injected by
 * `scripts/postbuild-seo.mjs` and validated by
 * `scripts/check-prerender.mjs`; it just no longer drives splash
 * discrimination.
 *
 * MUST be called only inside an injection context (constructor /
 * field initializer / `inject`-context callback) - it calls
 * `inject(PLATFORM_ID)` directly.
 */
function isPrerenderedBoot(): boolean {
  return !isPlatformBrowser(inject(PLATFORM_ID));
}

@Injectable({ providedIn: 'root' })
export class LoadingSplashService {
  // Captured first so other field initializers below can reference it.
  // Both `_kind` initial value and `firstNavComplete` pre-latch depend
  // on whether this bootstrap is reading a prerendered HTML file.
  private readonly _prerenderedBoot = isPrerenderedBoot();

  private readonly _kind = signal<'jotjson' | 'blob' | null>(
    this._prerenderedBoot ? null : 'jotjson',
  );
  readonly kind: Signal<'jotjson' | 'blob' | null> = this._kind.asReadonly();

  /**
   * `true` while the splash is held on the "Rendering tree..." label
   * after the cold-boot blob fetch's body bytes have arrived but
   * before `HomeComponent` has signalled first browser paint via
   * `markBlobRenderComplete`. Orthogonal to {@link kind} so the kind
   * state machine doesn't have to know about render-side events.
   *
   * Set to `true` by `markBlobBytesComplete()` (the canonical entry
   * trigger, called by the share resolver when `BlobService` emits
   * `{ kind: 'bytesComplete' }` immediately before its synchronous
   * `JSON.parse`).
   *
   * Cleared (false) by:
   * - `markBlobRenderComplete()` on first paint (the success path);
   *   emits `blob.coldBoot.firstPaint` telemetry.
   * - `NavigationStart` while `renderPending === true` (user navigated
   *   away mid-render); does NOT emit telemetry.
   * - `NavigationCancel | NavigationError | NavigationSkipped` while
   *   `renderPending === true` (e.g., resolver redirected to /404
   *   after a parse error that occurred AFTER bytesComplete fired);
   *   does NOT emit telemetry.
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
  private readonly activeBootstrapHolds = new Set<symbol>();
  private firstNavStarted = false;
  /**
   * Latches once the first navigation has reached a terminal Router
   * event (End / Cancel / Error / Skipped) AND no other navs are
   * still in flight. While `false`, splash kind tracks navigation
   * state. Once `true`, the splash is permanently hidden and the
   * route-progress bar takes over for in-app navigation.
   *
   * On prerender-marker boots the prerendered HTML is already the
   * "first navigation result"; we pre-latch this to `true` at
   * construction so the Angular splash never shows on top of the
   * already-painted prerender, and the very first NavigationEnd
   * resolves to `kind = null` cleanly.
   */
  private firstNavComplete = this._prerenderedBoot;

  private readonly isBrowser = !this._prerenderedBoot;

  /**
   * `performance.now()` timestamp captured at the moment
   * `_renderPending` flips to `true` (i.e., when
   * `markBlobBytesComplete` fires for the cold-boot blob nav). Used
   * to compute the `durationMs` measurement on the
   * `blob.coldBoot.firstPaint` telemetry event when
   * `markBlobRenderComplete` fires. `null` whenever `_renderPending`
   * is `false`.
   */
  private renderPendingStartedAt: number | null = null;

  private readonly logger = inject(LoggerService);

  constructor() {
    inject(Router).events.subscribe((event) => this.handle(event));
  }

  beginBootstrapHold(reason: 'coldBootClipboard', maxMs: number): () => void {
    if (!this.isBrowser || this.firstNavComplete) {
      return () => {};
    }

    const token = Symbol(reason);
    this.activeBootstrapHolds.add(token);

    let timeoutId: number | null = null;
    const release = (): void => {
      if (!this.activeBootstrapHolds.delete(token)) {
        return;
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      this.recomputeKind();
    };

    timeoutId = window.setTimeout(() => {
      timeoutId = null;
      release();
    }, maxMs);

    this.recomputeKind();
    return release;
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
   * bytesComplete -> first-paint gap (which includes the synchronous
   * JSON.parse window, the resolver's terminal handler, route
   * activation, HomeComponent construction + change-detection, and
   * the browser paint).
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

  /**
   * Called by the share resolver when `BlobService` emits
   * `{ kind: 'bytesComplete' }`, i.e., when the body bytes of the
   * cold-boot blob fetch have fully arrived but BEFORE the
   * synchronous `JSON.parse` runs. Transitions the splash to the
   * render-pending stage so the bar hides and the label flips to
   * "Rendering tree..." while the parse + activate + construct +
   * CD + paint window proceeds. This is the canonical entry trigger
   * for `_renderPending`.
   *
   * Guarded by `_kind() !== 'blob'`:
   * - In-app navs are gated out: once `firstNavComplete` is true,
   *   `_kind` is `null` and the route progress bar handles things.
   * - A bootstrap-stage call (kind === 'jotjson') is gated out for
   *   the same reason -- bytesComplete should only ever fire while
   *   a blob fetch is in flight on the first nav.
   * - A defensive double-call is a no-op because the first call
   *   already cleared kind to `null`. The timer is not reset, no
   *   telemetry is double-emitted.
   */
  markBlobBytesComplete(): void {
    if (this._kind() !== 'blob') {
      return;
    }
    this.renderPendingStartedAt = performance.now();
    this._renderPending.set(true);
    this._kind.set(null);
    this._progress.set(null);
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
      this.inFlight.delete(event.id);
      this.inFlightBlob.delete(event.id);
      const willLatchFirstNavComplete =
        this.firstNavStarted && !this.firstNavComplete && this.inFlight.size === 0;
      if (willLatchFirstNavComplete) {
        this.firstNavComplete = true;
      }
      // If render-pending was entered early via markBlobBytesComplete
      // but the route then cancelled / errored / was skipped (e.g.,
      // the resolver redirected to /404 after a parse error fired
      // AFTER bytesComplete), drop the pending state without emitting
      // telemetry. NavigationEnd preserves render-pending so the
      // success path can wait for first paint.
      if (!(event instanceof NavigationEnd) && this._renderPending()) {
        this._renderPending.set(false);
        this.renderPendingStartedAt = null;
      }
      this.recomputeKind();
    }
  }

  private recomputeKind(): void {
    if (this._renderPending()) {
      this._kind.set(null);
      this._progress.set(null);
      return;
    }
    if (this.firstNavComplete && this.activeBootstrapHolds.size === 0) {
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
