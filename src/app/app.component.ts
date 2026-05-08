import { afterNextRender, Component, OnInit, PLATFORM_ID, inject, Injector } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { PreferencesNotificationService } from './core/preferences/preferences-notification.service';
import { DocumentDropController } from './core/upload/document-drop-controller.service';
import { LoadingSplashService } from './core/loading-splash/loading-splash.service';
import { NavigationProgressService } from './core/navigation/navigation-progress.service';
import { RouteFocusService } from './core/navigation/route-focus.service';
import { AppUpdateService } from './core/update/app-update.service';
import { LoadingSplashComponent } from './shared/components/loading-splash/loading-splash.component';
import { RouteProgressBarComponent } from './shared/components/route-progress-bar/route-progress-bar.component';

@Component({
  selector: 'app-root',
  imports: [LoadingSplashComponent, RouteProgressBarComponent, RouterOutlet],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit {
  readonly title = 'JotJSON';

  private readonly injector = inject(Injector);

  // Eagerly inject so document drag-drop listeners attach at app start
  // rather than lazily on first Home mount. This ensures off-route drops
  // (on /history, /profile, etc.) are intercepted even if the user has
  // not yet visited Home.
  private readonly dropController = inject(DocumentDropController);

  // Eagerly inject so the router-events subscription is established
  // before the very first NavigationStart fires. The cold-boot deep-link
  // to /s/:slug fires NavigationStart almost immediately after bootstrap;
  // a late subscriber would miss it and the route progress bar would
  // never appear during the resolver wait - exactly the M8 critical
  // path. See also `core/telemetry/route-tracker.ts`, which handles the
  // analogous timing problem for telemetry.
  private readonly navigationProgress = inject(NavigationProgressService);

  // Eagerly inject for the same reason as NavigationProgressService:
  // the splash service must observe the very first NavigationStart so
  // the cold-boot to /s/:slug confirms kind='blob' (the constructor's
  // URL peek already set it), keeps it through the resolver wait, and
  // latches kind=null once the first nav settles.
  private readonly loadingSplash = inject(LoadingSplashService);

  // Eagerly inject so focus-to-<main> behaviour is wired before the
  // first in-app NavigationEnd. Skipping the initial bootstrap nav is
  // built into the service; subsequent transitions get programmatic
  // focus so screen-reader users hear the new page's heading announced.
  private readonly routeFocus = inject(RouteFocusService);

  // Eagerly inject so the conflict-toast subscription is alive before
  // the user can possibly trigger a 412 from PreferencesService. The
  // service subscribes to PreferencesService.events$ in its
  // constructor; if it were lazy, conflict events fired during
  // bootstrap (e.g. cross-tab race during initial sign-in seed) would
  // be missed because Subjects don't replay.
  private readonly preferencesNotifications = inject(PreferencesNotificationService);

  // Eagerly inject so SwUpdate.versionUpdates / .unrecoverable
  // subscriptions wire up in the service's constructor, before any
  // postMessage from the SW can arrive. versionUpdates is not a
  // ReplaySubject; a lazy import would let early VERSION_READY events
  // slip past unobserved on installed PWAs where the SW process
  // survived the previous launch. The constructor is server-platform
  // safe (no window/document access); browser-only side effects are
  // attached lazily inside `initialize()`, called below.
  private readonly appUpdate = inject(AppUpdateService);

  // Captured at construction time (an injection context) so `ngOnInit`
  // can branch on platform without calling `inject()` inside a
  // lifecycle hook (which would throw NG0203).
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  // Remove the pre-bootstrap static splash (`#jot-static-splash` in
  // src/index.html) after the Angular splash has painted on top of
  // it. The static splash is a sibling of `<app-root>` so the
  // prerender pipeline cannot strip it; the trade-off is we have to
  // remove it explicitly once Angular has taken over.
  //
  // `afterNextRender` is browser-only (no-op during SSR), runs after
  // Angular's render phases, and the inner double-rAF defers the
  // removal one full paint past Angular's first commit. This matches
  // the canonical paint-barrier idiom used by HomeComponent and
  // JsonTreeComponent: a single rAF can fire on the same tick as the
  // pending paint, leaving a flash gap; double-rAF guarantees the
  // browser has actually painted the Angular splash before the
  // static splash is detached, so the visual handoff is seamless
  // (both render the identical `.jot-splash` markup).
  private readonly _removeStaticSplash = afterNextRender(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.getElementById('jot-static-splash')?.remove();
      });
    });
  });

  ngOnInit(): void {
    // Skip browser-only side effects during static prerender. The
    // server platform has no `window`, no `localStorage`, no service
    // worker, and no SDK targets to talk to - and the lazy chunks
    // below all assume one of those. The browser bootstrap on the
    // hydrated client re-runs this same `ngOnInit`, so nothing is
    // permanently lost.
    if (!this.isBrowser) {
      return;
    }
    // Note: returning-redirect handling and `AuthService.userSignal`
    // hydration are driven from `provideAppInitializer` in `app.config.ts`
    // so the router waits for MSAL before activating routes (otherwise
    // resolvers race the bearer token).
    //
    // Lazy-load telemetry so the App Insights SDK stays out of the
    // initial bundle. There is no user-visible work happening in the
    // first few seconds of a page load, so a deferred load is fine.
    // The SW update listener (`AppUpdateService`) is NOT lazy -- it is
    // injected as a normal field above so its `versionUpdates`
    // subscription wires up in the constructor and can't miss an early
    // `VERSION_READY` postMessage from the SW.
    void Promise.all([
      import('./core/telemetry/logger.service'),
      import('./core/telemetry/route-tracker'),
      import('../generated/build-info'),
    ]).then(async ([loggerModule, trackerModule, buildInfoModule]) => {
      const routeTracker = this.injector.get(trackerModule.RouteTracker);
      // Start subscribing to NavigationEnd before connect() resolves so
      // the bootstrap navigation is captured even though it fires
      // before telemetry is ready.
      routeTracker.start();
      const loggerService = this.injector.get(loggerModule.LoggerService);
      loggerService.event(
        'app.boot',
        {
          version: buildInfoModule.BUILD_INFO.version,
          sha: buildInfoModule.BUILD_INFO.sha,
          branch: buildInfoModule.BUILD_INFO.branch,
          buildNumber: buildInfoModule.BUILD_INFO.buildNumber,
        },
        undefined,
      );
      await loggerService.connect();
      routeTracker.flushPending();
      // Keep web-vitals in a lazy chunk; it emits one webVitals event on pagehide.
      void import('./core/telemetry/web-vitals').then(({ initWebVitals }) => {
        return initWebVitals(
          loggerService,
          buildInfoModule.BUILD_INFO.version,
          buildInfoModule.BUILD_INFO.buildNumber,
        );
      });
    });
    this.appUpdate.initialize();
  }
}
