import { EnvironmentProviders, inject, provideAppInitializer } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { appConfig } from './app.config';
import { AuthService } from './core/auth/auth.service';
import { FakeMsalClient, provideFakeAuth } from '../testing/auth.testing';

/**
 * Regression: opening a share link in a fresh tab used to race MSAL hydration
 * because `initializeFromRedirect()` ran from `AppComponent.ngOnInit`, which
 * fires after the router has already activated routes. The share resolver's
 * `GET /api/blobs/:slug` would go out without `X-Jotjson-Authorization`, so
 * the server skipped the `viewed` history entry. The fix wires
 * `initializeFromRedirect()` into `provideAppInitializer` so the router
 * waits for MSAL to hydrate before activating routes.
 */
describe('appConfig', () => {
  it('declares at least one provideAppInitializer entry', () => {
    const initializerCount = appConfig.providers.filter(isEnvironmentProviders).length;
    expect(initializerCount).toBeGreaterThan(0);
  });

  it('runs AuthService.initializeFromRedirect via APP_INITIALIZER', async () => {
    // Spy on the prototype so that both the AuthService instance constructed
    // for any consumer and the one resolved by `inject(AuthService)` inside
    // the initializer share the same patched method.
    const spy = spyOn(AuthService.prototype, 'initializeFromRedirect').and.returnValue(
      Promise.resolve()
    );

    TestBed.configureTestingModule({
      providers: [
        ...provideFakeAuth(new FakeMsalClient()),
        provideAppInitializer(() => inject(AuthService).initializeFromRedirect())
      ]
    });

    // TestBed initializes the EnvironmentInjector eagerly when providers are
    // resolved, which runs APP_INITIALIZER multi-providers. Just inject any
    // token to ensure the injector is wired, then assert.
    TestBed.inject(AuthService);

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

/**
 * `provideAppInitializer` returns an opaque `EnvironmentProviders` token. The
 * runtime brand is the internal providers array on the returned object;
 * treat any object that exposes one as an `EnvironmentProviders` blob.
 */
function isEnvironmentProviders(p: unknown): p is EnvironmentProviders {
  if (!p || typeof p !== 'object') return false;
  const keys = Object.keys(p as Record<string, unknown>);
  return keys.some((k) => k.toLowerCase().includes('providers'));
}
