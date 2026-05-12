/**
 * Pure JSON value-type discriminant. Extracted so the perf-build path
 * (`tsc -p tsconfig.perf.json`) and the SPA can share one definition
 * with no Angular DI context.
 *
 * The file has zero repo-internal imports (only stdlib types), so it
 * is safe to include in the perf-build emit alongside `parse.ts`,
 * `build-tree.ts`, and `json-path.ts`.
 */

export type JsonValueType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'undefined';

export function jsonTypeOf(value: unknown): JsonValueType {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}
