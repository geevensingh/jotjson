/**
 * Returns 1 if the first code unit of `text` is U+FEFF (the BOM
 * marker), else 0. Only the first code unit is inspected; BOM
 * characters appearing later in the string are ignored. Used to
 * keep parse-tree offsets aligned with the original string offsets
 * downstream consumers index against.
 */
export function bomShift(text: string): 0 | 1 {
  return text.charCodeAt(0) === 0xfeff ? 1 : 0;
}

/**
 * Returns the column (count of UTF-16 code units since the last line
 * break) of the character at string offset `offset`. Backward-scans
 * from `offset - 1`. Counts UTF-16 code units, not graphemes. Treats
 * `\n` (LF) as the only line terminator; bare `\r` (CR) is treated
 * as a regular character, so a CR-only document (legacy classic-Mac
 * EOL) collapses to a single logical line.
 *
 * A leading U+FEFF BOM is treated as zero-width: when the backward
 * scan would otherwise reach index 0 of a BOM-prefixed string, the
 * BOM character is skipped so callers passing full-text offsets get
 * correctly-aligned columns regardless of BOM presence. Mid-string
 * U+FEFF characters are still counted as regular code units.
 */
export function computeColumn(text: string, offset: number): number {
  const floor = bomShift(text);
  let column = 0;
  for (let index = offset - 1; index >= floor; index--) {
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
