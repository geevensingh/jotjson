/// <reference types="@angular/localize" />

import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';
import { isInMsalSilentIframe, postAuthResponseToParent } from './app/core/auth/msal-iframe-bridge';
// Type-only import: erased at runtime so it does NOT pull
// LoggerService (and the App Insights SDK) into the entry bundle.
// LoggerService itself is loaded dynamically below, only when the
// perf-harness shim is installed.
import type { PerfHarnessEvent } from './app/core/telemetry/logger.service';

declare global {
  interface Window {
    /**
     * Perf-harness shim installed by the Playwright perf suite via
     * `page.addInitScript` BEFORE Angular bootstraps. When present,
     * `main.ts` attaches a sink to `LoggerService` that pushes every
     * emitted telemetry event into `events` and flips `attached =
     * true`. Production never installs the shim, so the seam stays
     * detached. See `perf/browser/util/perf-harness.ts`.
     */
    __jotjsonPerfHarness?: {
      events: PerfHarnessEvent[];
      attached?: boolean;
    };
  }
}

// LEGACY: compensating code for `redirectUri = origin root`. When the
// /blank.html redirect URI migration (issue #230) ships, iframes will
// load /blank.html instead of main.ts and this branch becomes dead
// code - delete it at that time. Until then, this branch keeps the
// silent-refresh iframe from bootstrapping the full SPA and instead
// posts the auth response back to the parent over BroadcastChannel.
// See msal-iframe-bridge.ts.
if (isInMsalSilentIframe()) {
  void postAuthResponseToParent();
} else {
  bootstrapApplication(AppComponent, appConfig)
    .then(async (appRef) => {
      // Perf-harness self-attach (DR-007). Best-effort: production has
      // no harness shim so this block resolves to a no-op. Wrapped in
      // try/catch so any failure (injector lookup error, unexpected
      // harness shape, etc.) cannot block the build-info banner below
      // or the rest of the .then chain.
      try {
        if (typeof window !== 'undefined') {
          const harness = window.__jotjsonPerfHarness;
          if (harness && Array.isArray(harness.events)) {
            // Dynamic import keeps LoggerService (and the App Insights
            // SDK) out of the entry bundle in production, mirroring the
            // lazy-load pattern in AppComponent.ngOnInit. The module URL
            // is the same one AppComponent uses, so the ES module cache
            // returns the same instance and `providedIn: 'root'` resolves
            // to the same singleton from `appRef.injector.get(...)`.
            const { LoggerService } = await import('./app/core/telemetry/logger.service');
            const logger = appRef.injector.get(LoggerService);
            logger.__attachPerfHarnessForTesting((event: PerfHarnessEvent) => {
              harness.events.push(event);
            });
            harness.attached = true;
          }
        }
      } catch {
        // Bootstrap self-attach is best-effort; production has no harness.
      }

      try {
        const { BUILD_INFO } = await import('./generated/build-info');
        const sha = BUILD_INFO.sha;
        const isDev = sha === 'dev';
        const shortSha = isDev ? 'dev' : sha.slice(0, 7);
        const url = isDev || !BUILD_INFO.repoUrl ? '' : ` ${BUILD_INFO.repoUrl}/commit/${sha}`;
        // eslint-disable-next-line no-console
        console.info(`JotJSON v${BUILD_INFO.version} (${shortSha})${url}`);
      } catch {
        // Banner emission is best-effort; never let a failure leak to the
        // bootstrap-error path below.
      }
    })
    .catch((error: unknown) => {
      // Pre-Angular bootstrap failures land here. Persist a sanitized
      // record to sessionStorage so `LoggerService.connect()` can replay
      // it as a `boot.failed` exception once telemetry comes online -
      // assuming Angular itself eventually bootstraps. If it doesn't,
      // there is nothing else we can do from outside the framework.
      try {
        const name = error instanceof Error ? error.name || 'Error' : 'BootError';
        const message =
          error instanceof Error
            ? (error.message ?? '').slice(0, 500)
            : '<non-error thrown at bootstrap>';
        sessionStorage.setItem('jotjson.bootErr', JSON.stringify({ name, message }));
      } catch {
        // sessionStorage may be unavailable (privacy mode); ignore.
      }
      // Always surface to DevTools so dev-time bootstrap failures are
      // discoverable without telemetry.
      // eslint-disable-next-line no-console
      console.error(error);
    });
}
