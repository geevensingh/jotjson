import type { ParseError } from 'jsonc-parser';
import { applyEdits, findNodeAtLocation, parseTree } from 'jsonc-parser';
import type { ExtractedJson } from '../../core/json/json-extractor.service';

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
  const bomShift = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const parseText = bomShift > 0 ? text.slice(bomShift) : text;
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

  const targetOffset = target.offset + bomShift;
  const column = computeColumn(text, targetOffset);
  const indented = reindent(replacement.text, column);
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

function computeColumn(text: string, offset: number): number {
  let column = 0;
  for (let index = offset - 1; index >= 0; index--) {
    const character = text[index];
    if (character === '\n') break;
    column++;
  }
  return column;
}

function reindent(replacementText: string, column: number): string {
  if (column === 0) return replacementText;
  const lines = replacementText.split('\n');
  if (lines.length === 1) return replacementText;
  const indent = ' '.repeat(column);
  return lines.map((line, index) => (index === 0 ? line : indent + line)).join('\n');
}
