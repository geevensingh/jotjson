import { inject, Injectable } from '@angular/core';
import {
  parseTree,
  ParseError,
  printParseErrorCode,
  Node as JsoncNode,
  getLocation,
  getNodePath
} from 'jsonc-parser';
import { bucketBytes } from '../telemetry/buckets';
import { isColdAndMark } from '../telemetry/cold-flag';
import { LoggerService } from '../telemetry/logger.service';

export interface JsonParseError {
  message: string;
  offset: number;
  length: number;
  line: number;
  column: number;
}

export interface JsonParseResult {
  value: unknown;
  ast: JsoncNode | undefined;
  errors: JsonParseError[];
  empty: boolean;
}

/**
 * Wraps jsonc-parser. JotJSON accepts JSON with comments and trailing commas
 * (JSONC) so users can paste config-file snippets. See DESIGN_SPEC.md.
 */
@Injectable({ providedIn: 'root' })
export class JsonParserService {
  private readonly logger = inject(LoggerService);

  parse(text: string): JsonParseResult {
    if (!text || text.trim().length === 0) {
      return { value: undefined, ast: undefined, errors: [], empty: true };
    }

    const start = performance.now();

    // Strip a leading UTF-8/UTF-16 BOM (U+FEFF). Many Windows editors and
    // older file-exporting tools prefix JSON with a BOM, which jsonc-parser
    // reports as an InvalidSymbol error at offset 0. A BOM is a file-level
    // encoding artifact, not part of the JSON grammar, so we silently elide.
    const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

    const rawErrors: ParseError[] = [];
    const ast = parseTree(stripped, rawErrors, {
      allowTrailingComma: true,
      disallowComments: false
    });

    const errors = rawErrors.map((parseError) =>
      this.toError(parseError, stripped)
    );
    const value = ast ? this.nodeToValue(ast) : undefined;

    const result: JsonParseResult = { value, ast, errors, empty: false };
    const timeMs = performance.now() - start;
    if (timeMs > 50) {
      const sizeBytes = new Blob([text]).size;
      this.logger.event(
        'parse.slow',
        {
          cold: isColdAndMark('parse.slow'),
          sizeBytesBucket: bucketBytes(sizeBytes)
        },
        { timeMs, sizeBytes }
      );
    }
    return result;
  }

  offsetToPosition(text: string, offset: number): { line: number; column: number } {
    let line = 1;
    let col = 1;
    const clamped = Math.max(0, Math.min(offset, text.length));
    for (let i = 0; i < clamped; i++) {
      if (text.charCodeAt(i) === 10) {
        line++;
        col = 1;
      } else {
        col++;
      }
    }
    return { line, column: col };
  }

  locationAt(text: string, offset: number): (string | number)[] {
    const loc = getLocation(text, offset);
    return [...loc.path];
  }

  pathToString(path: (string | number)[]): string {
    let out = '$';
    for (const seg of path) {
      if (typeof seg === 'number') {
        out += `[${seg}]`;
      } else if (/^[A-Za-z_$][\w$]*$/.test(seg)) {
        out += `.${seg}`;
      } else {
        out += `[${JSON.stringify(seg)}]`;
      }
    }
    return out;
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
  formatPathForClipboard(
    canonical: string,
    mode: 'jsonpath' | 'none' | 'root' | 'data'
  ): string {
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
    if (
      trimmed.length >= 2 &&
      trimmed.startsWith('"') &&
      trimmed.endsWith('"')
    ) {
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
      disallowComments: false
    });
    return errors.length === 0;
  }

  private toError(parseError: ParseError, text: string): JsonParseError {
    const { line, column } = this.offsetToPosition(text, parseError.offset);
    return {
      message: printParseErrorCode(parseError.error),
      offset: parseError.offset,
      length: parseError.length,
      line,
      column
    };
  }

  private nodeToValue(node: JsoncNode): unknown {
    switch (node.type) {
      case 'null':
        return null;
      case 'boolean':
      case 'number':
      case 'string':
        return node.value;
      case 'array':
        return (node.children ?? []).map((c) => this.nodeToValue(c));
      case 'object': {
        const obj: Record<string, unknown> = {};
        for (const prop of node.children ?? []) {
          const [keyNode, valueNode] = prop.children ?? [];
          if (keyNode && valueNode) {
            obj[String(keyNode.value)] = this.nodeToValue(valueNode);
          }
        }
        return obj;
      }
      default:
        return undefined;
    }
  }
}
