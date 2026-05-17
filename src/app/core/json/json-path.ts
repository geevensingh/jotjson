/**
 * Renders a canonical JSON path (e.g. `$.foo[0]["a.b"]`) for the given
 * segment array. Numeric segments are rendered as `[N]`; segments that
 * match a bare identifier are rendered as `.name`; everything else is
 * rendered as `[JSON.stringify(seg)]`.
 *
 * Extracted so the perf-build path and the SPA share one definition
 * with no Angular DI context. The file has zero repo-internal imports.
 *
 * Bound to `displayKey` in `./key-display.ts`: both helpers JSON-escape
 * keys via the same `JSON.stringify` transform today. If either widens
 * its escape set (for example, a Unicode property-class regex pass),
 * the other must widen in lockstep, otherwise copy-path output
 * silently diverges from inline rendering. The `key-display.spec.ts`
 * parameterized lock-step test pins this equivalence. The current
 * zero-imports invariant on this module (perf-build constraint) makes
 * shared-helper extraction non-trivial today; if both helpers ever
 * gain non-trivial widening logic, prefer delegating one to the other
 * over maintaining parallel implementations.
 */

export function pathToString(path: readonly (string | number)[]): string {
  let out = '$';
  for (const seg of path) {
    if (typeof seg === 'number') {
      out += `[${seg}]`;
    } else if (/^[A-Za-z_$][\w$]*$/.test(seg)) {
      out += `.${seg}`;
    } else {
      out += `[${JSON.stringify(seg)}]`;
    }
  }
  return out;
}
