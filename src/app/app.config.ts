import {
  ApplicationConfig,
  ErrorHandler,
  inject,
  isDevMode,
  provideAppInitializer,
  provideZoneChangeDetection
} from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideServiceWorker } from '@angular/service-worker';
import { MsalBroadcastService, MsalService } from '@azure/msal-angular';
import { MAT_BUTTON_TOGGLE_DEFAULT_OPTIONS } from '@angular/material/button-toggle';

import { routes } from './app.routes';
import { authInterceptor } from './core/interceptors/auth.interceptor';
import { errorInterceptor } from './core/interceptors/error.interceptor';
import { AuthService } from './core/auth/auth.service';
import { MSAL_INSTANCE, createMsalInstance } from './core/auth/msal-instance';
import { TelemetryErrorHandler } from './core/telemetry/error-handler';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'enabled', anchorScrolling: 'enabled' })
    ),
    provideHttpClient(withInterceptors([authInterceptor, errorInterceptor])),
    provideAnimationsAsync(),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000'
    }),
    { provide: ErrorHandler, useClass: TelemetryErrorHandler },
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
        hideMultipleSelectionIndicator: true
      }
    },
    // MSAL wiring - deliberately NOT using `MsalRedirectComponent` or the
    // `MSAL_GUARD_CONFIG`/`MSAL_INTERCEPTOR_CONFIG` bundles, which assume an
    // NgModule bootstrap. Standalone apps drive redirect handling themselves
    // via `AuthService.initializeFromRedirect()`, run from the
    // `provideAppInitializer` below so the router waits for MSAL.
    { provide: MSAL_INSTANCE, useFactory: createMsalInstance },
    MsalService,
    MsalBroadcastService,
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
    provideAppInitializer(() => inject(AuthService).initializeFromRedirect())
  ]
};

