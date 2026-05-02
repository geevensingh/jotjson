import { applyEdits, format as formatJsonc } from 'jsonc-parser';

export interface ExtractedJson {
  text: string;
  blockCount: number;
  preservesComments: boolean;
  /**
   * True when at least one accepted candidate's slice contained a JSONC
   * comment (`//` line or `/* ... *\/` block). Used by the home component
   * to decide whether to surface a "Comments will be dropped" warning in
   * the multi-block case (`!preservesComments && hasComments`). Comments
   * inside JSON strings and `//`-like sequences in surrounding prose do
   * NOT count.
   */
  hasComments: boolean;
}

export interface JsonExtractorParseResult {
  value: unknown;
  errors: readonly unknown[];
}

export type ParseJsonCandidate = (candidateText: string) => JsonExtractorParseResult;

export interface JsonExtractorCandidate {
  startIndex: number;
  endIndex: number;
  slice: string;
  value: unknown;
  hasComments: boolean;
}

export interface CloseScan {
  closeIndex: number;
  hasComments: boolean;
}

export const MAX_INPUT_LENGTH = 1_048_576;

const CHARACTER_LEFT_BRACE = 0x7b; // {
const CHARACTER_RIGHT_BRACE = 0x7d; // }
const CHARACTER_LEFT_BRACKET = 0x5b; // [
const CHARACTER_RIGHT_BRACKET = 0x5d; // ]
const CHARACTER_QUOTE = 0x22; // "
const CHARACTER_BACKSLASH = 0x5c; // \
const CHARACTER_SLASH = 0x2f; // /
const CHARACTER_STAR = 0x2a; // *
const CHARACTER_LINE_FEED = 0x0a; // \n
const CHARACTER_BYTE_ORDER_MARK = 0xfeff;

/**
 * Extracts JSON/JSONC blocks from prose-and-JSON mixed text (chat logs,
 * docs, console output). Designed to be robust against URLs, apostrophes,
 * and JSON-like substrings that appear inside string literals.
 *
 * Algorithm (single-pass, two-mode):
 * - Prose mode reacts only to `{` and `[`. Quotes/comments in prose are
 *   ignored so e.g. an apostrophe in `it's` does not desync the scanner.
 * - JSON mode is entered at a `{` or `[`, tracks brace depth, JSON strings
 *   (with `\` escapes), and JSONC `//` line and block comments. When the
 *   depth returns to zero, the candidate span is validated through the
 *   supplied parser callback.
 *
 * On parse success the scan resumes after the candidate span. On parse
 * failure the scan resumes at `start+1` so an invalid outer wrapper does
 * not hide a valid inner block (e.g. `INFO {notJson: {"real":1}}` recovers
 * the inner `{"real":1}`). Each failure advances at least one byte, so
 * scanning is bounded.
 *
 * Outputs:
 * - 0 candidates: `null`.
 * - 1 candidate:  `text` is the slice formatted via `jsonc-parser.format`,
 *                 which preserves comments. `preservesComments = true`.
 * - >=2: `text` is `JSON.stringify` of the array of parsed values in source
 *         order. `preservesComments = false` because comments cannot
 *         survive `JSON.stringify`.
 *
 * `hasComments` is true when at least one accepted candidate's slice
 * contained a JSONC comment. It is independent of `preservesComments`: it
 * describes whether the SOURCE had comments; `preservesComments` describes
 * whether the OUTPUT FORMAT can carry them.
 */
export function extractFromMixedText(
  input: string,
  parseJsonCandidate: ParseJsonCandidate,
): ExtractedJson | null {
  if (!input) return null;

  const strippedInput = input.charCodeAt(0) === CHARACTER_BYTE_ORDER_MARK ? input.slice(1) : input;
  if (strippedInput.length > MAX_INPUT_LENGTH) return null;

  const candidates = scan(strippedInput, parseJsonCandidate);
  if (candidates.length === 0) return null;

  if (candidates.length === 1) {
    const [candidate] = candidates;
    if (candidate === undefined) return null;

    return {
      text: formatExtractedJson(candidate.slice),
      blockCount: 1,
      preservesComments: true,
      hasComments: candidate.hasComments,
    };
  }

  return {
    text: JSON.stringify(
      candidates.map((candidate) => candidate.value),
      null,
      2,
    ),
    blockCount: candidates.length,
    preservesComments: false,
    hasComments: candidates.some((candidate) => candidate.hasComments),
  };
}

export function scan(
  text: string,
  parseJsonCandidate: ParseJsonCandidate,
): JsonExtractorCandidate[] {
  const candidates: JsonExtractorCandidate[] = [];
  const textLength = text.length;
  let index = 0;

  while (index < textLength) {
    const characterCode = text.charCodeAt(index);
    if (characterCode !== CHARACTER_LEFT_BRACE && characterCode !== CHARACTER_LEFT_BRACKET) {
      index++;
      continue;
    }

    const startIndex = index;
    const closeScan = findCloseIndex(text, startIndex);
    if (closeScan.closeIndex !== -1) {
      const slice = text.slice(startIndex, closeScan.closeIndex + 1);
      const result = parseJsonCandidate(slice);
      if (result.errors.length === 0 && typeof result.value === 'object' && result.value !== null) {
        candidates.push({
          startIndex,
          endIndex: closeScan.closeIndex + 1,
          slice,
          value: result.value,
          hasComments: closeScan.hasComments,
        });
        index = closeScan.closeIndex + 1;
        continue;
      }
    }

    index = startIndex + 1;
  }

  return candidates;
}

export function formatExtractedJson(slice: string): string {
  const edits = formatJsonc(slice, undefined, {
    tabSize: 2,
    insertSpaces: true,
  });
  return applyEdits(slice, edits);
}

export function findCloseIndex(text: string, startIndex: number): CloseScan {
  const textLength = text.length;
  let depth = 1;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let hasComments = false;
  let index = startIndex + 1;

  while (index < textLength) {
    const characterCode = text.charCodeAt(index);

    if (inLineComment) {
      if (characterCode === CHARACTER_LINE_FEED) inLineComment = false;
      index++;
      continue;
    }

    if (inBlockComment) {
      if (
        characterCode === CHARACTER_STAR &&
        index + 1 < textLength &&
        text.charCodeAt(index + 1) === CHARACTER_SLASH
      ) {
        inBlockComment = false;
        index += 2;
        continue;
      }
      index++;
      continue;
    }

    if (inString) {
      if (characterCode === CHARACTER_BACKSLASH) {
        index += 2;
        continue;
      }
      if (characterCode === CHARACTER_QUOTE) inString = false;
      index++;
      continue;
    }

    if (characterCode === CHARACTER_QUOTE) {
      inString = true;
      index++;
      continue;
    }

    if (characterCode === CHARACTER_SLASH && index + 1 < textLength) {
      const nextCharacterCode = text.charCodeAt(index + 1);
      if (nextCharacterCode === CHARACTER_SLASH) {
        inLineComment = true;
        hasComments = true;
        index += 2;
        continue;
      }
      if (nextCharacterCode === CHARACTER_STAR) {
        inBlockComment = true;
        hasComments = true;
        index += 2;
        continue;
      }
    }

    if (characterCode === CHARACTER_LEFT_BRACE || characterCode === CHARACTER_LEFT_BRACKET) {
      depth++;
    } else if (
      characterCode === CHARACTER_RIGHT_BRACE ||
      characterCode === CHARACTER_RIGHT_BRACKET
    ) {
      depth--;
      if (depth === 0) return { closeIndex: index, hasComments };
    }
    index++;
  }

  return { closeIndex: -1, hasComments };
}
