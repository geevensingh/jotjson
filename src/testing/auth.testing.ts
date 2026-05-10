import { Provider } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Subject } from 'rxjs';
import {
  AccountInfo,
  AuthenticationResult,
  EndSessionRequest,
  EventMessage,
  IPublicClientApplication,
} from '@azure/msal-browser';
import { MsalBroadcastService, MsalService } from '@azure/msal-angular';
import { MSAL_INSTANCE } from '../app/core/auth/msal-instance';
import { AuthService } from '../app/core/auth/auth.service';
import { AuthUser } from '../app/core/auth/auth-user';

/**
 * Spec-side stand-in for MSAL's `PublicClientApplication`. Records calls to
 * `loginRedirect` / `logoutRedirect` / `acquireTokenSilent` so tests can
 * assert them, and lets tests stage canned return values.
 */
export class FakeMsalClient implements Partial<IPublicClientApplication> {
  accounts: AccountInfo[] = [];
  activeAccount: AccountInfo | null = null;
  redirectResult: AuthenticationResult | null = null;
  nextSilentToken: string | null = null;
  nextSilentIdToken: string | null = null;
  silentShouldThrow: Error | null = null;

  loginRedirectCalls = 0;
  logoutRedirectCalls = 0;
  lastLogoutRequest: EndSessionRequest | undefined;
  acquireTokenSilentCalls = 0;
  initializeCalls = 0;

  initialize(): Promise<void> {
    this.initializeCalls += 1;
    return Promise.resolve();
  }

  getAllAccounts(): AccountInfo[] {
    return this.accounts;
  }
  getActiveAccount(): AccountInfo | null {
    return this.activeAccount;
  }
  setActiveAccount(account: AccountInfo | null): void {
    this.activeAccount = account;
  }
  handleRedirectPromise(): Promise<AuthenticationResult | null> {
    return Promise.resolve(this.redirectResult);
  }
  loginRedirect(): Promise<void> {
    this.loginRedirectCalls += 1;
    return Promise.resolve();
  }
  logoutRedirect(request?: EndSessionRequest): Promise<void> {
    this.logoutRedirectCalls += 1;
    this.lastLogoutRequest = request;
    return Promise.resolve();
  }
  acquireTokenSilent(): Promise<AuthenticationResult> {
    this.acquireTokenSilentCalls += 1;
    if (this.silentShouldThrow) return Promise.reject(this.silentShouldThrow);
    return Promise.resolve({
      accessToken: this.nextSilentToken ?? '',
      idToken: this.nextSilentIdToken ?? '',
      account: this.activeAccount,
    } as AuthenticationResult);
  }
}

/** MsalBroadcastService stub exposing the event subject AuthService consumes. */
export class FakeMsalBroadcastService {
  msalSubject$ = new Subject<EventMessage>();
}

/**
 * Providers to drop into `TestBed.configureTestingModule` for any spec that
 * transitively imports a component depending on `AuthService`.
 */
export function provideFakeAuth(
  client?: FakeMsalClient,
): (Provider | ReturnType<typeof provideHttpClient>)[] {
  const fake = client ?? new FakeMsalClient();
  return [
    { provide: MSAL_INSTANCE, useValue: fake as unknown as IPublicClientApplication },
    { provide: MsalBroadcastService, useClass: FakeMsalBroadcastService },
    // MsalService depends on MSAL_INSTANCE and a few other things. AuthService
    // does not call into it directly; provide a bare stub so DI resolves.
    { provide: MsalService, useValue: {} },
    // PreferencesService transitively depends on HttpClient via the
    // UserApiService. Provide the testing client so tests that do not stage
    // specific requests still construct cleanly; none are expected to fire
    // while the fake auth user is `null` (anon lifecycle).
    provideHttpClient(),
    provideHttpClientTesting(),
  ];
}

export function makeAccount(overrides: Partial<AccountInfo> = {}): AccountInfo {
  return {
    homeAccountId: 'home-1',
    environment: 'test',
    tenantId: 'tenant-1',
    username: 'user@example.com',
    localAccountId: 'local-1',
    idTokenClaims: {
      oid: 'oid-1',
      name: 'Test User',
      email: 'user@example.com',
    },
    ...overrides,
  } as AccountInfo;
}

/**
 * Signs a fake user into the injected `AuthService`. Used by specs whose DOM
 * assertions depend on signed-in-only UX (e.g. `*jjSignedIn`-gated elements).
 *
 * Forces `isConfigured = true` by default because CI copies
 * `environment.example.ts` (empty `clientId`) over `environment.ts`, which
 * flips `AuthService.isConfigured` to `false` at construction time. Without
 * this override, tests that assume signed-in DOM would pass locally and fail
 * on CI.
 */
export function signInFakeUser(
  auth: AuthService,
  opts: { user?: AuthUser; configured?: boolean } = {},
): void {
  const configured = opts.configured ?? true;
  if (configured) {
    (auth as unknown as { isConfigured: boolean }).isConfigured = true;
  }
  const user: AuthUser = opts.user ?? {
    id: 'oid-1',
    displayName: 'Test User',
    email: 'user@example.com',
  };
  (auth as unknown as { userSignal: { set(v: AuthUser | null): void } }).userSignal.set(user);
}
