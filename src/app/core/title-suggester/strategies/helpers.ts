/**
 * Internal helpers shared across strategies.
 *
 * Strategies receive an `unknown` parsed value (or `undefined` on
 * parse error) and use these guards to safely narrow before
 * inspecting fields.
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NUMERIC_RE = /^-?\d+(?:\.\d+)?$/;

/**
 * Returns true when `value` looks like a machine identifier and
 * should NOT be used as a human-readable title -- UUID, pure
 * numeric, or longer than `maxLen` chars.
 */
export function looksLikeMachineId(value: string, maxLen = 40): boolean {
  if (UUID_RE.test(value)) return true;
  if (NUMERIC_RE.test(value)) return true;
  if (value.length > maxLen) return true;
  return false;
}
