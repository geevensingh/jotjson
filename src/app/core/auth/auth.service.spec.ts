import { TestBed } from '@angular/core/testing';
import { InteractionRequiredAuthError } from '@azure/msal-browser';
import { AuthService } from './auth.service';
import {
  FakeMsalClient,
  makeAccount,
  provideFakeAuth
} from '../../../testing/auth.testing';

describe('AuthService', () => {
  let fake: FakeMsalClient;

  beforeEach(() => {
    fake = new FakeMsalClient();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [...provideFakeAuth(fake)]
    });
  });

  describe('when auth is not configured (dev/empty config)', () => {
    it('reports not signed in and leaves user null', () => {
      const auth = TestBed.inject(AuthService);
      expect(auth.user()).toBeNull();
      expect(auth.isSignedIn()).toBe(false);
    });

    it('signIn / signOut are no-ops', async () => {
      const auth = TestBed.inject(AuthService);
      (auth as unknown as { isConfigured: boolean }).isConfigured = false;
      auth.signIn();
      await auth.signOut();
      expect(fake.loginRedirectCalls).toBe(0);
      expect(fake.logoutRedirectCalls).toBe(0);
    });

    it('acquireTokenSilent returns null', async () => {
      const auth = TestBed.inject(AuthService);
      const token = await auth.acquireTokenSilent();
      expect(token).toBeNull();
    });
  });

  describe('with a configured tenant (simulated via spyOn on the service flag)', () => {
    function configuredAuth(): AuthService {
      const svc = TestBed.inject(AuthService);
      // `isConfigured` is read-only in prod, but spec suite can override for
      // the no-tenant short-circuit check.
      (svc as unknown as { isConfigured: boolean }).isConfigured = true;
      return svc;
    }

    it('signIn calls loginRedirect', async () => {
      const auth = configuredAuth();
      auth.signIn();
      await Promise.resolve();
      await Promise.resolve();
      expect(fake.loginRedirectCalls).toBe(1);
    });

    it('signOut calls logoutRedirect', async () => {
      const auth = configuredAuth();
      fake.accounts = [makeAccount()];
      await auth.signOut();
      expect(fake.logoutRedirectCalls).toBe(1);
    });

    it('signOut forwards idTokenHint and logoutHint to skip the picker', async () => {
      const auth = configuredAuth();
      fake.accounts = [
        makeAccount({
          idToken: 'raw.id.token',
          loginHint: 'opaque-hint-123'
        })
      ];
      spyOn(console, 'info');
      await auth.signOut();
      expect(fake.lastLogoutRequest?.idTokenHint).toBe('raw.id.token');
      expect(fake.lastLogoutRequest?.logoutHint).toBe('opaque-hint-123');
    });

    it('signOut falls back to acquireTokenSilent when account.idToken is missing', async () => {
      const auth = configuredAuth();
      fake.accounts = [
        makeAccount({
          idToken: undefined,
          loginHint: 'opaque-hint'
        })
      ];
      fake.nextSilentIdToken = 'freshly-acquired.id.token';
      spyOn(console, 'info');
      await auth.signOut();
      expect(fake.acquireTokenSilentCalls).toBe(1);
      expect(fake.lastLogoutRequest?.idTokenHint).toBe('freshly-acquired.id.token');
      expect(fake.lastLogoutRequest?.logoutHint).toBe('opaque-hint');
    });

    it('signOut omits idTokenHint gracefully when silent acquire also fails', async () => {
      const auth = configuredAuth();
      fake.accounts = [
        makeAccount({
          idToken: undefined,
          loginHint: undefined
        })
      ];
      fake.silentShouldThrow = new Error('interaction required');
      spyOn(console, 'info');
      await auth.signOut();
      expect(fake.lastLogoutRequest?.idTokenHint).toBeUndefined();
      expect(fake.lastLogoutRequest?.logoutHint).toBeUndefined();
      expect(fake.logoutRedirectCalls).toBe(1);
    });

    it('acquireTokenSilent returns the token when MSAL returns one', async () => {
      const auth = configuredAuth();
      fake.accounts = [makeAccount()];
      fake.nextSilentToken = 'tok-123';
      const token = await auth.acquireTokenSilent();
      expect(token).toBe('tok-123');
    });

    it('acquireTokenSilent returns null when there is no account', async () => {
      const auth = configuredAuth();
      const token = await auth.acquireTokenSilent();
      expect(token).toBeNull();
      expect(fake.acquireTokenSilentCalls).toBe(0);
    });

    it('acquireTokenSilent returns null on InteractionRequiredAuthError', async () => {
      const auth = configuredAuth();
      fake.accounts = [makeAccount()];
      fake.silentShouldThrow = new InteractionRequiredAuthError();
      const token = await auth.acquireTokenSilent();
      expect(token).toBeNull();
    });

    it('acquireTokenSilent returns null on any other error', async () => {
      const auth = configuredAuth();
      fake.accounts = [makeAccount()];
      fake.silentShouldThrow = new Error('network');
      const token = await auth.acquireTokenSilent();
      expect(token).toBeNull();
    });

    it('initializeFromRedirect populates the user signal from the cached account', async () => {
      const auth = configuredAuth();
      fake.accounts = [makeAccount()];
      await auth.initializeFromRedirect();
      expect(auth.isSignedIn()).toBe(true);
      expect(auth.user()?.id).toBe('oid-1');
      expect(auth.user()?.displayName).toBe('Test User');
      expect(auth.user()?.email).toBe('user@example.com');
    });

    it('initializeFromRedirect falls back to sub/preferred_username when oid/email are missing', async () => {
      const auth = configuredAuth();
      fake.accounts = [
        makeAccount({
          idTokenClaims: {
            sub: 'sub-only',
            preferred_username: 'pref@example.com'
          } as Record<string, unknown>
        })
      ];
      await auth.initializeFromRedirect();
      expect(auth.user()?.id).toBe('sub-only');
      expect(auth.user()?.email).toBe('pref@example.com');
    });
  });
});
