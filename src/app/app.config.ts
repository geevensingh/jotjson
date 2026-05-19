import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  ApplicationConfig,
  EnvironmentProviders,
  ErrorHandler,
  Provider,
  inject,
  isDevMode,
  provideAppInitializer,
  provideZoneChangeDetection,
} from '@angular/core';
import { MAT_BUTTON_TOGGLE_DEFAULT_OPTIONS } from '@angular/material/button-toggle';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { MsalBroadcastService, MsalService } from '@azure/msal-angular';

import { TitleStrategy } from '@angular/router';
import { routes } from './app.routes';
import { AuthService } from './core/auth/auth.service';
import { MSAL_INSTANCE, createMsalInstance } from './core/auth/msal-instance';
import { provideEnvIndicatorInitializer } from './core/env/env-indicator.initializer';
import { EnvPrefixedTitleStrategy } from './core/env/env-prefixed-title-strategy';
import { authInterceptor } from './core/interceptors/auth.interceptor';
import { errorInterceptor } from './core/interceptors/error.interceptor';
import { TelemetryErrorHandler } from './core/telemetry/error-handler';

/**
 * Providers shared between browser bootstrap (`app.config.ts`) and
 * server prerender bootstrap (`app.config.server.ts`). Anything here
 * MUST be safe to construct on the Node platform-server: no `window`,
 * `document`, `localStorage`, `matchMedia`, `navigator`, etc. at
 * construction time.
 *
 * Browser-only providers (MSAL, service worker, AuthService
 * initializer) live in {@link appConfig}'s tail. The server config
 * supplies its own equivalents (or no-op stubs) where needed.
 */
export const sharedProviders: Array<Provider | EnvironmentProviders> = [
  provideZoneChangeDetection({ eventCoalescing: true }),
  provideRouter(
    routes,
    withComponentInputBinding(),
    withInMemoryScrolling({ scrollPositionRestoration: 'enabled', anchorScrolling: 'enabled' }),
  ),
  provideHttpClient(withInterceptors([authInterceptor, errorInterceptor])),
  provideAnimationsAsync(),
  { provide: ErrorHandler, useClass: TelemetryErrorHandler },
  // Custom TitleStrategy that prefixes every route-declared title
  // with `[<env-label>] ` on nonprod / preview / dev / unknown
  // hosts. Lives in `sharedProviders` so prerender goes through the
  // same path -- on server platform, EnvLabelService returns 'prod'
  // and withPrefix() is identity, so SSR output is unchanged.
  { provide: TitleStrategy, useClass: EnvPrefixedTitleStrategy },
  // Hide the Material 17+ selection-indicator checkmark on every
  // mat-button-toggle-group. Selection is already conveyed by the
  // highlighted background, and the indicator wastes ~24px per
  // segment in the toolbar's right cluster. aria-checked on the
  // inner <button> still announces selection for screen readers,
  // so this is purely a visual change.
  {
    provide: MAT_BUTTON_TOGGLE_DEFAULT_OPTIONS,
    useValue: {
      hideSingleSelectionIndicator: true,
      hideMultipleSelectionIndicator: true,
    },
  },
];

export const appConfig: ApplicationConfig = {
  providers: [
    ...sharedProviders,
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      // SSR-heavy apps commonly leave the stable-registration timeout at
      // 30000ms, which delayed the first checkForUpdate() long enough that
      // users closing the tab inside that window never saw new builds. Use
      // 5000ms to close that gap while still waiting for ApplicationRef
      // stability so SW registration does not race initial rendering. This is
      // defense in depth; the primary stale-version fix is no-store on
      // /ngsw.json (see staticwebapp.config.json, issue #167, and plan.md).
      registrationStrategy: 'registerWhenStable:5000',
    }),
    // MSAL wiring - deliberately NOT using `MsalRedirectComponent` or the
    // `MSAL_GUARD_CONFIG`/`MSAL_INTERCEPTOR_CONFIG` bundles, which assume an
    // NgModule bootstrap. Standalone apps drive redirect handling themselves
    // via `AuthService.initializeFromRedirect()`, run from the
    // `provideAppInitializer` below so the router waits for MSAL.
    { provide: MSAL_INSTANCE, useFactory: createMsalInstance },
    MsalService,
    MsalBroadcastService,
    // Env-indicator favicon swap. Runs BEFORE the auth initializer so MSAL's
    // `handleRedirectPromise()` (which can take hundreds of ms on a
    // returning redirect) does not delay the visual indicator. Synchronous
    // and non-blocking; the inline pre-bootstrap script in `src/index.html`
    // does the same swap earlier (this initializer is the Angular-side
    // idempotent safety net).
    provideEnvIndicatorInitializer(),
    // Block Angular bootstrap until MSAL has processed any returning redirect
    // and primed `AuthService.userSignal` from its account cache. Without
    // this, the router begins activating routes (and resolvers fire HTTP
    // requests) before `isSignedIn()` flips true, so the auth interceptor
    // skips attaching the bearer token on the first request - notably the
    // share-link `GET /api/blobs/:slug`, which means the server cannot
    // record the `viewed` history entry for the visitor. Errors are already
    // swallowed inside `initializeFromRedirect()`, and it short-circuits
    // when MSAL is unconfigured (empty clientId in dev), so blocking
    // bootstrap on it is safe.
    provideAppInitializer(() => inject(AuthService).initializeFromRedirect()),
  ],
};
