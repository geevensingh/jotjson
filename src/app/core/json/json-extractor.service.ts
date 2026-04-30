import { Injectable, inject } from '@angular/core';
import { format, applyEdits } from 'jsonc-parser';
import { JsonParserService } from './json-parser.service';

export interface ExtractedJson {
  text: string;
  blockCount: number;
  preservesComments: boolean;
}

interface Candidate {
  start: number;
  end: number;
  slice: string;
  value: unknown;
}

const MAX_INPUT_LENGTH = 1_048_576;

const CH_LBRACE = 0x7b; // {
const CH_RBRACE = 0x7d; // }
const CH_LBRACKET = 0x5b; // [
const CH_RBRACKET = 0x5d; // ]
const CH_QUOTE = 0x22; // "
const CH_BACKSLASH = 0x5c; // \
const CH_SLASH = 0x2f; // /
const CH_STAR = 0x2a; // *
const CH_LF = 0x0a; // \n
const CH_BOM = 0xfeff;

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
 *   depth returns to zero, the candidate span is validated through
 *   `JsonParserService`.
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
 */
@Injectable({ providedIn: 'root' })
export class JsonExtractorService {
  private readonly parser = inject(JsonParserService);

  extractFromMixedText(input: string): ExtractedJson | null {
    if (!input) return null;

    const stripped = input.charCodeAt(0) === CH_BOM ? input.slice(1) : input;
    if (stripped.length > MAX_INPUT_LENGTH) return null;

    const candidates = this.scan(stripped);
    if (candidates.length === 0) return null;

    if (candidates.length === 1) {
      const slice = candidates[0].slice;
      const edits = format(slice, undefined, {
        tabSize: 2,
        insertSpaces: true
      });
      return {
        text: applyEdits(slice, edits),
        blockCount: 1,
        preservesComments: true
      };
    }

    return {
      text: JSON.stringify(
        candidates.map((c) => c.value),
        null,
        2
      ),
      blockCount: candidates.length,
      preservesComments: false
    };
  }

  private scan(text: string): Candidate[] {
    const candidates: Candidate[] = [];
    const n = text.length;
    let i = 0;

    while (i < n) {
      const ch = text.charCodeAt(i);
      if (ch !== CH_LBRACE && ch !== CH_LBRACKET) {
        i++;
        continue;
      }

      const start = i;
      const closeIdx = this.findCloseIndex(text, start);
      if (closeIdx !== -1) {
        const slice = text.slice(start, closeIdx + 1);
        const result = this.parser.parse(slice);
        if (
          result.errors.length === 0 &&
          typeof result.value === 'object' &&
          result.value !== null
        ) {
          candidates.push({
            start,
            end: closeIdx + 1,
            slice,
            value: result.value
          });
          i = closeIdx + 1;
          continue;
        }
      }

      i = start + 1;
    }

    return candidates;
  }

  private findCloseIndex(text: string, start: number): number {
    const n = text.length;
    let depth = 1;
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;
    let i = start + 1;

    while (i < n) {
      const ch = text.charCodeAt(i);

      if (inLineComment) {
        if (ch === CH_LF) inLineComment = false;
        i++;
        continue;
      }

      if (inBlockComment) {
        if (
          ch === CH_STAR &&
          i + 1 < n &&
          text.charCodeAt(i + 1) === CH_SLASH
        ) {
          inBlockComment = false;
          i += 2;
          continue;
        }
        i++;
        continue;
      }

      if (inString) {
        if (ch === CH_BACKSLASH) {
          i += 2;
          continue;
        }
        if (ch === CH_QUOTE) inString = false;
        i++;
        continue;
      }

      if (ch === CH_QUOTE) {
        inString = true;
        i++;
        continue;
      }

      if (ch === CH_SLASH && i + 1 < n) {
        const next = text.charCodeAt(i + 1);
        if (next === CH_SLASH) {
          inLineComment = true;
          i += 2;
          continue;
        }
        if (next === CH_STAR) {
          inBlockComment = true;
          i += 2;
          continue;
        }
      }

      if (ch === CH_LBRACE || ch === CH_LBRACKET) {
        depth++;
      } else if (ch === CH_RBRACE || ch === CH_RBRACKET) {
        depth--;
        if (depth === 0) return i;
      }
      i++;
    }

    return -1;
  }
}
