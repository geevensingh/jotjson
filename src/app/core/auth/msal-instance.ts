import { InjectionToken } from '@angular/core';
import {
  IPublicClientApplication,
  PublicClientApplication,
  LogLevel
} from '@azure/msal-browser';
import { environment } from '../../../environments/environment';

/**
 * DI token for the MSAL `IPublicClientApplication`. Using a token rather than
 * depending on a concrete class makes the service trivial to mock in tests
 * (provide a fake client that records calls and returns canned responses).
 */
export const MSAL_INSTANCE = new InjectionToken<IPublicClientApplication>(
  'MSAL_INSTANCE'
);

/**
 * Factory wrapper around MSAL browser's `PublicClientApplication`.
 *
 * Configuration is pulled from `environment.auth`, which is populated at
 * build time (dev = empty placeholders; prod = values injected by CI from
 * repository secrets). If the clientId is empty we still return a valid
 * instance so the app bootstraps cleanly in local-dev-without-tenant mode;
 * the sign-in button is simply disabled by the AuthService in that case.
 */
export function createMsalInstance(): IPublicClientApplication {
  const { clientId, authority, knownAuthorities, redirectUri, postLogoutRedirectUri } =
    environment.auth;

  return new PublicClientApplication({
    auth: {
      clientId,
      authority: authority || undefined,
      knownAuthorities,
      redirectUri,
      postLogoutRedirectUri
    },
    cache: {
      // Session cache: cleared on tab close. Safer default than localStorage
      // for a public-internet SPA; we trade some "remember me" UX for a
      // shorter window of exposure for cached tokens.
      cacheLocation: 'sessionStorage'
    },
    system: {
      loggerOptions: {
        loggerCallback: () => void 0,
        logLevel: LogLevel.Warning,
        piiLoggingEnabled: false
      }
    }
  });
}
