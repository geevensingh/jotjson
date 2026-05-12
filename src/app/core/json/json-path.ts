/**
 * Renders a canonical JSON path (e.g. `$.foo[0]["a.b"]`) for the given
 * segment array. Numeric segments are rendered as `[N]`; segments that
 * match a bare identifier are rendered as `.name`; everything else is
 * rendered as `[JSON.stringify(seg)]`.
 *
 * Extracted so the perf-build path and the SPA share one definition
 * with no Angular DI context. The file has zero repo-internal imports.
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
