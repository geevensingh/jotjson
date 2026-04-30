import { TestBed } from '@angular/core/testing';
import {
  EventMessage,
  EventType,
  InteractionRequiredAuthError
} from '@azure/msal-browser';
import { MsalBroadcastService } from '@azure/msal-angular';
import { environment } from '../../../environments/environment';
import { AuthService } from './auth.service';
import {
  FakeMsalBroadcastService,
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
      // `devMode` is captured at construction time from `environment.devAuth`.
      // Force it off here so the configured-tenant tests exercise the MSAL
      // paths even when the developer's local environment.ts has dev-auth
      // bypass enabled.
      (svc as unknown as { devMode: boolean }).devMode = false;
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

  describe('dev-auth mode', () => {
    const STORAGE_KEY = 'jotjson.devAuth.signedIn';
    type DevAuthCfg = {
      enabled: boolean;
      userId: string;
      displayName: string;
      email?: string;
    };
    const VALID_DEV_AUTH: DevAuthCfg = {
      enabled: true,
      userId: 'dev-user-1',
      displayName: 'Dev User',
      email: 'dev-user-1@dev.local'
    };

    type EnvWithDevAuth = typeof environment & {
      devAuth?: DevAuthCfg;
    };

    let savedDevAuth: DevAuthCfg | undefined;
    let savedFlag: string | null;

    beforeEach(() => {
      const env = environment as EnvWithDevAuth;
      savedDevAuth = env.devAuth;
      savedFlag = localStorage.getItem(STORAGE_KEY);
      localStorage.removeItem(STORAGE_KEY);
    });

    afterEach(() => {
      const env = environment as EnvWithDevAuth;
      if (savedDevAuth === undefined) {
        delete env.devAuth;
      } else {
        env.devAuth = savedDevAuth;
      }
      if (savedFlag === null) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, savedFlag);
      }
    });

    function setDevAuth(value: DevAuthCfg | undefined): void {
      const env = environment as EnvWithDevAuth;
      if (value === undefined) {
        delete env.devAuth;
      } else {
        env.devAuth = value;
      }
    }

    function freshAuth(): AuthService {
      // AuthService captures `devMode` at construction time, so each test
      // needs its own instance after mutating `environment.devAuth`.
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [...provideFakeAuth(fake)]
      });
      return TestBed.inject(AuthService);
    }

    it('isConfigured is true when devAuth.enabled even with empty clientId', () => {
      setDevAuth({ ...VALID_DEV_AUTH });
      const auth = freshAuth();
      expect(auth.isConfigured).toBe(true);
    });

    it('initializeFromRedirect does NOT call msal.initialize or handleRedirectPromise in dev mode', async () => {
      setDevAuth({ ...VALID_DEV_AUTH });
      const auth = freshAuth();
      const handleSpy = spyOn(fake, 'handleRedirectPromise').and.callThrough();
      await auth.initializeFromRedirect();
      expect(fake.initializeCalls).toBe(0);
      expect(handleSpy).not.toHaveBeenCalled();
    });

    it('initializeFromRedirect hydrates persona from localStorage flag', async () => {
      setDevAuth({ ...VALID_DEV_AUTH });
      localStorage.setItem(STORAGE_KEY, '1');
      const auth = freshAuth();
      await auth.initializeFromRedirect();
      expect(auth.isSignedIn()).toBe(true);
      expect(auth.user()?.id).toBe('dev-user-1');
      expect(auth.user()?.displayName).toBe('Dev User');
      expect(auth.user()?.email).toBe('dev-user-1@dev.local');
    });

    it('initializeFromRedirect leaves user null when localStorage flag is missing', async () => {
      setDevAuth({ ...VALID_DEV_AUTH });
      const auth = freshAuth();
      await auth.initializeFromRedirect();
      expect(auth.isSignedIn()).toBe(false);
      expect(auth.user()).toBeNull();
    });

    it('signIn flips localStorage flag and userSignal without calling MSAL loginRedirect', () => {
      setDevAuth({ ...VALID_DEV_AUTH });
      const auth = freshAuth();
      auth.signIn();
      expect(localStorage.getItem(STORAGE_KEY)).toBe('1');
      expect(auth.isSignedIn()).toBe(true);
      expect(auth.user()?.id).toBe('dev-user-1');
      expect(fake.loginRedirectCalls).toBe(0);
    });

    it('signOut clears localStorage flag and userSignal without calling MSAL logoutRedirect', async () => {
      setDevAuth({ ...VALID_DEV_AUTH });
      localStorage.setItem(STORAGE_KEY, '1');
      const auth = freshAuth();
      await auth.initializeFromRedirect();
      await auth.signOut();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(auth.isSignedIn()).toBe(false);
      expect(fake.logoutRedirectCalls).toBe(0);
    });

    it('acquireTokenSilent returns dev:<userId> when signed in', async () => {
      setDevAuth({ ...VALID_DEV_AUTH });
      const auth = freshAuth();
      auth.signIn();
      const token = await auth.acquireTokenSilent();
      expect(token).toBe('dev:dev-user-1');
      expect(fake.acquireTokenSilentCalls).toBe(0);
    });

    it('acquireTokenSilent returns null when signed out', async () => {
      setDevAuth({ ...VALID_DEV_AUTH });
      const auth = freshAuth();
      const token = await auth.acquireTokenSilent();
      expect(token).toBeNull();
    });

    it('signIn / signOut keep telemetry identity in sync with the signal', async () => {
      setDevAuth({ ...VALID_DEV_AUTH });
      const setUserSpy = jasmine.createSpy('setUser');
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          ...provideFakeAuth(fake),
          {
            provide: (
              await import('../telemetry/telemetry.service')
            ).TelemetryService,
            useValue: {
              setUser: setUserSpy,
              connect: () => Promise.resolve(),
              ingest: () => undefined
            }
          }
        ]
      });
      const auth = TestBed.inject(AuthService);
      auth.signIn();
      expect(setUserSpy).toHaveBeenCalledWith('dev-user-1');
      await auth.signOut();
      expect(setUserSpy).toHaveBeenCalledWith(null);
    });

    it('does not subscribe to MsalBroadcastService events in dev mode', async () => {
      setDevAuth({ ...VALID_DEV_AUTH });
      const auth = freshAuth();
      auth.signIn();
      const broadcast = TestBed.inject(MsalBroadcastService) as unknown as
        FakeMsalBroadcastService;
      const fakeMsg = {
        eventType: EventType.LOGOUT_SUCCESS
      } as unknown as EventMessage;
      broadcast.msalSubject$.next(fakeMsg);
      // The synthetic LOGOUT_SUCCESS would clear the user in MSAL mode.
      // In dev mode, the subscription is gated, so the user stays signed in.
      expect(auth.isSignedIn()).toBe(true);
      expect(auth.user()?.id).toBe('dev-user-1');
    });

    it('fail-closed: invalid userId disables devMode (devPath bypassed)', () => {
      setDevAuth({
        enabled: true,
        userId: 'BAD UPPER!',
        displayName: 'Whoops',
        email: 'oops@dev.local'
      });
      const auth = freshAuth();
      auth.signIn();
      // signIn should not have written the dev-auth localStorage flag, since
      // devMode is false. (Whether the MSAL path also fires depends on
      // local environment.auth.clientId; that's not what we're testing.)
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(auth.user()?.id).not.toBe('BAD UPPER!');
    });
  });
});
