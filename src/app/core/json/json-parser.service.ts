import { inject, Injectable } from '@angular/core';
import {
  getLocation,
  getNodePath,
  Node as JsoncNode,
  ParseError,
  parseTree,
  printParseErrorCode,
  visit,
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

/**
 * A bundle of leading / trailing / close-trailing JSONC comments
 * attached to a single canonical path (e.g. `$.foo[0]`).
 *
 * Each field, when present, may carry multiple stacked comments
 * separated by `\n`. Each rendering layer is responsible for picking a
 * single-line preview (e.g. the first line) and surfacing the full
 * multi-comment text via tooltip.
 *
 * - `leading`: rendered before the key on the value row (or container
 *   open row).
 * - `trailing`: rendered on the value's primary row -- after the value
 *   for leaves, after the open brace for containers.
 * - `closeLeading`: rendered on the close row of a container, BEFORE
 *   the close brace. Carries comments that appear between the
 *   container's last child (or its open brace, for comment-only
 *   containers) and the close brace, on their own source line(s).
 * - `closeTrailing`: rendered on the close row of a container, AFTER
 *   the close brace. Carries comments that appear on the same source
 *   line as the close brace, after it. Both close-row fields are
 *   only meaningful for object / array nodes. For nodes that render
 *   inline as a single row (primitives and empty containers),
 *   renderers MERGE `trailing`, `closeLeading`, and `closeTrailing`
 *   into the single trailing slot so that no comment is hidden.
 *
 * See DESIGN_SPEC.md M7k Decision B for the full attachment ruleset.
 */
export interface CommentBundle {
  leading?: string;
  trailing?: string;
  closeLeading?: string;
  closeTrailing?: string;
}

export interface JsonParseResult {
  value: unknown;
  ast: JsoncNode | undefined;
  errors: JsonParseError[];
  empty: boolean;
  commentsByPath: ReadonlyMap<string, CommentBundle>;
  /**
   * Total number of individual comments seen during the harvest pass.
   * Counted before stacked comments are joined into the `commentsByPath`
   * strings, so a single multi-line block comment (e.g. `/* a\nb *\/`)
   * counts as 1 while two stacked line comments (`// a` + `// b`) count
   * as 2 -- a distinction that cannot be recovered from the joined
   * post-harvest strings. Empty comments (`//\n` alone, `/**\/` alone)
   * are skipped, matching `harvestComments`. 0 for empty input and the
   * no-comment fast path.
   */
  commentCount: number;
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
      return {
        value: undefined,
        ast: undefined,
        errors: [],
        empty: true,
        commentsByPath: EMPTY_COMMENT_MAP,
        commentCount: 0,
      };
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
      disallowComments: false,
    });

    const errors = rawErrors.map((parseError) => this.toError(parseError, stripped));
    const value = ast ? this.nodeToValue(ast) : undefined;
    const { commentsByPath, commentCount } = this.harvestComments(stripped);

    const result: JsonParseResult = {
      value,
      ast,
      errors,
      empty: false,
      commentsByPath,
      commentCount,
    };
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

  private toError(parseError: ParseError, text: string): JsonParseError {
    const { line, column } = this.offsetToPosition(text, parseError.offset);
    return {
      message: printParseErrorCode(parseError.error),
      offset: parseError.offset,
      length: parseError.length,
      line,
      column,
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

  /**
   * Harvests JSONC comments from `text` and groups them by canonical
   * path (`$`, `$.foo`, `$.foo[0]`, etc.). Each path may carry up to
   * three slots:
   *
   * - `leading`: comment(s) before the next value (rules 3 and 5).
   * - `trailing`: comment(s) on the value's primary row -- the same
   *   line as a leaf's end token (rule 1), or the same line as a
   *   container's open brace with a whitespace-only tail (rule 3a,
   *   container open-row trailing).
   * - `closeLeading`: comment(s) on a container's close row, BEFORE
   *   the close token. Sourced from the pending-leading queue
   *   drained at the container close when no following value arrived
   *   (rule 4 -- comment-only containers and comments on their own
   *   line(s) between the last child and the close brace).
   * - `closeTrailing`: comment(s) on the same line as a container's
   *   close token, after that token (rule 2).
   *
   * Multiple comments stacked on the same slot are joined with `\n`.
   * The renderer shows only the first line in the row preview and
   * surfaces the rest via tooltip.
   *
   * Empty comments (a line comment with nothing after `//`, or a block
   * comment with nothing between the delimiters) are skipped.
   *
   * Fast-path: if `text` contains no `//` or `/*` substring, returns
   * an empty map without invoking `visit()`. False positives (those
   * substrings appearing inside string literals) still cost only one
   * extra visit pass with no comment callbacks.
   */
  private harvestComments(text: string): {
    commentsByPath: ReadonlyMap<string, CommentBundle>;
    commentCount: number;
  } {
    if (!/\/\/|\/\*/.test(text)) return { commentsByPath: EMPTY_COMMENT_MAP, commentCount: 0 };

    const map = new Map<string, CommentBundle>();
    const containerPathStack: string[] = [];
    const pendingLeading: string[] = [];
    let commentCount = 0;

    let lastValuePath: string | null = null;
    let lastValueEndOffset = -1;
    let lastValueEndLine = -1;

    let closeJustSeenPath: string | null = null;
    let closeJustSeenOffset = -1;
    let closeJustSeenLine = -1;

    // Most-recently-opened container, used by rule 3a (open-row
    // trailing). Naturally overwritten by nested opens; never needs
    // explicit clearing because the line check below bounds it to
    // the open-brace line only.
    let lastContainerOpenPath: string | null = null;
    let lastContainerOpenEndOffset = -1;
    let lastContainerOpenLine = -1;

    const flushPendingAsLeading = (path: string): void => {
      if (pendingLeading.length === 0) return;
      const merged = pendingLeading.join('\n');
      pendingLeading.length = 0;
      const existing = map.get(path);
      if (existing) {
        existing.leading = existing.leading ? existing.leading + '\n' + merged : merged;
      } else {
        map.set(path, { leading: merged });
      }
    };

    const appendTrailing = (path: string, body: string): void => {
      const existing = map.get(path);
      if (existing) {
        existing.trailing = existing.trailing ? existing.trailing + '\n' + body : body;
      } else {
        map.set(path, { trailing: body });
      }
    };

    const appendCloseLeading = (path: string, body: string): void => {
      const existing = map.get(path);
      if (existing) {
        existing.closeLeading = existing.closeLeading ? existing.closeLeading + '\n' + body : body;
      } else {
        map.set(path, { closeLeading: body });
      }
    };

    const appendCloseTrailing = (path: string, body: string): void => {
      const existing = map.get(path);
      if (existing) {
        existing.closeTrailing = existing.closeTrailing
          ? existing.closeTrailing + '\n' + body
          : body;
      } else {
        map.set(path, { closeTrailing: body });
      }
    };

    const onValueStart = (path: string): void => {
      flushPendingAsLeading(path);
      closeJustSeenPath = null;
    };

    const onValueComplete = (path: string, endOffset: number, endLine: number): void => {
      lastValuePath = path;
      lastValueEndOffset = endOffset;
      lastValueEndLine = endLine;
    };

    const onContainerEnd = (offset: number, length: number, startLine: number): void => {
      const path = containerPathStack.pop();
      if (path === undefined) return;
      // Rule 4: comments queued INSIDE this container with no following
      // value before the close attach to the close row's leading slot
      // (rendered before the close brace, in source order).
      if (pendingLeading.length > 0) {
        const merged = pendingLeading.join('\n');
        pendingLeading.length = 0;
        appendCloseLeading(path, merged);
      }
      const endOffset = offset + length;
      closeJustSeenPath = path;
      closeJustSeenOffset = endOffset;
      closeJustSeenLine = startLine;
      onValueComplete(path, endOffset, startLine);
    };

    // For rule 3a: a comment is open-row-trailing on a container only
    // if (a) it starts on the same line as the open brace, (b) it
    // begins after the open token, (c) the comment itself is
    // single-line (block comments may not contain `\n`), and (d) the
    // remainder of the source line after the comment is whitespace
    // only. Condition (d) disambiguates `"foo": { /* a */ "bar": 1 }`
    // (leading on bar) from `"foo": { // a\n  "bar": 1\n}` (open-row
    // trailing on foo).
    const isOpenRowTrailing = (offset: number, length: number, startLine: number): boolean => {
      if (lastContainerOpenPath === null) return false;
      if (startLine !== lastContainerOpenLine) return false;
      if (offset < lastContainerOpenEndOffset) return false;
      const body = text.slice(offset, offset + length);
      if (body.includes('\n')) return false;
      let i = offset + length;
      while (i < text.length && text.charCodeAt(i) !== 10 /* \n */) {
        const ch = text.charCodeAt(i);
        // ASCII whitespace: space, tab, \r, \v, \f.
        if (ch !== 32 && ch !== 9 && ch !== 13 && ch !== 11 && ch !== 12) {
          return false;
        }
        i++;
      }
      return true;
    };

    visit(
      text,
      {
        onObjectBegin: (offset, length, startLine, _sc, pathSupplier) => {
          const path = this.pathToString([...pathSupplier()]);
          containerPathStack.push(path);
          onValueStart(path);
          lastContainerOpenPath = path;
          lastContainerOpenEndOffset = offset + length;
          lastContainerOpenLine = startLine;
        },
        onObjectEnd: onContainerEnd,
        onArrayBegin: (offset, length, startLine, _sc, pathSupplier) => {
          const path = this.pathToString([...pathSupplier()]);
          containerPathStack.push(path);
          onValueStart(path);
          lastContainerOpenPath = path;
          lastContainerOpenEndOffset = offset + length;
          lastContainerOpenLine = startLine;
        },
        onArrayEnd: onContainerEnd,
        onLiteralValue: (_value, offset, length, startLine, _sc, pathSupplier) => {
          const path = this.pathToString([...pathSupplier()]);
          onValueStart(path);
          onValueComplete(path, offset + length, startLine);
        },
        onComment: (offset, length, startLine) => {
          const raw = text.slice(offset, offset + length);
          const body = extractCommentBody(raw);
          if (body.length === 0) return;
          commentCount++;

          // Rule 2: trailing on close brace -- comment is on the same
          // line as the most recently closed container's close token,
          // and starts after that token.
          if (
            closeJustSeenPath !== null &&
            startLine === closeJustSeenLine &&
            offset >= closeJustSeenOffset
          ) {
            appendCloseTrailing(closeJustSeenPath, body);
            return;
          }

          // Rule 1: trailing on value -- comment is on the same line
          // as the most recently completed value's end and starts at
          // or after that end.
          if (
            lastValuePath !== null &&
            startLine === lastValueEndLine &&
            offset >= lastValueEndOffset
          ) {
            appendTrailing(lastValuePath, body);
            return;
          }

          // Rule 3a: open-row trailing on container -- comment sits
          // on the same line as a container's open brace, after the
          // brace, with a whitespace-only line tail (so we don't
          // misclassify inline `{ /* x */ "k": v }` as open-row).
          if (isOpenRowTrailing(offset, length, startLine)) {
            appendTrailing(lastContainerOpenPath as string, body);
            return;
          }

          // Rules 3 / 5 / pre-rule-4: queue as leading for the next
          // value. If the enclosing container closes before any value
          // arrives, `onContainerEnd` drains this queue as the
          // container's close-row trailing (rule 4).
          pendingLeading.push(body);
        },
      },
      { disallowComments: false, allowTrailingComma: true },
    );

    return { commentsByPath: map, commentCount };
  }
}

const EMPTY_COMMENT_MAP: ReadonlyMap<string, CommentBundle> = new Map();

function extractCommentBody(raw: string): string {
  if (raw.startsWith('//')) {
    return raw.slice(2).trim();
  }
  if (raw.startsWith('/*')) {
    const inner = raw.endsWith('*/') ? raw.slice(2, -2) : raw.slice(2);
    return inner.trim();
  }
  return '';
}
