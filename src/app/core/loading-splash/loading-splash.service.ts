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

/**
 * Drives the Angular-side loading splash that bridges the gap between the
 * static cold-boot splash in `src/index.html` and the first rendered
 * route. The user-visible goal: a cold-boot deep-link to `/s/:slug`
 * shows the same logo + bar + layout from the moment the page loads,
 * with the label saying "Loading JSON..." while the resolver fetches
 * the blob - no blank screen, no progress-bar-only window.
 *
 * **Three kinds of splash state**:
 * - `'jotjson'` - generic "Loading JotJSON..." splash matching the
 *   static splash in index.html. Shown during the first navigation
 *   when the target is not a share blob.
 * - `'blob'` - "Loading JSON..." variant. Shown whenever any
 *   `/s/:slug` navigation is in flight during the first-navigation
 *   window.
 * - `null` - splash is hidden. Reached once the first navigation
 *   terminates (End / Cancel / Error / Skipped); after that, the
 *   in-app route progress bar takes over per Option 2 of M8 -
 *   in-app navigation never re-shows the splash.
 *
 * **Why peek `window.location.pathname` in the constructor**: the very
 * first NavigationStart fires shortly after Router bootstrap, and we
 * want the Angular splash's first paint to already match the eventual
 * NavigationStart kind. Without this peek, a cold-boot to `/s/:slug`
 * would briefly render "Loading JotJSON..." before flipping to
 * "Loading JSON...".
 *
 * **Why a Set of nav IDs**: same rationale as
 * `NavigationProgressService` - a `/s/:slug` resolver redirect on 404
 * produces a Cancel-then-Start sequence and we want the splash to
 * track in-flight navigations consistently. Once the first nav
 * settles (`firstNavComplete`), the splash latches to `null` and never
 * re-appears for in-app navigations.
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
 * never flip and the splash would stick at its constructor-peeked
 * kind until something else terminates a nav.
 */
@Injectable({ providedIn: 'root' })
export class LoadingSplashService {
  private readonly _kind = signal<'jotjson' | 'blob' | null>('jotjson');
  readonly kind: Signal<'jotjson' | 'blob' | null> = this._kind.asReadonly();

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

  constructor() {
    if (this.isBlobUrl(this.initialPath())) {
      this._kind.set('blob');
    }
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

  private initialPath(): string {
    if (typeof window === 'undefined' || !window.location) {
      return '/';
    }
    return window.location.pathname;
  }

  private handle(event: RouterEvent): void {
    if (event instanceof NavigationStart) {
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
      if (this.firstNavStarted && this.inFlight.size === 0) {
        this.firstNavComplete = true;
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
