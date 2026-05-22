/**
 * JS `<` on strings is UTF-16 code-unit compare (not code point); this matches
 * `jq --sort-keys` and Python `json.dumps(sort_keys=True)` in practice.
 */
export function compareKeysCodeunit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Recursively returns a sorted copy of a JSON-like value. Arrays are rebuilt
 * with their element order preserved while values inside them are recursively
 * sorted. Objects are rebuilt as null-prototype records so an own `__proto__`
 * key is preserved as data instead of invoking the legacy prototype setter
 * during assignment.
 */
export function sortKeysDeep<T>(value: T, cmp?: (a: string, b: string) => number): T {
  const comparator = cmp ?? compareKeysCodeunit;

  if (Array.isArray(value)) {
    const arrayValue: unknown[] = value;
    return arrayValue.map((element) => sortKeysDeep(element, comparator)) as T;
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const sourceRecord = value as Record<string, unknown>;
  const sortedRecord = Object.create(null) as Record<string, unknown>;
  const sortedKeys = Object.keys(sourceRecord).sort(comparator);

  for (const key of sortedKeys) {
    sortedRecord[key] = sortKeysDeep(sourceRecord[key], comparator);
  }

  return sortedRecord as T;
}
