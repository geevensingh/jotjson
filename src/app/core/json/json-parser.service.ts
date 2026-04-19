import { Injectable } from '@angular/core';
import {
  parseTree,
  ParseError,
  printParseErrorCode,
  Node as JsoncNode,
  getLocation,
  getNodePath
} from 'jsonc-parser';

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
  parse(text: string): JsonParseResult {
    if (!text || text.trim().length === 0) {
      return { value: undefined, ast: undefined, errors: [], empty: true };
    }

    const rawErrors: ParseError[] = [];
    const ast = parseTree(text, rawErrors, {
      allowTrailingComma: true,
      disallowComments: false
    });

    const errors = rawErrors.map((e) => this.toError(e, text));
    const value = ast ? this.nodeToValue(ast) : undefined;

    return { value, ast, errors, empty: false };
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

  pathForNode(node: JsoncNode): (string | number)[] {
    return [...getNodePath(node)];
  }

  private toError(err: ParseError, text: string): JsonParseError {
    const { line, column } = this.offsetToPosition(text, err.offset);
    return {
      message: printParseErrorCode(err.error),
      offset: err.offset,
      length: err.length,
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
