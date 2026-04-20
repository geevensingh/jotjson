import { ApplicationConfig, provideZoneChangeDetection, isDevMode } from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideServiceWorker } from '@angular/service-worker';
import { MsalBroadcastService, MsalService } from '@azure/msal-angular';

import { routes } from './app.routes';
import { authInterceptor } from './core/interceptors/auth.interceptor';
import { errorInterceptor } from './core/interceptors/error.interceptor';
import { MSAL_INSTANCE, createMsalInstance } from './core/auth/msal-instance';

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
    // MSAL wiring - deliberately NOT using `MsalRedirectComponent` or the
    // `MSAL_GUARD_CONFIG`/`MSAL_INTERCEPTOR_CONFIG` bundles, which assume an
    // NgModule bootstrap. Standalone apps drive redirect handling themselves
    // from `AppComponent.ngOnInit` via `AuthService.initializeFromRedirect()`.
    { provide: MSAL_INSTANCE, useFactory: createMsalInstance },
    MsalService,
    MsalBroadcastService
  ]
};

