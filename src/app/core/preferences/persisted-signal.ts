import { DestroyRef, effect, inject, signal, WritableSignal } from '@angular/core';

/**
 * Options for {@link persistedSignal}. Encapsulates the small
 * boilerplate around hydrating a signal from localStorage and writing
 * through on every change.
 */
export interface PersistedSignalOptions<T> {
  /** localStorage key. Convention: `jotjson.<feature>.v<n>`. */
  key: string;
  /** Returned when storage is empty, parse fails, or storage throws. */
  defaultValue: T;
  /**
   * Decode the raw string read from storage. Throw to fall back to
   * `defaultValue`. Implementations should also fall back themselves
   * for predictable values (e.g., clamping a number into range).
   */
  parse: (raw: string) => T;
  /** Encode the in-memory value for storage. */
  serialize: (value: T) => string;
  /**
   * When true, the key is `removeItem`'d instead of written. Useful
   * for "empty string clears the slot" semantics. Defaults to never
   * removing the key on update.
   */
  shouldRemove?: (value: T) => boolean;
  /**
   * Coalesce bursty writes into one localStorage round-trip per
   * `writeDebounceMs` ms of idle. Defaults to 0 (write on every
   * change, current behavior).
   *
   * Use for high-frequency signals where the write cost dominates
   * (e.g., a draft autosave bound to every keystroke). The
   * in-memory signal is always authoritative regardless of when
   * storage catches up.
   */
  writeDebounceMs?: number;
  /**
   * When true, register `pagehide` and `visibilitychange` listeners
   * that flush any pending debounced write synchronously when the
   * tab is hidden or discarded. iOS Safari's `pagehide` is
   * unreliable, so both listeners are required (pattern matches
   * `preferences.service.ts`'s `flushOnHide`).
   *
   * Only meaningful when `writeDebounceMs > 0`.
   */
  flushOnHide?: boolean;
}

/**
 * Returns a {@link WritableSignal} whose current value is mirrored to
 * `localStorage` under `opts.key`. The signal hydrates from storage on
 * creation; every subsequent change writes through via an `effect()`.
 *
 * MUST be called in an Angular injection context (component class
 * field, service constructor, etc.) so the underlying `effect()` can
 * be registered.
 *
 * Storage exceptions (private mode, quota, blocked) are swallowed -
 * the in-memory signal is always authoritative.
 */
export function persistedSignal<T>(opts: PersistedSignalOptions<T>): WritableSignal<T> {
  const { key, defaultValue, parse, serialize, shouldRemove } = opts;
  const writeDebounceMs = opts.writeDebounceMs ?? 0;
  const flushOnHide = opts.flushOnHide ?? false;
  const isBrowser = typeof window !== 'undefined';

  const initial = readValue(key, defaultValue, parse);
  const sig = signal<T>(initial);

  const writeNow = (): void => {
    // Always read the LIVE signal value at flush time. The point of
    // the flush is to write the latest value, not a stale closure
    // capture from when the effect last fired.
    const value = sig();
    try {
      if (shouldRemove?.(value)) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, serialize(value));
      }
    } catch {
      /* storage unavailable / quota / private mode */
    }
  };

  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelPending = (): void => {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  };
  const flushPending = (): void => {
    if (pendingTimer === null) return;
    cancelPending();
    writeNow();
  };

  effect(() => {
    sig(); // tracked - re-run on every value change
    if (writeDebounceMs > 0 && isBrowser) {
      cancelPending();
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        writeNow();
      }, writeDebounceMs);
    } else {
      writeNow();
    }
  });

  if (writeDebounceMs > 0 && flushOnHide && isBrowser) {
    const onPageHide = (): void => flushPending();
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') flushPending();
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);

    // The `effect()` call above already requires (and asserts) an
    // injection context, so by the time we reach here `inject` is
    // guaranteed to succeed - no `optional: true` / try/catch
    // needed. For root-provided services (DraftService) the
    // DestroyRef is effectively app-lifetime so cleanup is a
    // no-op in practice; for component-scoped callers the cleanup
    // matters and runs on injector teardown.
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => {
      cancelPending();
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    });
  }

  return sig;
}

/**
 * Convenience wrapper around {@link persistedSignal} for the
 * common case: a UTF-8 string that should be `removeItem`'d when
 * empty (so the storage slot doesn't linger as `""`).
 */
export function persistedStringSignal(
  key: string,
  defaultValue = '',
  options?: { writeDebounceMs?: number; flushOnHide?: boolean },
): WritableSignal<string> {
  return persistedSignal<string>({
    key,
    defaultValue,
    parse: (raw) => raw,
    serialize: (value) => value,
    shouldRemove: (value) => value.length === 0,
    writeDebounceMs: options?.writeDebounceMs,
    flushOnHide: options?.flushOnHide,
  });
}

function readValue<T>(key: string, defaultValue: T, parse: (raw: string) => T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return parse(raw);
  } catch {
    return defaultValue;
  }
}
