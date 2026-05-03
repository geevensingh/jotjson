import { Component, OnInit, inject, Injector } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { DocumentDropController } from './core/upload/document-drop-controller.service';
import { NavigationProgressService } from './core/navigation/navigation-progress.service';
import { RouteProgressBarComponent } from './shared/components/route-progress-bar/route-progress-bar.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouteProgressBarComponent],
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

  ngOnInit(): void {
    // Note: returning-redirect handling and `AuthService.userSignal`
    // hydration are driven from `provideAppInitializer` in `app.config.ts`
    // so the router waits for MSAL before activating routes (otherwise
    // resolvers race the bearer token).
    //
    // Lazy-load telemetry + SW update listener so the App Insights SDK
    // and Material snackbar stay out of the initial bundle. There is
    // no user-visible work happening in the first few seconds of a
    // page load, so a deferred load is fine.
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
    void import('./core/update/app-update.service').then(({ AppUpdateService }) => {
      this.injector.get(AppUpdateService).initialize();
    });
  }
}
