import { ApplicationConfig, mergeApplicationConfig } from '@angular/core';
import { provideServerRendering, withRoutes } from '@angular/ssr';
import { MsalBroadcastService, MsalService } from '@azure/msal-angular';
import {
  AccountInfo,
  AuthenticationResult,
  EventMessage,
  IPublicClientApplication,
} from '@azure/msal-browser';
import { Subject } from 'rxjs';
import { sharedProviders } from './app.config';
import { serverRoutes } from './app.routes.server';
import { MSAL_INSTANCE } from './core/auth/msal-instance';

/**
 * Server-only stub for `IPublicClientApplication`. The real MSAL
 * `PublicClientApplication` constructor reads `localStorage` and
 * `window.crypto` eagerly, so it cannot be constructed during static
 * prerender. The stub satisfies the type for any code that captures
 * `MSAL_INSTANCE` during DI; methods that get called are no-ops or
 * resolve to "no account".
 *
 * Static prerender of `/` and `/404` does not trigger any sign-in
 * flow, so only `handleRedirectPromise()`, `getActiveAccount()`,
 * `getAllAccounts()`, and `addEventCallback()` are realistically
 * reached - all return safe defaults below. Anything else falls
 * through to the Proxy's no-op trap so Angular's standard cleanup
 * hooks (`ngOnDestroy`, `destroy`) on the injected instance do not
 * blow up the prerender.
 */
function createMsalServerStub(): IPublicClientApplication {
  const noActiveAccount = (): AccountInfo | null => null;
  const noAccounts = (): AccountInfo[] => [];
  const handleRedirectPromise = (): Promise<AuthenticationResult | null> => Promise.resolve(null);
  const initialize = (): Promise<void> => Promise.resolve();
  const setActiveAccount = (): void => {
    // no-op
  };
  const addEventCallback = (): string => 'server-stub-event-callback';
  const removeEventCallback = (): void => {
    // no-op
  };
  const enableAccountStorageEvents = (): void => {
    // no-op
  };
  const disableAccountStorageEvents = (): void => {
    // no-op
  };
  const noop = (): void => {
    // no-op for any unknown method (lifecycle hooks, etc.)
  };
  // Cast through unknown is required because IPublicClientApplication has
  // ~30 methods and we only need a handful for the prerender path.
  // Unknown methods route through the no-op trap below so that Angular's
  // own teardown hooks (ngOnDestroy/destroy) on this DI-tracked instance
  // do not throw mid-prerender.
  const stub = new Proxy(
    {
      initialize,
      handleRedirectPromise,
      getActiveAccount: noActiveAccount,
      getAllAccounts: noAccounts,
      setActiveAccount,
      addEventCallback,
      removeEventCallback,
      enableAccountStorageEvents,
      disableAccountStorageEvents,
    },
    {
      get(target, prop, receiver) {
        if (prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        return noop;
      },
    },
  );
  return stub as unknown as IPublicClientApplication;
}

/**
 * Server-only stub for `MsalService`. The real service eagerly
 * subscribes to MSAL events; on server we just need it to satisfy DI.
 */
class MsalServiceServerStub {
  // Match enough of the public surface that AuthService and other
  // potential injectees see something type-compatible. None of these
  // methods are reached during prerender of the prerendered routes.
  acquireTokenSilent(): never {
    throw new Error('MsalService.acquireTokenSilent must not be called during prerender');
  }
  loginRedirect(): never {
    throw new Error('MsalService.loginRedirect must not be called during prerender');
  }
  logoutRedirect(): never {
    throw new Error('MsalService.logoutRedirect must not be called during prerender');
  }
  handleRedirectObservable(): never {
    throw new Error('MsalService.handleRedirectObservable must not be called during prerender');
  }
  instance: IPublicClientApplication = createMsalServerStub();
}

/**
 * Server-only stub for `MsalBroadcastService`. AuthService injects
 * this with `{ optional: true }` and only subscribes to `msalSubject$`,
 * so an empty Subject is sufficient to keep the constructor inert.
 */
class MsalBroadcastServiceServerStub {
  readonly msalSubject$ = new Subject<EventMessage>().asObservable();
  readonly inProgress$ = new Subject<unknown>().asObservable();
}

const serverOnlyConfig: ApplicationConfig = {
  providers: [
    provideServerRendering(withRoutes(serverRoutes)),
    // Override MSAL providers with server-safe stubs. Any other
    // browser-only provider (provideServiceWorker,
    // provideAppInitializer for AuthService.initializeFromRedirect)
    // is intentionally NOT in `sharedProviders`, so it never reaches
    // the server bootstrap.
    { provide: MSAL_INSTANCE, useFactory: createMsalServerStub },
    { provide: MsalService, useClass: MsalServiceServerStub },
    { provide: MsalBroadcastService, useClass: MsalBroadcastServiceServerStub },
  ],
};

/**
 * Composed configuration used by `main.server.ts`. Built from the
 * platform-shared providers plus server-specific overrides; keeps the
 * browser-only providers (service worker, MSAL real instance,
 * AuthService initializer) out of the server bootstrap entirely.
 */
export const config = mergeApplicationConfig(
  { providers: sharedProviders } satisfies ApplicationConfig,
  serverOnlyConfig,
);
