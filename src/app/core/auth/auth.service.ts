import { Injectable, computed, inject, signal } from '@angular/core';
import {
  AccountInfo,
  AuthenticationResult,
  EventMessage,
  EventType,
  InteractionRequiredAuthError,
  InteractionStatus,
  IPublicClientApplication
} from '@azure/msal-browser';
import { MsalBroadcastService } from '@azure/msal-angular';
import { filter, take } from 'rxjs/operators';
import { environment } from '../../../environments/environment';
import { AuthUser } from './auth-user';
import { MSAL_INSTANCE } from './msal-instance';

/**
 * Entry point for identity in the app.
 *
 * Exposes:
 * - `user()` — signal of the current `AuthUser` or `null`.
 * - `isSignedIn()` — computed derived signal.
 * - `isConfigured` — whether the environment has real auth config
 *   (non-empty clientId). False in local dev with empty config, and the
 *   toolbar disables sign-in in that case.
 * - `signIn()` / `signOut()` — interactive redirect flows.
 * - `acquireTokenSilent()` — silent-only; returns `null` on failure.
 *
 * Redirect handling is driven by `AppComponent` via
 * `initializeFromRedirect()`, which must be called once on app start.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly msal = inject<IPublicClientApplication>(MSAL_INSTANCE);
  private readonly broadcast = inject(MsalBroadcastService, { optional: true });

  private readonly userSignal = signal<AuthUser | null>(null);

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
    return this.msal
      .handleRedirectPromise()
      .then((result: AuthenticationResult | null) => {
        if (result?.account) {
          this.msal.setActiveAccount(result.account);
        }
        return this.waitForInteractionComplete().then(() => this.refreshFromCache());
      })
      .catch(() => {
        // Swallow: MSAL logs internally; a failed redirect should not crash
        // the app. The user can retry via the sign-in button.
      });
  }

  signIn(): void {
    if (!this.isConfigured) return;
    void this.msal.loginRedirect({
      scopes: environment.auth.scopes,
      prompt: 'select_account'
    });
  }

  signOut(): void {
    if (!this.isConfigured) return;
    const account = this.msal.getActiveAccount() ?? this.msal.getAllAccounts()[0];
    void this.msal.logoutRedirect({
      account,
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

  private waitForInteractionComplete(): Promise<void> {
    if (!this.broadcast) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.broadcast!.inProgress$
        .pipe(
          filter((status) => status === InteractionStatus.None),
          take(1)
        )
        .subscribe(() => resolve());
    });
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
