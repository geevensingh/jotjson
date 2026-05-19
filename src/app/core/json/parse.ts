import {
  getLocation,
  Node as JsoncNode,
  ParseError,
  parseTree,
  printParseErrorCode,
  visit,
} from 'jsonc-parser';
import { pathToString } from './json-path';
export { pathToString };

export interface JsonParseError {
  message: string;
  offset: number;
  length: number;
  line: number;
  column: number;
}

/**
 * Per-path bundle of JSONC comment bodies attached to a value.
 *
 * Each slot is a non-empty array iff present; absent slot means
 * no bodies in that role. The parser never produces an empty
 * array (`extractCommentBody` strips delimiters and trims; the
 * `onComment` caller drops empty bodies via
 * `if (body.length === 0) return;` before they reach the
 * bundle). The renderer's matTooltip joins bodies with `\n` for
 * display.
 *
 * The slot shape distinguishes stacked line comments (`['a', 'b']`)
 * from a single multi-line block comment (`['a\nb']`)
 * structurally - count is `bodies.length`. This is the load-bearing
 * invariant the renderer's `(+N-1)` count badge depends on.
 *
 * See DESIGN_SPEC.md M7k Decision B for the full attachment ruleset.
 */
export interface CommentBundle {
  leading?: readonly string[];
  trailing?: readonly string[];
  closeLeading?: readonly string[];
  closeTrailing?: readonly string[];
}

/**
 * Parser-internal mutable mirror of `CommentBundle`. Maps each
 * slot from `readonly string[]` to `string[]` via the
 * `-readonly` mapped type modifier so the parser can `push`
 * bodies in-place. The harvest function casts once at the
 * export boundary to `ReadonlyMap<string, CommentBundle>` -
 * the same pattern as `commentsByPath`'s readonly outer Map
 * over a mutable backing store. A schema change to
 * `CommentBundle` propagates automatically.
 */
type MutableCommentBundle = {
  -readonly [K in keyof CommentBundle]: string[];
};

type CommentSlot = keyof CommentBundle;

export interface JsonParseResult {
  value: unknown;
  ast: JsoncNode | undefined;
  errors: JsonParseError[];
  empty: boolean;
  commentsByPath: ReadonlyMap<string, CommentBundle>;
  /**
   * Total number of individual comments seen during the harvest pass.
   * See JsonParserService for the full semantics; documented there.
   */
  commentCount: number;
}

const EMPTY_COMMENT_MAP: ReadonlyMap<string, CommentBundle> = new Map();

/**
 * Pure JSON/JSONC parser, extracted from `JsonParserService.parse` so it
 * can run in a Node bench harness with no Angular DI context.
 *
 * The function's only repo-internal import is to `./json-path` (the
 * shared `pathToString` helper). `tsc -p tsconfig.perf.json` emits a
 * `.js` for this module, and `scripts/perf/build.mjs` rewrites the
 * extensionless specifier to `.js` so Node ESM can resolve it.
 *
 * `JsonParserService.parse` is now a thin wrapper that calls this function
 * and emits `parse.slow` telemetry around it.
 */
export function parse(text: string): JsonParseResult {
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

  // Strip a leading UTF-8/UTF-16 BOM (U+FEFF). Many Windows editors and
  // older file-exporting tools prefix JSON with a BOM, which jsonc-parser
  // reports as an InvalidSymbol error at offset 0. A BOM is a file-level
  // encoding artifact, not part of the JSON grammar, so we silently elide.
  //
  // `bomShift` carries the original-vs-stripped offset delta. Any parse
  // errors we report must be in ORIGINAL-text coordinates so Monaco
  // markers and other consumers line up with the editor buffer.
  const hadBom = text.charCodeAt(0) === 0xfeff;
  const stripped = hadBom ? text.slice(1) : text;
  const bomShift = hadBom ? 1 : 0;

  const rawErrors: ParseError[] = [];
  const ast = parseTree(stripped, rawErrors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  const errors = rawErrors.map((parseError) => toError(parseError, text, bomShift));
  const value = ast ? nodeToValue(ast) : undefined;
  const { commentsByPath, commentCount } = harvestComments(stripped);

  return {
    value,
    ast,
    errors,
    empty: false,
    commentsByPath,
    commentCount,
  };
}

export function offsetToPosition(text: string, offset: number): { line: number; column: number } {
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

export function locationAt(text: string, offset: number): (string | number)[] {
  const loc = getLocation(text, offset);
  return [...loc.path];
}

function toError(parseError: ParseError, originalText: string, bomShift: number): JsonParseError {
  const offset = parseError.offset + bomShift;
  const { line, column } = offsetToPosition(originalText, offset);
  return {
    message: printParseErrorCode(parseError.error),
    offset,
    length: parseError.length,
    line,
    column,
  };
}

function nodeToValue(node: JsoncNode): unknown {
  switch (node.type) {
    case 'null':
      return null;
    case 'boolean':
    case 'number':
    case 'string':
      return node.value;
    case 'array':
      return (node.children ?? []).map((c) => nodeToValue(c));
    case 'object': {
      const obj: Record<string, unknown> = {};
      for (const prop of node.children ?? []) {
        const [keyNode, valueNode] = prop.children ?? [];
        if (keyNode && valueNode) {
          obj[String(keyNode.value)] = nodeToValue(valueNode);
        }
      }
      return obj;
    }
    default:
      return undefined;
  }
}

/**
 * Harvests JSONC comments from `text` and groups them by canonical path.
 *
 * See JsonParserService.harvestComments (pre-extraction) for the full
 * ruleset and slot semantics. This is a verbatim move of that method
 * into a free function; the `this.pathToString` callsites become direct
 * calls to the module-local `pathToString`.
 */
function harvestComments(text: string): {
  commentsByPath: ReadonlyMap<string, CommentBundle>;
  commentCount: number;
} {
  if (!/\/\/|\/\*/.test(text)) return { commentsByPath: EMPTY_COMMENT_MAP, commentCount: 0 };

  const map = new Map<string, MutableCommentBundle>();
  const containerPathStack: string[] = [];
  const pendingLeading: string[] = [];
  let commentCount = 0;

  let lastValuePath: string | null = null;
  let lastValueEndOffset = -1;
  let lastValueEndLine = -1;

  let closeJustSeenPath: string | null = null;
  let closeJustSeenOffset = -1;
  let closeJustSeenLine = -1;

  let lastContainerOpenPath: string | null = null;
  let lastContainerOpenEndOffset = -1;
  let lastContainerOpenLine = -1;

  const appendBody = (path: string, slot: CommentSlot, body: string): void => {
    const existing = map.get(path);
    if (existing) {
      const arr = existing[slot];
      if (arr) {
        arr.push(body);
      } else {
        existing[slot] = [body];
      }
    } else {
      const newBundle: MutableCommentBundle = {};
      newBundle[slot] = [body];
      map.set(path, newBundle);
    }
  };

  const flushPending = (path: string, slot: 'leading' | 'closeLeading'): void => {
    if (pendingLeading.length === 0) return;
    for (const body of pendingLeading) appendBody(path, slot, body);
    pendingLeading.length = 0;
  };

  const onValueStart = (path: string): void => {
    flushPending(path, 'leading');
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
    flushPending(path, 'closeLeading');
    const endOffset = offset + length;
    closeJustSeenPath = path;
    closeJustSeenOffset = endOffset;
    closeJustSeenLine = startLine;
    onValueComplete(path, endOffset, startLine);
  };

  const isOpenRowTrailing = (offset: number, length: number, startLine: number): boolean => {
    if (lastContainerOpenPath === null) return false;
    if (startLine !== lastContainerOpenLine) return false;
    if (offset < lastContainerOpenEndOffset) return false;
    const body = text.slice(offset, offset + length);
    if (body.includes('\n')) return false;
    let i = offset + length;
    while (i < text.length && text.charCodeAt(i) !== 10 /* \n */) {
      const ch = text.charCodeAt(i);
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
        const path = pathToString([...pathSupplier()]);
        containerPathStack.push(path);
        onValueStart(path);
        lastContainerOpenPath = path;
        lastContainerOpenEndOffset = offset + length;
        lastContainerOpenLine = startLine;
      },
      onObjectEnd: onContainerEnd,
      onArrayBegin: (offset, length, startLine, _sc, pathSupplier) => {
        const path = pathToString([...pathSupplier()]);
        containerPathStack.push(path);
        onValueStart(path);
        lastContainerOpenPath = path;
        lastContainerOpenEndOffset = offset + length;
        lastContainerOpenLine = startLine;
      },
      onArrayEnd: onContainerEnd,
      onLiteralValue: (_value, offset, length, startLine, _sc, pathSupplier) => {
        const path = pathToString([...pathSupplier()]);
        onValueStart(path);
        onValueComplete(path, offset + length, startLine);
      },
      onComment: (offset, length, startLine) => {
        const raw = text.slice(offset, offset + length);
        const body = extractCommentBody(raw);
        if (body.length === 0) return;
        commentCount++;

        if (
          closeJustSeenPath !== null &&
          startLine === closeJustSeenLine &&
          offset >= closeJustSeenOffset
        ) {
          appendBody(closeJustSeenPath, 'closeTrailing', body);
          return;
        }

        if (
          lastValuePath !== null &&
          startLine === lastValueEndLine &&
          offset >= lastValueEndOffset
        ) {
          appendBody(lastValuePath, 'trailing', body);
          return;
        }

        if (isOpenRowTrailing(offset, length, startLine)) {
          appendBody(lastContainerOpenPath as string, 'trailing', body);
          return;
        }

        pendingLeading.push(body);
      },
    },
    { disallowComments: false, allowTrailingComma: true },
  );

  return { commentsByPath: map as ReadonlyMap<string, CommentBundle>, commentCount };
}

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
