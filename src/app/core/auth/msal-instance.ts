import {
  IPublicClientApplication,
  PublicClientApplication,
  LogLevel
} from '@azure/msal-browser';
import { MSAL_INSTANCE } from '@azure/msal-angular';
import { environment } from '../../../environments/environment';

/**
 * Re-export msal-angular's `MSAL_INSTANCE` token so application code has a
 * single import source. We deliberately do NOT define our own token - the
 * built-in `MsalService` and `MsalBroadcastService` both inject
 * `@azure/msal-angular`'s `MSAL_INSTANCE`, and having two tokens with the
 * same debug name causes a NullInjectorError for the msal-angular services.
 */
export { MSAL_INSTANCE };

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
      // localStorage so sign-in persists across tab close and new tabs, which
      // matches typical SPA "stay signed in" UX. MSAL still enforces token
      // expiry and relies on the silent/interactive refresh flow; the cached
      // material is refresh-token-equivalent, not a long-lived password.
      cacheLocation: 'localStorage'
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
