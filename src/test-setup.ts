// organize-imports-ignore -- import order is load-bearing here:
// `@angular/compiler` MUST load before any module that imports
// `@angular/common` (the @analogjs setup-testbed transitively does
// so via @angular/platform-browser/testing -> @angular/common), or
// PlatformLocation's static initializer fails to find the JIT
// compiler facade and throws `_PlatformLocation needs JIT but
// @angular/compiler is not available`. Without this directive,
// `prettier-plugin-organize-imports` would re-sort the imports
// alphabetically and break the test suite.
import '@angular/compiler';
import '@angular/localize/init';
import 'zone.js';
import 'zone.js/testing';
import { setupTestBed } from '@analogjs/vitest-angular/setup-testbed';
import '@analogjs/vitest-angular/setup-zone';
import './styles.scss';

setupTestBed({
  zoneless: false,
});

// Global per-test isolation hook (issue #350 / Karma-Vitest migration).
// In Karma+Jasmine, top-level `afterEach` in a spec file ran globally
// across the suite. In Vitest, top-level `afterEach` in a `.test.ts`
// file is FILE-scoped. Registering the hook in `setupFiles` makes it
// run after every test across every file -- restoring the Karma
// behavior. See `src/testing/global-hooks.test.ts` for the verifier
// specs and full design rationale.

const cleanStorageProto: Readonly<Record<string, PropertyDescriptor>> = Object.freeze({
  ...Object.getOwnPropertyDescriptors(Storage.prototype),
});

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

function restoreStoragePrototype(): void {
  const currentProto = Object.getOwnPropertyDescriptors(Storage.prototype);
  for (const key of Object.keys(cleanStorageProto)) {
    const original = cleanStorageProto[key];
    const live = currentProto[key];
    if (descriptorsEqual(original, live)) continue;
    try {
      Object.defineProperty(Storage.prototype, key, original);
    } catch {
      // eslint-disable-next-line no-console
      console.warn(
        `[test-setup] could not restore Storage.prototype.${key} -- ` +
          'descriptor non-configurable in this environment.',
      );
    }
  }
}

afterEach(() => {
  restoreStoragePrototype();
  localStorage.clear();
  sessionStorage.clear();
});
