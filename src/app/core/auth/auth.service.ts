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

  private readonly userSignal = signal<AuthUser | null>(null);
  private initPromise: Promise<void> | null = null;

  readonly user = this.userSignal.asReadonly();
  readonly isSignedIn = computed(() => this.userSignal() !== null);
  readonly isConfigured = !!environment.auth.clientId;

  constructor() {
    // Subscribe to MSAL events so the user signal stays in sync with
    // sign-in/sign-out/acquireToken outcomes, without callers having to
    // manually refresh.
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
          this.userSignal.set(null);
        }
      });
  }

  /**
   * Process any redirect response left over from a previous navigation and
   * prime the user signal from the MSAL account cache. Call once from
   * `AppComponent.ngOnInit`.
   */
  initializeFromRedirect(): Promise<void> {
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
    if (!this.isConfigured) return;
    void this.ensureInitialized().then(() =>
      this.msal.loginRedirect({
        scopes: environment.auth.scopes,
        prompt: 'select_account'
      })
    );
  }

  async signOut(): Promise<void> {
    if (!this.isConfigured) return;
    await this.ensureInitialized();
    const account = this.msal.getActiveAccount() ?? this.msal.getAllAccounts()[0];

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
        // revoked). Fall through without idTokenHint; Entra will show the
        // picker but sign-out still completes.
      }
    }

    // TEMPORARY diagnostic (see plan.md for M7-era sign-out picker work):
    // lets us see whether idTokenHint actually makes it through. Remove
    // once we've confirmed Entra is honoring the hint.
    console.info('[jotjson] signOut', {
      hasAccount: !!account,
      hasIdTokenHint: !!idTokenHint,
      hasLoginHint: !!account?.loginHint,
      username: account?.username
    });

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
   */
  async acquireTokenSilent(): Promise<string | null> {
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
    } catch (err) {
      if (err instanceof InteractionRequiredAuthError) {
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
      this.initPromise = Promise.resolve(this.msal.initialize()).catch((err) => {
        // If initialize fails we clear the cache so a subsequent call can
        // retry rather than replaying the rejection forever.
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  private refreshFromCache(): void {
    const account =
      this.msal.getActiveAccount() ?? this.msal.getAllAccounts()[0] ?? null;
    this.userSignal.set(account ? this.toAuthUser(account) : null);
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
