import type { Node, ParseError } from 'jsonc-parser';
import { applyEdits, findNodeAtLocation, parseTree } from 'jsonc-parser';
import { decodeLossyMangling, type LossyManglingKind } from '../../core/text/lossy-mangling';
import { bomShift } from './json-patch-utils';

/**
 * Patcher that rewrites a single JSON string literal in `text` by
 * replacing it with the lossy-mangling-decoded form of its current
 * value. Mirrors the shape of {@link patchExtractedValue} but with
 * three deliberate differences:
 *
 * 1. The transformation rule lives at the patcher boundary (not in
 *    the request envelope). Callers pass `manglingKind` and the
 *    patcher derives `decoded = decodeLossyMangling(rawValue, kind)`
 *    from the current source. Mirrors the `patchSortKeysAtPath`
 *    precedent (sort derives from source given `path`).
 * 2. The replacement is a JSON string literal (single line at the
 *    source level, with `\r\n` escapes inside), so no reindentation
 *    is needed. `JSON.stringify(decoded)` produces the wrapping-quote
 *    JSON-escaped form.
 * 3. `applyEdits` operates on the ORIGINAL `text` (BOM-bearing).
 *    `parseText` is the BOM-stripped variant used only for parsing;
 *    `targetOffset = target.offset + shift` re-aligns the offset to
 *    the original buffer so the BOM byte at offset 0 is preserved.
 */
export interface DecodedApplyPatchResult {
  patched: string;
  targetOffset: number;
  targetLength: number;
  /**
   * The JSON string literal actually spliced in (wrapping quotes plus
   * JSON-escaped content). Equal to
   * `patched.substring(targetOffset, targetOffset + replacementText.length)`.
   */
  replacementText: string;
}

export function patchDecodedString(
  text: string,
  path: (string | number)[],
  manglingKind: LossyManglingKind,
): DecodedApplyPatchResult {
  const shift = bomShift(text);
  const parseText = shift > 0 ? text.slice(shift) : text;
  const errors: ParseError[] = [];
  const root = parseTree(parseText, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (!root || errors.length > 0) {
    throw new Error('decoded.apply.parse-failed');
  }

  const target: Node | undefined = findNodeAtLocation(root, path);
  if (!target) {
    throw new Error('decoded.apply.path-not-found');
  }
  if (target.type !== 'string') {
    throw new Error('decoded.apply.not-string');
  }

  const rawValue = target.value as string;
  const decoded = decodeLossyMangling(rawValue, manglingKind);
  const replacementText = JSON.stringify(decoded);
  const targetOffset = target.offset + shift;
  const targetLength = target.length;
  const patched = applyEdits(text, [
    { offset: targetOffset, length: targetLength, content: replacementText },
  ]);
  return {
    patched,
    targetOffset,
    targetLength,
    replacementText,
  };
}
