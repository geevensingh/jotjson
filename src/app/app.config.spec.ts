import { EnvironmentProviders, inject, provideAppInitializer } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SwRegistrationOptions } from '@angular/service-worker';
import { FakeMsalClient, provideFakeAuth } from '../testing/auth.testing';
import { appConfig } from './app.config';
import { AuthService } from './core/auth/auth.service';

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

  it('uses registerWhenStable:5000 for SW registration (issue #167)', () => {
    const serviceWorkerOptionsProvider = flattenProviders(appConfig.providers).find(
      (provider) => isProviderRecord(provider) && provider.provide === SwRegistrationOptions,
    );

    expect(serviceWorkerOptionsProvider).toBeDefined();
    expect(isProviderRecord(serviceWorkerOptionsProvider)).toBeTrue();
    if (!isProviderRecord(serviceWorkerOptionsProvider)) return;

    expect(serviceWorkerOptionsProvider.useValue).toEqual(
      jasmine.objectContaining({ registrationStrategy: 'registerWhenStable:5000' }),
    );
  });

  it('runs AuthService.initializeFromRedirect via APP_INITIALIZER', async () => {
    // Spy on the prototype so that both the AuthService instance constructed
    // for any consumer and the one resolved by `inject(AuthService)` inside
    // the initializer share the same patched method.
    const spy = spyOn(AuthService.prototype, 'initializeFromRedirect').and.returnValue(
      Promise.resolve(),
    );

    TestBed.configureTestingModule({
      providers: [
        ...provideFakeAuth(new FakeMsalClient()),
        provideAppInitializer(() => inject(AuthService).initializeFromRedirect()),
      ],
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
function isEnvironmentProviders(provider: unknown): provider is EnvironmentProviders {
  if (!provider || typeof provider !== 'object') return false;
  const keys = Object.keys(provider as Record<string, unknown>);
  return keys.some((key) => key.toLowerCase().includes('providers'));
}

function flattenProviders(providers: readonly unknown[]): unknown[] {
  const flattenedProviders: unknown[] = [];

  for (const provider of providers) {
    if (isEnvironmentProviders(provider)) {
      flattenedProviders.push(...readEnvironmentProviders(provider));
      continue;
    }

    flattenedProviders.push(provider);
  }

  return flattenedProviders;
}

function readEnvironmentProviders(provider: EnvironmentProviders): readonly unknown[] {
  const providerRecord = provider as Record<string, unknown>;
  const providersKey = Object.keys(providerRecord).find((key) =>
    key.toLowerCase().includes('providers'),
  );
  const providersValue = providersKey ? providerRecord[providersKey] : undefined;
  return Array.isArray(providersValue) ? providersValue : [];
}

interface ProviderRecord {
  provide: unknown;
  useValue?: unknown;
}

function isProviderRecord(provider: unknown): provider is ProviderRecord {
  return provider !== null && typeof provider === 'object' && 'provide' in provider;
}
