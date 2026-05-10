import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs/operators';
import { LoggerService } from '../telemetry/logger.service';
import { TelemetryService } from '../telemetry/telemetry.service';

const MIN_CHECK_INTERVAL_MS = 30_000;
const AUTO_APPLIED_STORAGE_KEY = 'jotjson.update.autoApplied';

type UpdateTrigger = 'snackbar' | 'autoApply';

/**
 * Reacts to Angular service worker events so that a deploy-in-progress
 * never leaves the user on a broken page, and an installed PWA boots
 * straight into the latest deployed version on cold launch.
 *
 * Two-phase wiring:
 *
 * - The constructor subscribes to `SwUpdate.versionUpdates` and
 *   `SwUpdate.unrecoverable` immediately. These are RxJS `Subject`s
 *   (not `ReplaySubject`s), so a late subscriber loses any prior
 *   emissions; the SW can postMessage `VERSION_READY` between
 *   bootstrap and the first user-facing render, so the subscription
 *   must exist before the SPA can yield to the microtask queue. This
 *   is why `AppComponent` injects this service *eagerly* (as a
 *   normal field), not via a lazy `import()` from inside `ngOnInit`.
 *   The constructor is server-platform safe: it touches only
 *   injection and observable subscription, no `window` / `document` /
 *   `sessionStorage`.
 *
 * - `initialize()`, called once from `AppComponent.ngOnInit` after
 *   the `isPlatformBrowser` gate, attaches the browser-only side
 *   effects: `pointerdown` / `keydown` / `touchstart` listeners that
 *   flip a `userInteracted` flag, `visibilitychange` and `focus`
 *   listeners that proactively call `swUpdate.checkForUpdate()`, and
 *   one immediate `checkForUpdate()` to catch the "SW process
 *   survived across PWA relaunch" case where Angular's
 *   registration-time check doesn't re-fire.
 *
 * Update flow on `VERSION_READY`:
 *
 * - **Cold-launch silent auto-apply.** If the user hasn't interacted
 *   yet AND the per-session `sessionStorage` loop guard
 *   (`jotjson.update.autoApplied`) is unset, claim the guard and
 *   call `activateUpdate()` + reload silently (no snackbar). At most
 *   one silent apply per browser session.
 *
 * - **Mid-session.** Otherwise, surface a non-dismissing Material
 *   snackbar ("A new version of JotJSON is available.") with a
 *   Reload action. Users can keep working; the next reload activates
 *   the new version.
 *
 * `update.applied` carries `trigger: 'snackbar' | 'autoApply'` so
 * the two paths are queryable separately in telemetry.
 *
 * On `unrecoverable` the service detected that its cached manifest
 * refers to files the origin no longer serves (typical mid-deploy
 * CDN race). Hard-reload with a cache-busting query so the browser
 * bypasses any cached shell and the SW re-registers against the
 * current build.
 *
 * The service is a no-op when the SW is disabled (dev mode, server
 * prerender, or browsers without SW support) so unit / integration
 * tests don't need extra wiring.
 *
 * See `DESIGN_SPEC.md` -> Progressive Web App -> Update prompt.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  private readonly swUpdate = inject(SwUpdate, { optional: true });
  private readonly snack = inject(MatSnackBar);
  private readonly logger = inject(LoggerService);
  private readonly telemetry = inject(TelemetryService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private initialized = false;
  private userInteracted = false;
  private lastCheckStartedAt = 0;
  private listenerAbort?: AbortController;

  constructor() {
    // `SwUpdate` is only registered through `provideServiceWorker(...)` in
    // `app.config.ts`, which is browser-only - the server prerender
    // bootstrap (`app.config.server.ts`) deliberately omits it. Inject
    // optionally so the eagerly-constructed service can no-op cleanly
    // during prerender.
    if (!this.swUpdate?.isEnabled) return;
    this.swUpdate.versionUpdates
      .pipe(filter((evt): evt is VersionReadyEvent => evt.type === 'VERSION_READY'))
      .subscribe(() => this.onVersionReady());
    this.swUpdate.unrecoverable.subscribe((event) => {
      this.logger.warn('update.unrecoverable', { reason: event.reason });
      if (this.isBrowser) this.hardReload();
    });
  }

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.isBrowser || !this.swUpdate?.isEnabled) return;

    this.listenerAbort = new AbortController();
    const { signal } = this.listenerAbort;

    const markInteracted = (): void => {
      this.userInteracted = true;
    };
    const interactionOpts: AddEventListenerOptions = {
      once: true,
      passive: true,
      signal,
    };
    document.addEventListener('pointerdown', markInteracted, interactionOpts);
    document.addEventListener('keydown', markInteracted, interactionOpts);
    document.addEventListener('touchstart', markInteracted, interactionOpts);

    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'visible') {
          void this.maybeCheck('visibility');
        }
      },
      { signal },
    );
    window.addEventListener(
      'focus',
      () => {
        void this.maybeCheck('focus');
      },
      { signal },
    );

    void this.maybeCheck('init');
  }

  /**
   * Detach all browser listeners installed by `initialize()`. Test-only
   * seam -- production has no shutdown path because the service is
   * `providedIn: 'root'`.
   */
  __disposeForTesting(): void {
    this.listenerAbort?.abort();
    this.listenerAbort = undefined;
    this.initialized = false;
  }

  private onVersionReady(): void {
    if (!this.isBrowser) return;
    if (this.userInteracted || !this.tryClaimAutoApplyGuard()) {
      this.promptReload();
      return;
    }
    void this.activateAndReload('autoApply');
  }

  private promptReload(): void {
    const ref = this.snack.open(
      $localize`:@@update.available.message:A new version of JotJSON is available.`,
      $localize`:@@update.available.action:Reload`,
      { duration: 0 },
    );
    ref.onAction().subscribe(() => {
      void this.activateAndReload('snackbar');
    });
  }

  private async activateAndReload(trigger: UpdateTrigger): Promise<void> {
    if (!this.swUpdate) return;
    try {
      await this.swUpdate.activateUpdate();
    } catch (error) {
      // Reload anyway - the fresh fetch will re-run the install flow and
      // any partial cache will be discarded.
      this.logger.warn('update.activate.failed');
      void error;
      this.reload();
      return;
    }
    this.logger.event('update.applied', { trigger }, undefined);
    await this.telemetry.flush();
    this.reload();
  }

  private async maybeCheck(reason: 'init' | 'visibility' | 'focus'): Promise<void> {
    void reason;
    if (!this.swUpdate) return;
    const now = Date.now();
    if (now - this.lastCheckStartedAt < MIN_CHECK_INTERVAL_MS) return;
    // Set the timestamp BEFORE awaiting so concurrent triggers (e.g.
    // visibilitychange + focus arriving within a few ms of each other on
    // PWA window restore) can't race two in-flight checks.
    this.lastCheckStartedAt = now;
    try {
      await this.swUpdate.checkForUpdate();
    } catch (error) {
      // Network errors are transient and self-recovering: the next
      // visibility / focus event retries. No telemetry id - this is a
      // probe, not an actionable failure.
      void error;
    }
  }

  /**
   * Atomically claim the per-session silent-apply slot. Returns true
   * iff this caller may proceed with a silent auto-apply; false when
   * the slot is already claimed (loop guard) or storage access throws
   * (private mode / disabled storage), in which case the caller falls
   * back to the snackbar.
   */
  private tryClaimAutoApplyGuard(): boolean {
    try {
      if (window.sessionStorage.getItem(AUTO_APPLIED_STORAGE_KEY) === '1') {
        return false;
      }
      window.sessionStorage.setItem(AUTO_APPLIED_STORAGE_KEY, '1');
      return true;
    } catch {
      return false;
    }
  }

  private hardReload(): void {
    // Cache-busting query forces the browser to bypass any cached shell
    // and re-register the SW against the current build.
    const url = new URL(window.location.href);
    url.searchParams.set('_swreload', Date.now().toString(36));
    this.replaceLocation(url.toString());
  }

  /** Wrapped for tests. */
  protected reload(): void {
    window.location.reload();
  }

  /** Wrapped for tests. */
  protected replaceLocation(url: string): void {
    window.location.replace(url);
  }
}
