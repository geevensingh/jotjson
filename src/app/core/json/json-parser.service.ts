import { inject, Injectable } from '@angular/core';
import { getNodePath, Node as JsoncNode, ParseError, parseTree } from 'jsonc-parser';
import { bucketBytes } from '../telemetry/buckets';
import { isColdAndMark } from '../telemetry/cold-flag';
import { LoggerService } from '../telemetry/logger.service';
import type { JsonParseResult } from './parse';
import {
  locationAt as pureLocationAt,
  offsetToPosition as pureOffsetToPosition,
  parse as pureParse,
  pathToString as purePathToString,
} from './parse';

// Re-export the types from parse.ts so existing callers keep their
// `from './json-parser.service'` imports working.
export type { CommentBundle, JsonParseError, JsonParseResult } from './parse';

/**
 * Wraps jsonc-parser. JotJSON accepts JSON with comments and trailing commas
 * (JSONC) so users can paste config-file snippets. See DESIGN_SPEC.md.
 *
 * The pure JSONC parsing logic (parse, harvestComments, nodeToValue,
 * pathToString, etc.) lives in `./parse.ts` so it can run in a Node
 * bench harness with no Angular DI context (see `perf/bench/parse.bench.ts`
 * and `docs/perf.md`). This service is a thin wrapper that emits
 * `parse.slow` telemetry around the pure call.
 */
@Injectable({ providedIn: 'root' })
export class JsonParserService {
  private readonly logger = inject(LoggerService);

  parse(text: string): JsonParseResult {
    if (!text || text.trim().length === 0) {
      return pureParse(text);
    }
    const start = performance.now();
    const result = pureParse(text);
    const timeMs = performance.now() - start;
    if (timeMs > 50) {
      const sizeBytes = new Blob([text]).size;
      this.logger.event(
        'parse.slow',
        {
          cold: isColdAndMark('parse.slow'),
          sizeBytesBucket: bucketBytes(sizeBytes),
        },
        { timeMs, sizeBytes },
      );
    }
    return result;
  }

  offsetToPosition(text: string, offset: number): { line: number; column: number } {
    return pureOffsetToPosition(text, offset);
  }

  locationAt(text: string, offset: number): (string | number)[] {
    return pureLocationAt(text, offset);
  }

  pathToString(path: (string | number)[]): string {
    return purePathToString(path);
  }

  /**
   * Rewrites the canonical (`$`-prefixed) path string into the user's
   * preferred clipboard form. Internal usage of `pathString` keeps the
   * canonical form everywhere; only the text written to the clipboard
   * passes through this transform.
   *
   * - `jsonpath`: unchanged (e.g. `$.foo[0]`).
   * - `none`:     strip the leading `$` and any following `.` so dotted
   *               paths become bare identifiers (lodash-style):
   *               `$.foo[0]` -> `foo[0]`, `$["a.b"]` -> `["a.b"]`.
   * - `root`:     replace leading `$` with `root` -> `root.foo[0]`.
   * - `data`:     replace leading `$` with `Data` (capital D) ->
   *               `Data.foo[0]`.
   *
   * Callers should always pass a string produced by `pathToString` (or
   * the equivalent in-tree formatter) so the leading `$` invariant
   * holds.
   */
  formatPathForClipboard(canonical: string, mode: 'jsonpath' | 'none' | 'root' | 'data'): string {
    switch (mode) {
      case 'jsonpath':
        return canonical;
      case 'root':
        return canonical.replace(/^\$/, 'root');
      case 'data':
        return canonical.replace(/^\$/, 'Data');
      case 'none':
        // Strip the `$` and a single following `.` if present, so
        // `$.foo` -> `foo` while `$["a.b"]` -> `["a.b"]` and
        // `$[0]` -> `[0]`.
        return canonical.replace(/^\$\.?/, '');
    }
  }

  pathForNode(node: JsoncNode): (string | number)[] {
    return [...getNodePath(node)];
  }

  /**
   * Attempts to detect and unescape a JSON string that has been "escaped"
   * into another string - common when JSON is copied from logs, debuggers,
   * stringified fields, or HTTP response bodies. See issue #38.
   *
   * Policy:
   * - If `text` already parses as JSON/JSONC with zero errors, do nothing.
   *   (Escaping is a repair mechanism, not a transform on valid input.)
   * - Otherwise, try several unescape strategies in order and return the
   *   first one whose output parses cleanly and looks like an object/array.
   *
   * Returns `{ unescaped, changed }`. When `changed` is false, `unescaped`
   * is the original `text` verbatim.
   */
  tryUnescape(text: string): { unescaped: string; changed: boolean } {
    if (!text || text.trim().length === 0) {
      return { unescaped: text, changed: false };
    }
    if (this.parsesCleanly(text)) {
      // Only short-circuit when the input is already a "real" JSON document
      // (object or array at top level). A quoted JSON-string-of-JSON is also
      // a valid JSON document, but it is exactly the case we want to
      // unescape - so fall through to the strategies below.
      const trimmedEarly = text.trim();
      if (trimmedEarly.startsWith('{') || trimmedEarly.startsWith('[')) {
        return { unescaped: text, changed: false };
      }
    }

    const candidates: string[] = [];
    const trimmed = text.trim();

    // Strategy 1 (quoted): the text is itself a JSON string literal like
    // '"{\"a\":1}"'. JSON.parse extracts the inner string.
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
      try {
        const inner = JSON.parse(trimmed) as unknown;
        if (typeof inner === 'string') candidates.push(inner);
      } catch {
        // fall through to other strategies
      }
    }

    // Strategy 2 (bare): text contains escape sequences but no enclosing
    // quotes, e.g. '{\"a\":1}'. Wrap and parse.
    try {
      const inner = JSON.parse('"' + text + '"') as unknown;
      if (typeof inner === 'string') candidates.push(inner);
    } catch {
      // fall through
    }

    // Strategy 3 (bare + raw whitespace): same as #2 but also pre-escape
    // literal CR/LF/TAB bytes that would otherwise make the wrap parse fail.
    try {
      const pre = text
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t');
      // Strategy 3 intentionally re-escapes everything including already-
      // escaped sequences; this is useful for mixed payloads where a log
      // collector has stringified both real newlines and escape sequences.
      const inner = JSON.parse('"' + pre + '"') as unknown;
      if (typeof inner === 'string') candidates.push(inner);
    } catch {
      // fall through
    }

    for (const candidate of candidates) {
      const trimmed = candidate.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
      if (this.parsesCleanly(candidate)) {
        return { unescaped: candidate, changed: true };
      }
    }

    return { unescaped: text, changed: false };
  }

  /**
   * Returns a JSON string literal encoding of `text` - i.e., the value you
   * would get by `JSON.stringify(text)`. Used by the toolbar's Alt+Copy
   * affordance to produce an "escaped" version of the editor contents that
   * can be embedded inside another JSON document as a string value.
   */
  escapeAsJsonString(text: string): string {
    return JSON.stringify(text);
  }

  private parsesCleanly(text: string): boolean {
    const errors: ParseError[] = [];
    parseTree(text, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    return errors.length === 0;
  }
}
