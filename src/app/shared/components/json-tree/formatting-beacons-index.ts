/**
 * Beacon index: precomputed view of the formatting-rules engine result
 * specialised for the "beacon" surfacing UI (toolbar pills + ancestor
 * badges on collapsed rows). Decoupled from the engine so the tree
 * component can rebuild it cheaply on demand and so the helper has no
 * Angular dependency (pure data transform; trivial to unit-test).
 *
 * A "beacon" is a tree node whose engine-evaluated styles project at
 * least one icon. The trigger is implicit: any rule whose
 * `style.icon` is set opts in. No new schema; backwards-compatible.
 *
 * Two sparse maps are produced:
 *
 * 1. `matchesByIcon` -- icon -> ordered list of tree paths where that
 *    icon was projected. Order is pre-order (depth-first) tree walk
 *    so pill cycling visits matches top-to-bottom in the tree's
 *    natural reading order. Used by toolbar pills to advance the
 *    cursor for that bucket.
 *
 * 2. `descendantIconsByPath` -- pathString -> set of icons present
 *    anywhere in this node's subtree (including the node itself).
 *    Used by tree rows to decide whether to render an ancestor badge
 *    on a collapsed row, and which icon types the badge should
 *    display. Sparse: only paths whose subtree contains at least
 *    one beacon are present; consumers treat a missing key as "no
 *    beacons under this path".
 *
 * Identity-shared empty sentinel `EMPTY_BEACON_INDEX` so the tree
 * component's OnPush change detection short-circuits when nothing
 * matched (mirrors the `EMPTY_RULE_RESULT` sentinel pattern in
 * `formatting-rules-engine.ts`).
 */

import type { FormattingIcon } from '../../../core/api/models';
import type { TreeNode } from './json-tree.component';

export type PathArray = readonly (string | number)[];

export interface BeaconIndex {
  /**
   * Icon -> ordered list of path arrays where any rule with this icon
   * matched. Order is pre-order (depth-first) tree walk.
   */
  readonly matchesByIcon: ReadonlyMap<FormattingIcon, readonly PathArray[]>;

  /**
   * pathString -> set of icons present anywhere in this node's subtree
   * (including the node itself). Sparse: only populated for paths
   * whose subtree contains at least one beacon. Consumers treat a
   * missing key as an empty set.
   */
  readonly descendantIconsByPath: ReadonlyMap<string, ReadonlySet<FormattingIcon>>;
}

export const EMPTY_BEACON_INDEX: BeaconIndex = Object.freeze({
  matchesByIcon: new Map<FormattingIcon, readonly PathArray[]>(),
  descendantIconsByPath: new Map<string, ReadonlySet<FormattingIcon>>(),
});

/**
 * Build a `BeaconIndex` for a rendered tree.
 *
 * @param root         tree root node (the node the tree component
 *                     dispatches over). Walks `node.children`.
 * @param iconsForNode callback that returns the union of `keyIcons`
 *                     and `valueIcons` projected by the engine for a
 *                     given node. Empty array means no beacon on the
 *                     node itself.
 *
 * Returns `EMPTY_BEACON_INDEX` (identity-equal) when the entire tree
 * walk produced no matches, so the tree component's `computed`
 * signal can short-circuit downstream effects via `===` comparison
 * without allocating empty Maps per recompute.
 */
export function buildBeaconIndex(
  root: TreeNode,
  iconsForNode: (node: TreeNode) => readonly FormattingIcon[],
): BeaconIndex {
  const matchesByIcon = new Map<FormattingIcon, PathArray[]>();
  const descendantIconsByPath = new Map<string, Set<FormattingIcon>>();

  const visit = (node: TreeNode): ReadonlySet<FormattingIcon> => {
    const directIcons = iconsForNode(node);
    const subtreeIcons = new Set<FormattingIcon>();

    // Dedupe per-node: a pair rule projects the same icon onto both
    // `keyStyle.icons` and `valueStyle.icons`, so callers that union
    // both sides may pass us `[warning, warning]` for one node. Each
    // (node, icon) pair must appear in `matchesByIcon` at most once
    // - otherwise the toolbar pill count over-reports. JS Set
    // preserves insertion order, so pre-order semantics are kept.
    for (const icon of new Set(directIcons)) {
      subtreeIcons.add(icon);
      let bucket = matchesByIcon.get(icon);
      if (bucket === undefined) {
        bucket = [];
        matchesByIcon.set(icon, bucket);
      }
      bucket.push(node.path);
    }

    if (node.children !== undefined) {
      for (const child of node.children) {
        const childSubtree = visit(child);
        for (const icon of childSubtree) {
          subtreeIcons.add(icon);
        }
      }
    }

    if (subtreeIcons.size > 0) {
      descendantIconsByPath.set(node.pathString, subtreeIcons);
    }

    return subtreeIcons;
  };

  visit(root);

  if (matchesByIcon.size === 0) {
    return EMPTY_BEACON_INDEX;
  }

  return {
    matchesByIcon,
    descendantIconsByPath,
  };
}
