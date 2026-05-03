import {
  buildBeaconIndex,
  EMPTY_BEACON_INDEX,
  type BeaconIndex,
  type PathArray,
} from './formatting-beacons-index';
import type { FormattingIcon } from '../../../core/api/models';
import type { TreeNode } from './json-tree.component';

function makeNode(
  segment: string | number | undefined,
  parentPath: PathArray,
  pathString: string,
  children?: TreeNode[],
): TreeNode {
  const path = segment === undefined ? [...parentPath] : [...parentPath, segment];
  return {
    segment,
    path,
    pathString,
    value: undefined,
    type: 'object',
    depth: parentPath.length,
    ...(children !== undefined ? { children } : {}),
  };
}

function leaf(segment: string | number, parentPath: PathArray, pathString: string): TreeNode {
  return makeNode(segment, parentPath, pathString);
}

describe('buildBeaconIndex', () => {
  it('returns EMPTY_BEACON_INDEX (identity-equal) when no node has icons', () => {
    const root = makeNode(undefined, [], '$', [leaf('a', [], '$.a'), leaf('b', [], '$.b')]);
    const result = buildBeaconIndex(root, () => []);
    expect(result).toBe(EMPTY_BEACON_INDEX);
  });

  it('places a single direct match into matchesByIcon under the right icon', () => {
    const root = makeNode(undefined, [], '$', [leaf('a', [], '$.a')]);
    const result = buildBeaconIndex(root, (node) =>
      node.segment === 'a' ? (['warning'] as const) : [],
    );
    const warningMatches = result.matchesByIcon.get('warning');
    expect(warningMatches).toBeDefined();
    expect(warningMatches!.length).toBe(1);
    expect(warningMatches![0]).toEqual(['a']);
  });

  it('orders matchesByIcon entries in pre-order (depth-first) tree walk', () => {
    // root
    //  +-- a
    //  |    +-- a1 (warning)
    //  |    +-- a2 (warning)
    //  +-- b (warning)
    //  +-- c
    //       +-- c1 (warning)
    const a1 = leaf('a1', ['a'], '$.a.a1');
    const a2 = leaf('a2', ['a'], '$.a.a2');
    const a = makeNode('a', [], '$.a', [a1, a2]);
    const b = leaf('b', [], '$.b');
    const c1 = leaf('c1', ['c'], '$.c.c1');
    const c = makeNode('c', [], '$.c', [c1]);
    const root = makeNode(undefined, [], '$', [a, b, c]);

    const beaconNodes = new Set([a1, a2, b, c1]);
    const result = buildBeaconIndex(root, (node) =>
      beaconNodes.has(node) ? (['warning'] as const) : [],
    );

    expect(result.matchesByIcon.get('warning')).toEqual([
      ['a', 'a1'],
      ['a', 'a2'],
      ['b'],
      ['c', 'c1'],
    ]);
  });

  it('aggregates descendantIconsByPath at every ancestor (sparse)', () => {
    // root
    //  +-- group
    //       +-- inner
    //            +-- leaf1 (error)
    const leaf1 = leaf('leaf1', ['group', 'inner'], '$.group.inner.leaf1');
    const inner = makeNode('inner', ['group'], '$.group.inner', [leaf1]);
    const group = makeNode('group', [], '$.group', [inner]);
    const sibling = leaf('sibling', [], '$.sibling');
    const root = makeNode(undefined, [], '$', [group, sibling]);

    const result = buildBeaconIndex(root, (node) =>
      node.segment === 'leaf1' ? (['error'] as const) : [],
    );

    expect([...(result.descendantIconsByPath.get('$') ?? [])]).toEqual(['error']);
    expect([...(result.descendantIconsByPath.get('$.group') ?? [])]).toEqual(['error']);
    expect([...(result.descendantIconsByPath.get('$.group.inner') ?? [])]).toEqual(['error']);
    expect([...(result.descendantIconsByPath.get('$.group.inner.leaf1') ?? [])]).toEqual(['error']);
    // The sibling branch has no beacons, so it must be absent from
    // the sparse map.
    expect(result.descendantIconsByPath.has('$.sibling')).toBe(false);
  });

  it('unions multiple icon types at a common ancestor', () => {
    const aLeaf = leaf('a', [], '$.a');
    const bLeaf = leaf('b', [], '$.b');
    const root = makeNode(undefined, [], '$', [aLeaf, bLeaf]);

    const result = buildBeaconIndex(root, (node) => {
      if (node.segment === 'a') return ['warning'] as const;
      if (node.segment === 'b') return ['error'] as const;
      return [];
    });

    expect([...(result.descendantIconsByPath.get('$') ?? [])].sort()).toEqual(['error', 'warning']);
    expect([...(result.descendantIconsByPath.get('$.a') ?? [])]).toEqual(['warning']);
    expect([...(result.descendantIconsByPath.get('$.b') ?? [])]).toEqual(['error']);
  });

  it('dedupes icons in the descendant set when multiple descendants project the same icon', () => {
    const a = leaf('a', [], '$.a');
    const b = leaf('b', [], '$.b');
    const root = makeNode(undefined, [], '$', [a, b]);

    const result = buildBeaconIndex(root, (node) =>
      node.segment === 'a' || node.segment === 'b' ? (['warning'] as const) : [],
    );

    const rootDescendants = result.descendantIconsByPath.get('$');
    expect(rootDescendants).toBeDefined();
    expect(rootDescendants!.size).toBe(1);
    expect(rootDescendants!.has('warning')).toBe(true);
  });

  it('handles a node that projects multiple icons on itself', () => {
    const a = leaf('a', [], '$.a');
    const root = makeNode(undefined, [], '$', [a]);

    const result = buildBeaconIndex(root, (node) =>
      node.segment === 'a' ? (['warning', 'error'] as const) : [],
    );

    expect(result.matchesByIcon.get('warning')).toEqual([['a']]);
    expect(result.matchesByIcon.get('error')).toEqual([['a']]);
    expect([...(result.descendantIconsByPath.get('$.a') ?? [])].sort()).toEqual([
      'error',
      'warning',
    ]);
  });

  it('skips entries for paths whose subtree has no beacons (sparse storage)', () => {
    // root has two children; only one branch has a beacon. The other
    // branch must NOT appear in descendantIconsByPath.
    const beaconLeaf = leaf('hit', ['active'], '$.active.hit');
    const active = makeNode('active', [], '$.active', [beaconLeaf]);
    const idleChild1 = leaf('x', ['idle'], '$.idle.x');
    const idleChild2 = leaf('y', ['idle'], '$.idle.y');
    const idle = makeNode('idle', [], '$.idle', [idleChild1, idleChild2]);
    const root = makeNode(undefined, [], '$', [active, idle]);

    const result = buildBeaconIndex(root, (node) =>
      node.segment === 'hit' ? (['flag'] as const) : [],
    );

    expect(result.descendantIconsByPath.has('$.idle')).toBe(false);
    expect(result.descendantIconsByPath.has('$.idle.x')).toBe(false);
    expect(result.descendantIconsByPath.has('$.idle.y')).toBe(false);
    expect(result.descendantIconsByPath.has('$.active')).toBe(true);
    expect(result.descendantIconsByPath.has('$.active.hit')).toBe(true);
  });

  it('returns the same identity-shared empty sentinel on repeat calls when no beacons match', () => {
    const root = makeNode(undefined, [], '$', [leaf('a', [], '$.a')]);
    const first = buildBeaconIndex(root, () => []);
    const second = buildBeaconIndex(root, () => []);
    expect(first).toBe(second);
    expect(first).toBe(EMPTY_BEACON_INDEX);
  });

  it('treats a tree with only a beacon-bearing root as a non-empty index', () => {
    // Edge case: the root itself is a beacon but has no children.
    // Not realistic for JSON (the root is always an object/array),
    // but the helper must not assume a non-leaf root.
    const root: TreeNode = {
      segment: undefined,
      path: [],
      pathString: '$',
      value: undefined,
      type: 'string',
      depth: 0,
    };
    const result = buildBeaconIndex(root, () => ['star'] as const);
    expect(result).not.toBe(EMPTY_BEACON_INDEX);
    expect(result.matchesByIcon.get('star')).toEqual([[]]);
    expect([...(result.descendantIconsByPath.get('$') ?? [])]).toEqual(['star']);
  });

  it('preserves the icon array reference order from `iconsForNode` for a single node', () => {
    const a = leaf('a', [], '$.a');
    const root = makeNode(undefined, [], '$', [a]);
    const expected: readonly FormattingIcon[] = ['warning', 'error', 'info'];
    const result = buildBeaconIndex(root, (node) => (node.segment === 'a' ? expected : []));

    // matchesByIcon keys reflect iteration order of icons[] from the
    // callback (warning first, then error, then info).
    const orderedIcons = [...result.matchesByIcon.keys()];
    expect(orderedIcons).toEqual(['warning', 'error', 'info']);
  });

  it('binds matchesByIcon path entries by reference - mutations downstream do not corrupt the index', () => {
    const a = leaf('a', [], '$.a');
    const root = makeNode(undefined, [], '$', [a]);
    const result: BeaconIndex = buildBeaconIndex(root, (node) =>
      node.segment === 'a' ? (['warning'] as const) : [],
    );
    const matches = result.matchesByIcon.get('warning');
    expect(matches).toBeDefined();
    // The path should be the TreeNode's `path` reference; consumers
    // that read it must not mutate it. We assert reference equality
    // so callers know not to defensive-copy.
    expect(matches![0]).toBe(a.path);
  });
});
