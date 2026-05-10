import { computeAutoFitDepth } from './auto-fit-depth';
import type { TreeNode } from './json-tree.component';

/**
 * Creates a minimal TreeNode stub for use in tests. Only `depth` and
 * `children` affect `computeAutoFitDepth`; other required fields are
 * filled with inert placeholder values.
 */
function makeNode(depth: number, children?: TreeNode[]): TreeNode {
  return {
    segment: 'x',
    path: [],
    pathString: '',
    value: null,
    type: 'null',
    depth,
    children,
  };
}

describe('computeAutoFitDepth', () => {
  it('returns zeros for an empty tree (root = undefined)', () => {
    const result = computeAutoFitDepth(undefined, 40);
    expect(result).toEqual({ chosenDepth: 0, chosenRows: 0, totalNodes: 0 });
  });

  it('returns zeros for an empty tree (root = null)', () => {
    const result = computeAutoFitDepth(null, 40);
    expect(result).toEqual({ chosenDepth: 0, chosenRows: 0, totalNodes: 0 });
  });

  it('single primitive leaf: returns chosenDepth 0, chosenRows 1, totalNodes 1', () => {
    const root = makeNode(0);
    const result = computeAutoFitDepth(root, 40);
    expect(result).toEqual({ chosenDepth: 0, chosenRows: 1, totalNodes: 1 });
  });

  it('wide flat object with 26 children, capacity 40: picks depth 1', () => {
    // nodesAt = [1, 26]; sum[0..0] = 1, sum[0..1] = 27; limit = 60; 27 <= 60 -> K = 1
    const children = Array.from({ length: 26 }, (_, index) => makeNode(1));
    const root = makeNode(0, children);
    const result = computeAutoFitDepth(root, 40);
    expect(result).toEqual({ chosenDepth: 1, chosenRows: 27, totalNodes: 27 });
  });

  it('wide explosion (100 children each with 26 grandchildren), capacity 10: picks depth 0', () => {
    // nodesAt = [1, 100, 2600]; limit = 15; sum[0..0] = 1 (ok), sum[0..1] = 101 (over) -> K = 0
    const grandchildren = Array.from({ length: 26 }, (_, index) => makeNode(2));
    const children = Array.from({ length: 100 }, (_, index) => makeNode(1, grandchildren));
    const root = makeNode(0, children);
    const result = computeAutoFitDepth(root, 10);
    expect(result.chosenDepth).toBe(0);
    expect(result.chosenRows).toBe(1);
    expect(result.totalNodes).toBe(2701);
  });

  it('deep narrow chain (6 levels), capacity 10: picks maximum depth 5', () => {
    // {a:{b:{c:{d:{e:1}}}}} - 6 nodes total, nodesAt = [1,1,1,1,1,1]
    // All sums fit within tolerance * 10 = 15 -> K = 5
    const depth5 = makeNode(5);
    const depth4 = makeNode(4, [depth5]);
    const depth3 = makeNode(3, [depth4]);
    const depth2 = makeNode(2, [depth3]);
    const depth1 = makeNode(1, [depth2]);
    const root = makeNode(0, [depth1]);
    const result = computeAutoFitDepth(root, 10);
    expect(result).toEqual({ chosenDepth: 5, chosenRows: 6, totalNodes: 6 });
  });

  it('mixed tree (users 10 leaves, groups 5 leaves, roles leaf), capacity 10: picks depth 1', () => {
    // root has 3 children: users-container (10 leaves), groups-container (5 leaves), roles-leaf
    // nodesAt = [1, 3, 15]; limit = 15
    // sum[0..0] = 1 (ok), sum[0..1] = 4 (ok), sum[0..2] = 19 (over) -> K = 1
    const userLeaves = Array.from({ length: 10 }, (_, index) => makeNode(2));
    const groupLeaves = Array.from({ length: 5 }, (_, index) => makeNode(2));
    const usersNode = makeNode(1, userLeaves);
    const groupsNode = makeNode(1, groupLeaves);
    const rolesNode = makeNode(1);
    const root = makeNode(0, [usersNode, groupsNode, rolesNode]);
    const result = computeAutoFitDepth(root, 10);
    expect(result.chosenDepth).toBe(1);
    expect(result.chosenRows).toBe(4);
    expect(result.totalNodes).toBe(19);
  });

  it('1.5x tolerance accepts a level that overflows 1x but not 1.5x (sum = 55, capacity 40)', () => {
    // depth 0: 1 node, depth 1: 1 node, depth 2: 28 nodes, depth 3: 25 nodes
    // sum[0..2] = 30, sum[0..3] = 55; limit = 60; 55 <= 60 -> picks depth 3
    const depth3Nodes = Array.from({ length: 25 }, (_, index) => makeNode(3));
    const depth2Nodes = [
      ...Array.from({ length: 25 }, (_, index) => makeNode(2, [depth3Nodes[index]])),
      ...Array.from({ length: 3 }, (_, index) => makeNode(2)),
    ];
    const depth1Node = makeNode(1, depth2Nodes);
    const root = makeNode(0, [depth1Node]);
    const result = computeAutoFitDepth(root, 40);
    expect(result.chosenDepth).toBe(3);
    expect(result.chosenRows).toBe(55);
  });

  it('1.5x tolerance does NOT accept a level that exceeds 1.5x (sum = 71, capacity 40)', () => {
    // depth 0: 1, depth 1: 1, depth 2: 28, depth 3: 41
    // sum[0..2] = 30, sum[0..3] = 71; limit = 60; 71 > 60 -> picks depth 2
    // Distribute 41 depth-3 nodes across 28 depth-2 parents:
    //   first 13 parents get 2 children each (26), remaining 15 get 1 each (15); total = 41.
    const depth2Nodes = Array.from({ length: 28 }, (_, index) => {
      const grandchildCount = index < 13 ? 2 : 1;
      const grandchildren = Array.from({ length: grandchildCount }, () => makeNode(3));
      return makeNode(2, grandchildren);
    });
    const depth1Node = makeNode(1, depth2Nodes);
    const root = makeNode(0, [depth1Node]);
    const result = computeAutoFitDepth(root, 40);
    expect(result.chosenDepth).toBe(2);
    expect(result.chosenRows).toBe(30);
  });

  it('capacity = 0: returns chosenDepth 0, chosenRows 1 for a non-empty tree (no crash)', () => {
    const children = Array.from({ length: 10 }, (_, index) => makeNode(1));
    const root = makeNode(0, children);
    const result = computeAutoFitDepth(root, 0);
    expect(result.chosenDepth).toBe(0);
    expect(result.chosenRows).toBe(1);
    expect(result.totalNodes).toBe(11);
  });

  it('tolerance = 0: treated as 1.0, strict fit behavior', () => {
    // nodesAt = [1, 10]; limit = 1.0 * 10 = 10; sum[0..0] = 1 (ok), sum[0..1] = 11 (over) -> K = 0
    const children = Array.from({ length: 10 }, (_, index) => makeNode(1));
    const root = makeNode(0, children);
    const result = computeAutoFitDepth(root, 10, 0);
    expect(result.chosenDepth).toBe(0);
    expect(result.chosenRows).toBe(1);
    expect(result.totalNodes).toBe(11);
  });
});
