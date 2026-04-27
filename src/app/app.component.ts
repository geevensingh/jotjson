import { Component, OnInit, inject, Injector } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit {
  readonly title = 'JotJSON';

  private readonly injector = inject(Injector);

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
      import('./core/telemetry/route-tracker')
    ]).then(async ([logger, tracker]) => {
      const routeTracker = this.injector.get(tracker.RouteTracker);
      // Start subscribing to NavigationEnd before connect() resolves so
      // the bootstrap navigation is captured even though it fires
      // before telemetry is ready.
      routeTracker.start();
      await this.injector.get(logger.LoggerService).connect();
      routeTracker.flushPending();
    });
    void import('./core/update/app-update.service').then(({ AppUpdateService }) => {
      this.injector.get(AppUpdateService).initialize();
    });
  }
}

