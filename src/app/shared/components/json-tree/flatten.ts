/**
 * DFS flattener for `JsonTreeComponent`'s virtualized render path
 * (issue #95 Phase 2). Walks the `TreeNode` graph in document
 * order, honoring an `expandedPaths` set, and emits one
 * `FlatItem` per row the viewport should draw.
 *
 * Each container produces an `'open'` row at the moment of entry
 * and a `'close'` row when the walk returns past its last child.
 * Empty containers (`children?.length === 0` or
 * `children === undefined`) produce **no** synthetic `'close'`
 * row -- they render as a single leaf-style row with the empty
 * literal in the value cell.
 *
 * Pure / DI-free so it can also run in the Node perf bench (see
 * `scripts/perf/build.mjs` rewriter notes in `build-tree.ts`).
 */

import type { TreeNode } from './build-tree';

export type FlatItemKind = 'leaf' | 'open' | 'close';

export interface FlatItem {
  /** `'leaf'` for primitives + empty containers; `'open'` / `'close'` bracket non-empty containers. */
  readonly kind: FlatItemKind;
  /** Source node. The same node appears twice for non-empty containers (once for `'open'`, once for `'close'`). */
  readonly node: TreeNode;
  /** Indent level from the root. `0` for root, `depth + 1` for direct children. */
  readonly level: number;
  /** `true` iff the node has children and could be expanded / collapsed. */
  readonly expandable: boolean;
}

function isExpandable(node: TreeNode): boolean {
  return !!node.children && node.children.length > 0;
}

/**
 * Append `FlatItem` rows for `node` and its visible descendants to `out`.
 *
 * `level` is the indent level for `node` itself (callers start at 0
 * for the root). `expanded` decides which non-empty containers
 * recurse; nodes whose `pathString` is not in the set render as a
 * single `'leaf'`-kind row showing the placeholder summary.
 */
export function flatten(
  node: TreeNode,
  level: number,
  expanded: ReadonlySet<string>,
  out: FlatItem[],
): void {
  if (!isExpandable(node)) {
    out.push({ kind: 'leaf', node, level, expandable: false });
    return;
  }
  const isOpen = expanded.has(node.pathString);
  out.push({ kind: 'open', node, level, expandable: true });
  if (isOpen) {
    for (const child of node.children!) {
      flatten(child, level + 1, expanded, out);
    }
    out.push({ kind: 'close', node, level, expandable: true });
  }
}

/**
 * Convenience: returns a fresh `FlatItem[]` for `root`. Returns an
 * empty array when `root` is `undefined` so callers can bind directly.
 */
export function flattenTree(root: TreeNode | undefined, expanded: ReadonlySet<string>): FlatItem[] {
  if (!root) return [];
  const out: FlatItem[] = [];
  flatten(root, 0, expanded, out);
  return out;
}

/**
 * Returns a `pathString -> visible-index` map skipping `'close'` rows
 * (the `'open'` row carries the canonical index for a container).
 * Used by `expandAndScroll` to scroll to a path's pixel offset.
 */
export function buildVisibleIndexMap(flat: readonly FlatItem[]): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < flat.length; i++) {
    const item = flat[i]!;
    if (item.kind === 'close') continue;
    if (!map.has(item.node.pathString)) {
      map.set(item.node.pathString, i);
    }
  }
  return map;
}
