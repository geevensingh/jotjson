/**
 * Global per-test isolation hook -- verifier specs (issue #350).
 *
 * The actual `afterEach` cleanup that runs after every spec across
 * the entire suite lives in `src/test-setup.ts` (Vitest setupFile).
 * In Karma+Jasmine the same cleanup lived here as a top-level
 * `afterEach`; under Vitest, top-level `afterEach` in a `.test.ts`
 * is file-scoped, so the hook was moved into the setup file to
 * preserve the global semantics.
 *
 * What the global hook does NOT cover:
 *   - New top-level properties on `window`. An earlier draft
 *     deleted any key not present at module-load snapshot. That
 *     overreached: legitimate `beforeAll`-seeded state (notably
 *     Monaco's `window.monaco` / `window.MonacoEnvironment` in the
 *     `JsonEditorComponent` browser-integration spec) was deleted
 *     between specs in the same describe block, breaking the
 *     suite. Specs that extend `window` (including `beforeAll`
 *     seeding) must clean up in their own `afterEach` / `afterAll`.
 *   - Mutations of *existing* `window` properties (e.g.,
 *     `window.fetch = mockFetch`). Specs that overwrite built-ins
 *     must restore them manually.
 *   - `document.*` mutations and event-listener registrations on
 *     `window` / `document`.
 *   - Outstanding `requestAnimationFrame` /
 *     `IntersectionObserver` / `MutationObserver` / `ResizeObserver`
 *     registrations.
 *   - Module-scoped state inside ES modules. ES modules are
 *     singletons; external code cannot reset them. Use the
 *     `__resetXForTesting` convention; the lint rule in
 *     `scripts/check-spec-patterns.mjs` enforces that any
 *     `__reset*ForTesting` placed in `beforeEach` is also placed
 *     in the matching `afterEach`.
 *
 * This file is verifier-only: the specs below deliberately leak
 * state in one test and assert clean state in the next. If a future
 * refactor breaks the hook in `test-setup.ts`, these specs fail.
 */

/**
 * Permanent verifier: deliberately leaks state in one spec and
 * asserts clean state in the next. If a future refactor breaks the
 * `afterEach` hook in `test-setup.ts`, this fails.
 *
 * Under Vitest's `sequence.shuffle: true` the two specs may run in either
 * order. The verifier proves the hook works regardless:
 * - If "leaks" runs first, "observes clean" sees the cleared state.
 * - If "observes clean" runs first, it sees the clean state at
 *   module-load time (no prior spec leaked).
 */
describe('global test isolation hook (verifier)', () => {
  const STORAGE_KEY = 'jj-global-hook-verifier';

  it('leaks state (deliberate)', () => {
    localStorage.setItem(STORAGE_KEY, 'leaked');
    sessionStorage.setItem(STORAGE_KEY, 'leaked');

    expect(localStorage.getItem(STORAGE_KEY)).toBe('leaked');
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe('leaked');
  });

  it('observes clean state (no prior leakage from sibling)', () => {
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

/**
 * Permanent verifier for `Storage.prototype` restoration: patches
 * `Storage.prototype.setItem` in one spec and asserts the original
 * is restored in the next.
 */
describe('global test isolation hook -- Storage.prototype restore', () => {
  const SENTINEL_KEY = 'jj-storage-proto-verifier';

  it('patches Storage.prototype.setItem (deliberate)', () => {
    const patched = function patched(this: Storage, key: string, _value: string): void {
      void _value;
      // Deliberately a no-op; the next spec will assert real setItem
      // works again.
      void key;
    };
    Storage.prototype.setItem = patched as Storage['setItem'];
    localStorage.setItem(SENTINEL_KEY, 'should-be-discarded-by-patch');
    expect(localStorage.getItem(SENTINEL_KEY)).toBeNull();
  });

  it('observes original Storage.prototype.setItem restored', () => {
    localStorage.setItem(SENTINEL_KEY, 'real-write');
    expect(localStorage.getItem(SENTINEL_KEY)).toBe('real-write');
  });
});

/**
 * Permanent verifier for `Storage.prototype.clear`-patch ordering:
 * patches `Storage.prototype.clear` to a no-op in one spec, leaks
 * data, and asserts the next spec sees clean state. Proves the
 * `afterEach` ordering (`restoreStoragePrototype()` before the
 * `clear()` calls) works: even with `clear` patched, the prototype
 * is restored first, so the subsequent global `clear()` calls
 * invoke the original implementation and remove the leaked data.
 *
 * If a future refactor swaps the ordering back to `clear; clear;
 * restore`, this verifier fails.
 */
describe('global test isolation hook -- clear-patch ordering', () => {
  const SENTINEL_KEY = 'jj-clear-patch-verifier';

  it('patches Storage.prototype.clear to a no-op and leaks data (deliberate)', () => {
    Storage.prototype.clear = function noopClear(this: Storage): void {
      // Deliberately a no-op. If the afterEach clears storage
      // *before* restoring Storage.prototype, this patch would
      // silently defeat the global cleanup.
    } as Storage['clear'];

    localStorage.setItem(SENTINEL_KEY, 'leaked-under-patched-clear');
    sessionStorage.setItem(SENTINEL_KEY, 'leaked-under-patched-clear');

    expect(localStorage.getItem(SENTINEL_KEY)).toBe('leaked-under-patched-clear');
    expect(sessionStorage.getItem(SENTINEL_KEY)).toBe('leaked-under-patched-clear');
  });

  it('observes clean state (restore must run before clear in afterEach)', () => {
    expect(localStorage.getItem(SENTINEL_KEY)).toBeNull();
    expect(sessionStorage.getItem(SENTINEL_KEY)).toBeNull();
  });
});

/**
 * Permanent verifier: deliberately leaks state in one spec and
 * asserts clean state in the next. If a future refactor breaks the
 * `afterEach` hook above, this fails.
 *
 * Under Vitest's `sequence.shuffle: true` the two specs may run in either
 * order. The verifier proves the hook works regardless:
 * - If "leaks" runs first, "observes clean" sees the cleared state.
 * - If "observes clean" runs first, it sees the clean state at
 *   module-load time (no prior spec leaked).
 */
describe('global test isolation hook (verifier)', () => {
  const STORAGE_KEY = 'jj-global-hook-verifier';

  it('leaks state (deliberate)', () => {
    localStorage.setItem(STORAGE_KEY, 'leaked');
    sessionStorage.setItem(STORAGE_KEY, 'leaked');

    expect(localStorage.getItem(STORAGE_KEY)).toBe('leaked');
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe('leaked');
  });

  it('observes clean state (no prior leakage from sibling)', () => {
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

/**
 * Permanent verifier for `Storage.prototype` restoration: patches
 * `Storage.prototype.setItem` in one spec and asserts the original
 * is restored in the next.
 */
describe('global test isolation hook -- Storage.prototype restore', () => {
  const SENTINEL_KEY = 'jj-storage-proto-verifier';

  it('patches Storage.prototype.setItem (deliberate)', () => {
    const patched = function patched(this: Storage, key: string, _value: string): void {
      void _value;
      // Deliberately a no-op; the next spec will assert real setItem
      // works again.
      void key;
    };
    Storage.prototype.setItem = patched as Storage['setItem'];
    localStorage.setItem(SENTINEL_KEY, 'should-be-discarded-by-patch');
    expect(localStorage.getItem(SENTINEL_KEY)).toBeNull();
  });

  it('observes original Storage.prototype.setItem restored', () => {
    localStorage.setItem(SENTINEL_KEY, 'real-write');
    expect(localStorage.getItem(SENTINEL_KEY)).toBe('real-write');
  });
});

/**
 * Permanent verifier for `Storage.prototype.clear`-patch ordering:
 * patches `Storage.prototype.clear` to a no-op in one spec, leaks
 * data, and asserts the next spec sees clean state. Proves the
 * `afterEach` ordering (`restoreStoragePrototype()` before the
 * `clear()` calls) works: even with `clear` patched, the prototype
 * is restored first, so the subsequent global `clear()` calls
 * invoke the original implementation and remove the leaked data.
 *
 * If a future refactor swaps the ordering back to `clear; clear;
 * restore`, this verifier fails.
 */
describe('global test isolation hook -- clear-patch ordering', () => {
  const SENTINEL_KEY = 'jj-clear-patch-verifier';

  it('patches Storage.prototype.clear to a no-op and leaks data (deliberate)', () => {
    Storage.prototype.clear = function noopClear(this: Storage): void {
      // Deliberately a no-op. If the afterEach clears storage
      // *before* restoring Storage.prototype, this patch would
      // silently defeat the global cleanup.
    } as Storage['clear'];

    localStorage.setItem(SENTINEL_KEY, 'leaked-under-patched-clear');
    sessionStorage.setItem(SENTINEL_KEY, 'leaked-under-patched-clear');

    expect(localStorage.getItem(SENTINEL_KEY)).toBe('leaked-under-patched-clear');
    expect(sessionStorage.getItem(SENTINEL_KEY)).toBe('leaked-under-patched-clear');
  });

  it('observes clean state (restore must run before clear in afterEach)', () => {
    expect(localStorage.getItem(SENTINEL_KEY)).toBeNull();
    expect(sessionStorage.getItem(SENTINEL_KEY)).toBeNull();
  });
});
