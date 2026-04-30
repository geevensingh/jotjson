import { Injectable, computed, inject, signal } from '@angular/core';
import {
  AccountInfo,
  AuthenticationResult,
  EventMessage,
  EventType,
  InteractionRequiredAuthError,
  IPublicClientApplication
} from '@azure/msal-browser';
import { MsalBroadcastService } from '@azure/msal-angular';
import { filter } from 'rxjs/operators';
import { environment } from '../../../environments/environment';
import { AuthUser } from './auth-user';
import { MSAL_INSTANCE } from './msal-instance';
import { LoggerService } from '../telemetry/logger.service';
import { TelemetryService } from '../telemetry/telemetry.service';

/**
 * Entry point for identity in the app.
 *
 * Exposes:
 * - `user()` - signal of the current `AuthUser` or `null`.
 * - `isSignedIn()` - computed derived signal.
 * - `isConfigured` - whether the environment has real auth config
 *   (non-empty clientId). False in local dev with empty config, and the
 *   toolbar disables sign-in in that case.
 * - `signIn()` / `signOut()` - interactive redirect flows.
 * - `acquireTokenSilent()` - silent-only; returns `null` on failure.
 *
 * Redirect handling is driven by `AppComponent` via
 * `initializeFromRedirect()`, which must be called once on app start.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly msal = inject<IPublicClientApplication>(MSAL_INSTANCE);
  private readonly broadcast = inject(MsalBroadcastService, { optional: true });
  private readonly telemetry = inject(TelemetryService);
  private readonly logger = inject(LoggerService);

  private readonly userSignal = signal<AuthUser | null>(null);
  private initPromise: Promise<void> | null = null;

  /**
   * True when `environment.devAuth.enabled` is set AND the configured
   * `userId` matches the backend validator regex. Fail-closed: a typo'd
   * userId (e.g. uppercase, spaces) disables dev mode and falls back to
   * MSAL-only behavior, with a one-shot warn from the constructor. This
   * matters because a half-enabled state - SPA thinks it's signed in,
   * backend 401s every request - is a confusing failure mode.
   */
  private readonly devMode = AuthService.computeDevMode();
  private static computeDevMode(): boolean {
    const cfg = environment.devAuth;
    if (!cfg?.enabled) return false;
    return /^[a-z0-9_-]{1,64}$/.test(cfg.userId ?? '');
  }

  readonly user = this.userSignal.asReadonly();
  readonly isSignedIn = computed(() => this.userSignal() !== null);
  readonly isConfigured = !!environment.auth.clientId || this.devMode;

  constructor() {
    // If dev-auth was requested but the userId is invalid, warn so the
    // developer can fix their environment.ts. We log here (not in
    // `computeDevMode`) because LoggerService is only available after DI.
    const cfg = environment.devAuth;
    if (cfg?.enabled && !this.devMode) {
      this.logger.warn('auth.devMode.misconfigured', {
        reason: 'userId-format'
      });
    }
    // Subscribe to MSAL events so the user signal stays in sync with
    // sign-in/sign-out/acquireToken outcomes, without callers having to
    // manually refresh. Skipped entirely in dev mode so a stray broadcast
    // event cannot clobber the synthetic signed-in state.
    if (!this.devMode) {
      this.broadcast?.msalSubject$
        .pipe(filter((m: EventMessage) => !!m))
        .subscribe((msg: EventMessage) => {
          if (
            msg.eventType === EventType.LOGIN_SUCCESS ||
            msg.eventType === EventType.ACQUIRE_TOKEN_SUCCESS ||
            msg.eventType === EventType.HANDLE_REDIRECT_END
          ) {
            this.refreshFromCache();
          }
          if (msg.eventType === EventType.LOGOUT_SUCCESS) {
            this.setCurrentUser(null);
          }
        });
    }
  }

  /**
   * Process any redirect response left over from a previous navigation and
   * prime the user signal from the MSAL account cache. Call once from
   * `AppComponent.ngOnInit`.
   */
  initializeFromRedirect(): Promise<void> {
    if (this.devMode) {
      this.hydrateDevUserFromStorage();
      return Promise.resolve();
    }
    if (!this.isConfigured) {
      this.userSignal.set(null);
      return Promise.resolve();
    }
    return this.ensureInitialized()
      .then(() => this.msal.handleRedirectPromise())
      .then((result: AuthenticationResult | null) => {
        if (result?.account) {
          this.msal.setActiveAccount(result.account);
        }
        // Populate the user signal directly from the MSAL cache. We used to
        // also wait on `MsalBroadcastService.inProgress$ === None`, but that
        // subject only advances when callers drive MSAL through
        // `MsalService`; we talk to the browser MSAL instance directly, so
        // on a plain reload the broadcast stays in `Startup` forever and the
        // UI would render as signed-out even though the cache has an
        // account.
        this.refreshFromCache();
      })
      .catch(() => {
        // Swallow: MSAL logs internally; a failed redirect should not crash
        // the app. The user can retry via the sign-in button.
      });
  }

  signIn(): void {
    if (this.devMode) {
      try {
        localStorage.setItem(DEV_AUTH_STORAGE_KEY, '1');
      } catch {
        // Ignore quota / disabled-storage errors; dev signIn is best-effort.
      }
      this.setCurrentUser(this.devPersona());
      return;
    }
    if (!this.isConfigured) return;
    void this.ensureInitialized().then(() =>
      this.msal.loginRedirect({
        scopes: environment.auth.scopes,
        prompt: 'select_account'
      })
    );
  }

  async signOut(): Promise<void> {
    if (this.devMode) {
      try {
        localStorage.removeItem(DEV_AUTH_STORAGE_KEY);
      } catch {
        // Ignore quota / disabled-storage errors.
      }
      this.setCurrentUser(null);
      return;
    }
    if (!this.isConfigured) return;
    await this.ensureInitialized();
    const account = this.msal.getActiveAccount() ?? this.msal.getAllAccounts()[0];

    // Populate `id_token_hint` on the logout URL so the IdP can skip the
    // "which account do you want to sign out of?" confirmation. If MSAL's
    // cached `account.idToken` is empty (cache race / expiration), do a
    // silent refresh first - `AuthenticationResult.idToken` is guaranteed
    // non-empty on success.
    //
    // NOTE: Entra External ID (ciamlogin.com) currently ignores
    // `id_token_hint` and always renders the picker. Classic B2C and
    // workforce Entra ID both honor it. We send the hint anyway so this
    // works the day CIAM catches up, without any code change here.
    let idTokenHint = account?.idToken;
    if (!idTokenHint && account) {
      try {
        const result = await this.msal.acquireTokenSilent({
          account,
          scopes: environment.auth.scopes
        });
        idTokenHint = result.idToken;
      } catch {
        // Silent acquire failed (interaction required, offline, token
        // revoked). Fall through without idTokenHint; sign-out still
        // completes, just with the picker.
      }
    }

    await this.msal.logoutRedirect({
      account,
      idTokenHint,
      logoutHint: account?.loginHint,
      postLogoutRedirectUri: environment.auth.postLogoutRedirectUri
    });
  }

  /**
   * Attempt to acquire an access token silently (from the MSAL cache or via
   * a hidden iframe). Never triggers an interactive flow; returns `null` on
   * any failure so callers (notably the HTTP interceptor) can degrade
   * gracefully.
   *
   * In dev mode, returns the synthetic `dev:<userId>` token when signed in
   * (the existing interceptor wraps it in `Bearer ...` and attaches under
   * `X-Jotjson-Authorization`), or `null` when signed out.
   */
  async acquireTokenSilent(): Promise<string | null> {
    if (this.devMode) {
      if (!this.isSignedIn()) return null;
      return `dev:${environment.devAuth!.userId}`;
    }
    if (!this.isConfigured) return null;
    await this.ensureInitialized();
    const account = this.msal.getActiveAccount() ?? this.msal.getAllAccounts()[0];
    if (!account) return null;
    try {
      const result = await this.msal.acquireTokenSilent({
        account,
        scopes: environment.auth.scopes
      });
      return result.accessToken || null;
    } catch (error) {
      if (error instanceof InteractionRequiredAuthError) {
        return null;
      }
      return null;
    }
  }

  /**
   * Memoized `msal.initialize()` call. MSAL v5 requires this before any other
   * API and throws `BrowserAuthError: uninitialized_public_client_application`
   * otherwise. The promise is cached so repeated calls are no-ops.
   */
  private ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = Promise.resolve(this.msal.initialize()).catch((error) => {
        // If initialize fails we clear the cache so a subsequent call can
        // retry rather than replaying the rejection forever.
        this.initPromise = null;
        throw error;
      });
    }
    return this.initPromise;
  }

  private refreshFromCache(): void {
    const account =
      this.msal.getActiveAccount() ?? this.msal.getAllAccounts()[0] ?? null;
    const user = account ? this.toAuthUser(account) : null;
    this.setCurrentUser(user);
  }

  /**
   * Single source of truth for updating the user signal AND telemetry
   * identity together. Both real-MSAL paths (login/logout/acquire-token
   * events, redirect hydration) and dev-auth paths (signIn/signOut,
   * localStorage hydration) call here so telemetry never lags state.
   */
  private setCurrentUser(user: AuthUser | null): void {
    this.userSignal.set(user);
    // Telemetry: identify by Entra `oid` (or dev-user id) only - never email.
    this.telemetry.setUser(user ? user.id : null);
  }

  private hydrateDevUserFromStorage(): void {
    let signedIn = false;
    try {
      signedIn = localStorage.getItem(DEV_AUTH_STORAGE_KEY) === '1';
    } catch {
      // Disabled-storage / privacy mode - treat as signed out.
    }
    this.setCurrentUser(signedIn ? this.devPersona() : null);
  }

  private devPersona(): AuthUser {
    const cfg = environment.devAuth!;
    return {
      id: cfg.userId,
      displayName: cfg.displayName,
      ...(cfg.email !== undefined ? { email: cfg.email } : {})
    };
  }

  private toAuthUser(a: AccountInfo): AuthUser {
    const claims = (a.idTokenClaims ?? {}) as {
      oid?: string;
      sub?: string;
      name?: string;
      email?: string;
      preferred_username?: string;
    };
    const id = claims.oid || claims.sub || a.homeAccountId;
    const displayName = claims.name || a.username || 'User';
    const email = claims.email || claims.preferred_username || undefined;
    return { id, displayName, email };
  }
}

const DEV_AUTH_STORAGE_KEY = 'jotjson.devAuth.signedIn';
