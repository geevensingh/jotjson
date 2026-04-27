import { effect, signal, WritableSignal } from '@angular/core';

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

  const initial = readValue(key, defaultValue, parse);
  const sig = signal<T>(initial);

  effect(() => {
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
  });

  return sig;
}

/**
 * Convenience wrapper around {@link persistedSignal} for the
 * common case: a UTF-8 string that should be `removeItem`'d when
 * empty (so the storage slot doesn't linger as `""`).
 */
export function persistedStringSignal(
  key: string,
  defaultValue = ''
): WritableSignal<string> {
  return persistedSignal<string>({
    key,
    defaultValue,
    parse: (raw) => raw,
    serialize: (value) => value,
    shouldRemove: (value) => value.length === 0
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
