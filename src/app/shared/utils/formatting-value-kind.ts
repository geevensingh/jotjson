import type { ValueKind } from '../../core/api/models';

export type { ValueKind } from '../../core/api/models';

/**
 * Classifies a parsed JSON or JSONC value for formatting predicates.
 * This helper is intentionally deterministic and does not read user
 * preferences; preference-sensitive search classification lives in
 * value-classifier.ts.
 */
export function classifyJsonValue(value: unknown): ValueKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';

  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'boolean':
      return 'boolean';
    case 'bigint':
      return 'integer';
    case 'object':
      return 'object';
    default:
      // jsonc-parser emits JSON-compatible values. If a future parser
      // supplies another primitive, keep predicate evaluation total and
      // classify it as a string rather than throwing during render.
      return 'string';
  }
}

/**
 * Returns true only for JSON values that are empty under the pair-rule
 * predicate contract: the exact empty string, an empty array, or an
 * object with zero own enumerable entries.
 */
export function isJsonValueEmpty(value: unknown): boolean {
  if (typeof value === 'string') return value === '';
  if (Array.isArray(value)) return value.length === 0;
  if (value !== null && typeof value === 'object') {
    // Parsed JSON objects are plain records; for non-JSON objects, own
    // enumerable keys keep this deterministic and side-effect free.
    return Object.keys(value).length === 0;
  }
  return false;
}
