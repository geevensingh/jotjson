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
 * A bundle of leading / trailing / close-trailing JSONC comments
 * attached to a single canonical path (e.g. `$.foo[0]`).
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
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rawErrors: ParseError[] = [];
  const ast = parseTree(stripped, rawErrors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  const errors = rawErrors.map((parseError) => toError(parseError, stripped));
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

function toError(parseError: ParseError, text: string): JsonParseError {
  const { line, column } = offsetToPosition(text, parseError.offset);
  return {
    message: printParseErrorCode(parseError.error),
    offset: parseError.offset,
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
      existing.closeTrailing = existing.closeTrailing ? existing.closeTrailing + '\n' + body : body;
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
          appendCloseTrailing(closeJustSeenPath, body);
          return;
        }

        if (
          lastValuePath !== null &&
          startLine === lastValueEndLine &&
          offset >= lastValueEndOffset
        ) {
          appendTrailing(lastValuePath, body);
          return;
        }

        if (isOpenRowTrailing(offset, length, startLine)) {
          appendTrailing(lastContainerOpenPath as string, body);
          return;
        }

        pendingLeading.push(body);
      },
    },
    { disallowComments: false, allowTrailingComma: true },
  );

  return { commentsByPath: map, commentCount };
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
