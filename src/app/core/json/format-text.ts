import { applyEdits as jsoncApplyEdits, format as jsoncFormat } from 'jsonc-parser';

/**
 * Pure helper that formats JSON / JSONC text using the jsonc-parser
 * format + applyEdits pipeline. Returns the input unchanged when the
 * formatter produces no edits (already-formatted input or empty
 * string). Used by HomeComponent's `onFormat()` handler AND by `onPaste`
 * to compose unescape+format inline without installing a Format
 * snackbar.
 */
export function formatText(text: string, tabSize: number): string {
  const edits = jsoncFormat(text, undefined, {
    tabSize,
    insertSpaces: true,
    eol: '\n',
  });
  return jsoncApplyEdits(text, edits);
}
