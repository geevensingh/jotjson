/**
 * Returns the JSON-escaped inline display form of an object key,
 * suitable for `.tree-key` spans (tree rows) and breadcrumb chip
 * labels. The transform is `JSON.stringify(segment).slice(1, -1)`.
 *
 * Escapes (per ECMA-262 25.5.2 QuoteJSONString):
 *   - Short escapes for `\b \t \n \f \r " \`
 *   - `\uXXXX` (lowercase hex) for C0 controls U+0000-U+001F (apart
 *     from the named ones above) and unpaired surrogates.
 *
 * Bare keys (no escape-worthy character) return unchanged.
 *
 * Passes through unescaped (intentional known-limit set; the
 * "predictable rendering" goal stops at what `JSON.stringify` itself
 * escapes, so that this helper and `pathToString` agree byte-for-byte
 * without either growing a Unicode-property regex pass):
 *   - DEL (U+007F) and C1 controls U+0080-U+009F
 *   - Unicode whitespace and format codepoints (NBSP U+00A0,
 *     line/paragraph separators U+2028 / U+2029, zero-widths
 *     U+200B / U+200C / U+200D, BOM/ZWNBSP U+FEFF, ideographic
 *     space U+3000, the rest of `\p{Zs}` and `\p{Cf}`)
 *   - Combining marks (`\p{Mn}`) and variation selectors
 *     (U+FE00-U+FE0F, U+E0100-U+E01EF)
 *   - Astral codepoints (paired surrogates render as the glyph)
 *
 * Companion to `displayLeaf` in `json-tree.component.ts` (the value-
 * rendering analog). The difference: `displayLeaf` returns the quoted
 * `JSON.stringify` form (`"foo"`); `displayKey` strips wrapping
 * quotes so bare keys read naturally in the tree.
 *
 * Bound to `pathToString` in `./json-path.ts`. Both helpers share the
 * `JSON.stringify` transform today. If this helper widens what it
 * escapes (e.g. a Unicode property-class regex pass), `pathToString`'s
 * non-bare-key branch must widen in lockstep, otherwise copy-path
 * output silently diverges from inline rendering. The
 * `key-display.spec.ts` parameterized lock-step test asserts this
 * equivalence and will fail loudly on drift.
 *
 * See DESIGN_SPEC.md "Inline rendering of keys".
 */
export function displayKey(segment: string): string {
  return JSON.stringify(segment).slice(1, -1);
}
