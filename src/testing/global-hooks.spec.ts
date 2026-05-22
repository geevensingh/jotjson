/**
 * Global per-test isolation hook (issue #350).
 *
 * Top-level `beforeEach` / `afterEach` in any spec file run globally
 * under Karma + Jasmine. This file installs a cleanup pass that runs
 * after every spec across the entire suite to undo two classes of
 * cross-spec state leakage:
 *
 *   1. `localStorage` / `sessionStorage` entries left behind by a
 *      test that forgot its own `afterEach`.
 *   2. `Storage.prototype` patches (e.g., a spy on
 *      `Storage.prototype.setItem` that never gets restored).
 *
 * Failure mode this prevents: a spec that runs in random order
 * before its victim passes locally and on the first CI attempt,
 * then fails on a retry when the order changes. See PR #351 for
 * the original `sw-registration` -> `LoggerService` flake that
 * motivated this hook.
 *
 * What this hook deliberately does NOT cover:
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
 * Design decisions:
 *   - `beforeEach` is deliberately absent. Clearing storages
 *     globally before each spec would silently delete data that
 *     `beforeAll` seeded for a whole describe block. Defense
 *     happens in `afterEach` only, so the next spec inherits a
 *     clean slate without the current spec's setup being clobbered.
 *   - `getOwnPropertyDescriptors` is used on `Storage.prototype` to
 *     capture the `length` accessor's getter, not just enumerable
 *     methods.
 *   - Storage-prototype restoration is wrapped in `try / catch` per
 *     descriptor because some properties are non-configurable in
 *     some environments; one rogue test must not brick the hook
 *     for every later spec.
 */

const cleanStorageProto: Readonly<Record<string, PropertyDescriptor>> = Object.freeze({
  ...Object.getOwnPropertyDescriptors(Storage.prototype),
});

function restoreStoragePrototype(): void {
  const currentProto = Object.getOwnPropertyDescriptors(Storage.prototype);
  for (const key of Object.keys(cleanStorageProto)) {
    const original = cleanStorageProto[key];
    const live = currentProto[key];
    if (descriptorsEqual(original, live)) continue;
    try {
      Object.defineProperty(Storage.prototype, key, original);
    } catch {
      // Non-configurable in this environment; nothing we can do.
      // Log via console.warn so the failure is observable.
      // eslint-disable-next-line no-console
      console.warn(
        `[global-hooks] could not restore Storage.prototype.${key} -- ` +
          'descriptor non-configurable in this environment.',
      );
    }
  }
}

function descriptorsEqual(
  a: PropertyDescriptor | undefined,
  b: PropertyDescriptor | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.value === b.value &&
    a.get === b.get &&
    a.set === b.set &&
    a.writable === b.writable &&
    a.enumerable === b.enumerable &&
    a.configurable === b.configurable
  );
}

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  restoreStoragePrototype();
});

/**
 * Permanent verifier: deliberately leaks state in one spec and
 * asserts clean state in the next. If a future refactor breaks the
 * `afterEach` hook above, this fails.
 *
 * Under Jasmine `random: true` the two specs may run in either
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
