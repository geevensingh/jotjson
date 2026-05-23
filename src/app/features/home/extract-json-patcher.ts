import type { ParseError } from 'jsonc-parser';
import { applyEdits, findNodeAtLocation, parseTree } from 'jsonc-parser';
import type { ExtractedJson } from '../../core/json/json-extractor.service';
import { bomShift, computeColumn, reindentReplacement } from './json-patch-utils';

export interface PatchResult {
  patched: string;
  targetOffset: number;
  targetLength: number;
  /**
   * The text actually spliced in (post-reindent). Equal to `patched.substring(targetOffset, targetOffset + replacementText.length)`.
   */
  replacementText: string;
}

export function patchExtractedValue(
  text: string,
  path: (string | number)[],
  replacement: ExtractedJson,
): PatchResult {
  const shift = bomShift(text);
  const parseText = shift > 0 ? text.slice(shift) : text;
  const errors: ParseError[] = [];
  const root = parseTree(parseText, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (!root || errors.length > 0) {
    throw new Error('extract.patch.parse-failed');
  }

  const target = findNodeAtLocation(root, path);
  if (!target) {
    throw new Error('extract.patch.path-not-found');
  }

  const targetOffset = target.offset + shift;
  const column = computeColumn(text, targetOffset);
  const indented = reindentReplacement(replacement.text, column);
  const patched = applyEdits(text, [
    { offset: targetOffset, length: target.length, content: indented },
  ]);
  return {
    patched,
    targetOffset,
    targetLength: target.length,
    replacementText: indented,
  };
}
