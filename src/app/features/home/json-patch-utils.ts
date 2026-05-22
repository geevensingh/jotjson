/**
 * Returns 1 if `text` starts with a UTF-8 BOM (U+FEFF), else 0. Used
 * to keep parse-tree offsets aligned with the original-bytes offsets
 * downstream consumers index against.
 */
export function bomShift(text: string): 0 | 1 {
  return text.charCodeAt(0) === 0xfeff ? 1 : 0;
}

/**
 * Returns the column (count of characters since the last `\n`) of
 * the character at byte index `offset`. Backward-scans from
 * `offset - 1`. Counts UTF-16 code units, not graphemes.
 */
export function computeColumn(text: string, offset: number): number {
  let column = 0;
  for (let index = offset - 1; index >= 0; index--) {
    const character = text[index];
    if (character === '\n') break;
    column++;
  }
  return column;
}

/**
 * Returns `replacementText` with every non-first line prefixed by
 * `column` spaces. Used to align a multi-line replacement to the
 * indent of the splice target. Single-line and zero-column inputs
 * are returned by reference.
 */
export function reindentReplacement(replacementText: string, column: number): string {
  if (column === 0) return replacementText;
  const lines = replacementText.split('\n');
  if (lines.length === 1) return replacementText;
  const indent = ' '.repeat(column);
  return lines.map((line, index) => (index === 0 ? line : indent + line)).join('\n');
}
