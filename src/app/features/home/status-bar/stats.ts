import type { Node as JsoncNode } from 'jsonc-parser';

/**
 * Pure helpers for the Home page status bar (M7m). Kept free of Angular so
 * they can be unit-tested with `describe` without a TestBed.
 */

export interface TextStats {
  /** UTF-16 code units. Matches JavaScript's `String.length` and what every
   *  editor surfaces as "character count". */
  chars: number;
  /** 1 + number of `\n` occurrences when the text is non-empty; 0 otherwise. */
  lines: number;
  /** UTF-8 byte length. */
  bytes: number;
}

export interface TreeStats {
  /** Total node count across the tree, including primitive leaves. */
  nodes: number;
  /** Root = depth 0; a primitive value directly inside the root = depth 1. */
  depth: number;
  /** Count of `object` nodes anywhere in the tree. */
  objects: number;
  /** Count of `array` nodes anywhere in the tree. */
  arrays: number;
}

export function computeTextStats(text: string): TextStats {
  if (!text) {
    return { chars: 0, lines: 0, bytes: 0 };
  }
  let newlines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) newlines++;
  }
  return {
    chars: text.length,
    lines: newlines + 1,
    bytes: new TextEncoder().encode(text).length
  };
}

export function computeTreeStats(ast: JsoncNode | undefined): TreeStats | undefined {
  if (!ast) return undefined;
  let nodes = 0;
  let objects = 0;
  let arrays = 0;
  let maxDepth = 0;

  const walk = (node: JsoncNode, depth: number): void => {
    nodes++;
    if (depth > maxDepth) maxDepth = depth;
    if (node.type === 'object') {
      objects++;
      // Object children in jsonc-parser are `property` nodes; their first
      // child is the key, the second is the value. Recurse on the value.
      for (const prop of node.children ?? []) {
        const value = prop.children?.[1];
        if (value) walk(value, depth + 1);
      }
    } else if (node.type === 'array') {
      arrays++;
      for (const item of node.children ?? []) {
        walk(item, depth + 1);
      }
    }
  };

  walk(ast, 0);
  return { nodes, depth: maxDepth, objects, arrays };
}

/**
 * Formats a byte count using SI units (1000-based) with a single-decimal
 * fraction above 1 KB. Examples: 0 -> "0 B", 834 -> "834 B", 1536 -> "1.5 KB",
 * 2_500_000 -> "2.5 MB".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}
