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

/**
 * Walks a path of object keys (e.g. `['data', 'baseData', 'name']`)
 * and returns the trimmed non-empty string at the leaf, or `null` if
 * any intermediate step is not a plain object or the leaf is not a
 * non-empty string.
 *
 * Uses `isPlainObject` at every step (rather than `obj.hasOwnProperty`
 * or other `Object.prototype`-derived helpers) so null-prototype
 * objects produced by the production parser
 * (`src/app/core/json/parse.ts` allocates via `Object.create(null)`
 * to preserve `__proto__` keys per #365) are handled safely --
 * calling `nullProto.hasOwnProperty('x')` throws because
 * `Object.prototype` is not on the chain, but bracket access and
 * `typeof` work fine.
 */
export function readStringDeep(
  obj: Record<string, unknown>,
  path: readonly string[],
): string | null {
  if (path.length === 0) return null;
  let cursor: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (!isPlainObject(cursor)) return null;
    cursor = cursor[path[i]!];
  }
  if (!isPlainObject(cursor)) return null;
  return readString(cursor, path[path.length - 1]!);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NUMERIC_RE = /^-?\d+(?:\.\d+)?$/;

const HEX_ONLY_RE = /^[0-9a-f]+$/i;

const LETTER_RE = /[A-Za-z]/;

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

/**
 * Returns true when `value` is plausibly a human-quotable business
 * identifier (something a person might say or read aloud, like an
 * invoice or order number).
 *
 * Rejects:
 *  - strings outside the 3-24 char window (too short to be
 *    meaningful, too long to read like a quotable ID)
 *  - strings with whitespace
 *  - strings without at least one letter (rejects raw numeric
 *    surrogate keys like `"6567005828"`)
 *  - UUIDs
 *  - any remaining pure-numeric string (defensive belt-and-braces
 *    against future relaxations of the letter requirement)
 *  - strings of length 16 or more containing only hex digits (W3C
 *    trace IDs, opaque machine tokens)
 *
 * Accepts: "G138888993", "ABC-123", "INV-2026-001", etc.
 */
export function looksLikeBusinessId(value: string): boolean {
  if (value.length < 3 || value.length > 24) return false;
  if (/\s/.test(value)) return false;
  if (!LETTER_RE.test(value)) return false;
  if (UUID_RE.test(value)) return false;
  if (NUMERIC_RE.test(value)) return false;
  if (value.length >= 16 && HEX_ONLY_RE.test(value)) return false;
  return true;
}
