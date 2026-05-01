import type { TreeNode } from './json-tree.component';

export interface AutoFitResult {
  /** Chosen depth K (root = 0). Always >= 0. */
  chosenDepth: number;
  /** Total rows that will be visible after expandToLevel(K) - i.e., sum(nodesAt[0..K]). */
  chosenRows: number;
  /** Total nodes in the tree (all depths). */
  totalNodes: number;
}

/**
 * Picks the largest K >= 0 such that the cumulative number of nodes from
 * depth 0 through K, inclusive, is <= tolerance * capacity. If even
 * sum(nodesAt[0..1]) overflows the tolerance, returns K = 0 (root only).
 *
 * Algorithm:
 *   1. Walk the tree once via BFS, building nodesAt[d] = total nodes at
 *      depth d. Root contributes 1 to nodesAt[0]. A child of a depth-d
 *      container contributes 1 to nodesAt[d+1].
 *   2. Build prefix sums sumThrough[K] = sum(nodesAt[0..K]).
 *   3. Pick the largest K such that sumThrough[K] <= tolerance * capacity.
 *      If even K = 0 overflows (tolerance * capacity < 1), still return 0
 *      (cannot show fewer than the root row anyway).
 *
 * Edge cases:
 *   - root === undefined or null -> { chosenDepth: 0, chosenRows: 0, totalNodes: 0 }.
 *   - Single primitive (no children) -> { chosenDepth: 0, chosenRows: 1, totalNodes: 1 }.
 *   - capacity <= 0 -> { chosenDepth: 0, chosenRows: 1, totalNodes: 1 }
 *     (caller should typically skip auto-fit if capacity is 0).
 *   - tolerance <= 0 -> treat as 1.0.
 *
 * @param root - The tree root node, or undefined/null for an empty tree.
 * @param capacity - Number of rows that fit in the viewport (typically
 *   floor(viewportPx / probeRowPx)).
 * @param tolerance - Overflow factor; 1.5 means we accept up to 1.5x
 *   capacity to avoid underfilling on half-empty levels. Defaults to 1.5.
 */
export function computeAutoFitDepth(
  root: TreeNode | undefined | null,
  capacity: number,
  tolerance = 1.5
): AutoFitResult {
  if (root == null) {
    return { chosenDepth: 0, chosenRows: 0, totalNodes: 0 };
  }

  const effectiveTolerance = tolerance <= 0 ? 1.0 : tolerance;
  const limit = effectiveTolerance * (capacity <= 0 ? 0 : capacity);

  // BFS to count nodes per depth level.
  const nodesAt: number[] = [];
  const pending: TreeNode[] = [root];

  while (pending.length > 0) {
    const node = pending.shift()!;
    const depth = node.depth;

    while (nodesAt.length <= depth) {
      nodesAt.push(0);
    }
    nodesAt[depth]++;

    if (node.children !== undefined) {
      for (const child of node.children) {
        pending.push(child);
      }
    }
  }

  const totalNodes = nodesAt.reduce((sum, count) => sum + count, 0);

  if (capacity <= 0) {
    return { chosenDepth: 0, chosenRows: nodesAt[0] ?? 1, totalNodes };
  }

  // Scan prefix sums to find the largest K within tolerance.
  let chosenDepth = 0;
  let chosenRows = nodesAt[0] ?? 0;
  let runningSum = 0;

  for (let depthIndex = 0; depthIndex < nodesAt.length; depthIndex++) {
    runningSum += nodesAt[depthIndex] ?? 0;

    if (runningSum <= limit) {
      chosenDepth = depthIndex;
      chosenRows = runningSum;
    } else {
      if (depthIndex === 0) {
        // Even the root alone exceeds tolerance*capacity; still return depth 0.
        chosenDepth = 0;
        chosenRows = runningSum;
      }
      break;
    }
  }

  return { chosenDepth, chosenRows, totalNodes };
}
