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

    it('signIn / signOut are no-ops', () => {
      const auth = TestBed.inject(AuthService);
      auth.signIn();
      auth.signOut();
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
      auth.signOut();
      await Promise.resolve();
      await Promise.resolve();
      expect(fake.logoutRedirectCalls).toBe(1);
    });

    it('signOut forwards login_hint claim as logoutHint to skip the picker', async () => {
      const auth = configuredAuth();
      fake.accounts = [
        makeAccount({
          idTokenClaims: {
            oid: 'oid-1',
            name: 'Test User',
            login_hint: 'opaque-hint-123'
          } as Record<string, unknown>
        })
      ];
      auth.signOut();
      await Promise.resolve();
      await Promise.resolve();
      expect(fake.lastLogoutRequest?.logoutHint).toBe('opaque-hint-123');
    });

    it('signOut falls back to account.username when login_hint is missing', async () => {
      const auth = configuredAuth();
      fake.accounts = [
        makeAccount({
          username: 'fallback@example.com',
          idTokenClaims: { oid: 'oid-1' } as Record<string, unknown>
        })
      ];
      auth.signOut();
      await Promise.resolve();
      await Promise.resolve();
      expect(fake.lastLogoutRequest?.logoutHint).toBe('fallback@example.com');
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
