import { buildTree, type TreeNode } from './build-tree';
import { buildVisibleIndexMap, flatten, flattenTree, type FlatItem } from './flatten';

function expandedFor(root: TreeNode, predicate: (n: TreeNode) => boolean): ReadonlySet<string> {
  const set = new Set<string>();
  const walk = (node: TreeNode): void => {
    if (predicate(node)) set.add(node.pathString);
    if (node.children) for (const child of node.children) walk(child);
  };
  walk(root);
  return set;
}

function flatPaths(items: readonly FlatItem[]): string[] {
  return items.map((i) => `${i.kind}:${i.node.pathString}@${i.level}`);
}

describe('flatten', () => {
  it('returns a single leaf for a primitive root', () => {
    const { root } = buildTree(42);
    const items = flattenTree(root, new Set());
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(
      expect.objectContaining({ kind: 'leaf', level: 0, expandable: false }),
    );
    expect(items[0]!.node.pathString).toBe('$');
  });

  it('returns a single leaf-style row for an empty object root', () => {
    const { root } = buildTree({});
    const items = flattenTree(root, new Set());
    // Per locked decision: empty containers emit a single 'leaf' row
    // (no 'open'/'close' brackets, since there are no children to
    // delimit).
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('leaf');
    expect(items[0]!.expandable).toBe(false);
  });

  it('returns a single leaf-style row for an empty array root', () => {
    const { root } = buildTree([]);
    const items = flattenTree(root, new Set());
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('leaf');
  });

  it('renders an unexpanded non-empty object as an open row only (children hidden)', () => {
    const { root } = buildTree({ a: 1, b: 2 });
    const items = flattenTree(root, new Set());
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(expect.objectContaining({ kind: 'open', level: 0, expandable: true }));
  });

  it('renders an expanded non-empty object as open, children..., close', () => {
    const { root } = buildTree({ a: 1, b: 2 });
    const items = flattenTree(
      root,
      expandedFor(root, (n) => n.pathString === '$'),
    );
    expect(flatPaths(items)).toEqual(['open:$@0', 'leaf:$.a@1', 'leaf:$.b@1', 'close:$@0']);
  });

  it('honors expandedPaths at nested levels', () => {
    const { root } = buildTree({ a: { b: { c: 1 } } });
    const expanded = expandedFor(root, (n) => n.pathString === '$' || n.pathString === '$.a');
    const items = flattenTree(root, expanded);
    expect(flatPaths(items)).toEqual([
      'open:$@0',
      'open:$.a@1',
      'open:$.a.b@2', // $.a.b is collapsed, so only open emitted, no close, no children
      'close:$.a@1',
      'close:$@0',
    ]);
  });

  it('emits correct level for deep trees', () => {
    const { root } = buildTree({ a: { b: { c: { d: 1 } } } });
    const expanded = expandedFor(root, () => true);
    const items = flattenTree(root, expanded);
    const levels = items.map((i) => `${i.kind}:${i.level}`);
    expect(levels).toEqual([
      'open:0',
      'open:1',
      'open:2',
      'open:3',
      'leaf:4',
      'close:3',
      'close:2',
      'close:1',
      'close:0',
    ]);
  });

  it('handles arrays the same way as objects', () => {
    const { root } = buildTree([1, 2, 3]);
    const items = flattenTree(
      root,
      expandedFor(root, () => true),
    );
    expect(flatPaths(items)).toEqual([
      'open:$@0',
      'leaf:$[0]@1',
      'leaf:$[1]@1',
      'leaf:$[2]@1',
      'close:$@0',
    ]);
  });

  it('emits no rows when root is undefined', () => {
    expect(flattenTree(undefined, new Set())).toEqual([]);
  });

  it('emits no leaf row when a non-empty container is in expandedPaths but has children expanded', () => {
    // Regression guard: open + close should always bracket the children.
    const { root } = buildTree({ a: [10, 20] });
    const expanded = expandedFor(root, () => true);
    const items = flattenTree(root, expanded);
    expect(items.filter((i) => i.kind === 'open')).toHaveLength(2); // $ and $.a
    expect(items.filter((i) => i.kind === 'close')).toHaveLength(2);
    expect(items.filter((i) => i.kind === 'leaf')).toHaveLength(2); // $.a[0] and $.a[1]
  });

  it('flatten() with an explicit out array appends to the existing list', () => {
    const { root } = buildTree({ a: 1 });
    const expanded = expandedFor(root, () => true);
    const out: FlatItem[] = [];
    flatten(root, 5, expanded, out);
    expect(out[0]!.level).toBe(5);
    expect(out[1]!.level).toBe(6); // child indented one beyond starting level
  });
});

describe('buildVisibleIndexMap', () => {
  it('maps each visible path to its index, skipping close rows', () => {
    const { root } = buildTree({ a: 1, b: 2 });
    const items = flattenTree(
      root,
      expandedFor(root, (n) => n.pathString === '$'),
    );
    const map = buildVisibleIndexMap(items);
    expect(map.get('$')).toBe(0);
    expect(map.get('$.a')).toBe(1);
    expect(map.get('$.b')).toBe(2);
    expect(map.has('close-row')).toBe(false);
  });

  it('returns undefined for paths inside collapsed subtrees', () => {
    const { root } = buildTree({ a: { b: 1 } });
    const items = flattenTree(
      root,
      expandedFor(root, (n) => n.pathString === '$'),
    );
    const map = buildVisibleIndexMap(items);
    expect(map.get('$')).toBe(0);
    expect(map.get('$.a')).toBe(1);
    expect(map.get('$.a.b')).toBeUndefined();
  });

  it('returns the open-row index when a container appears with both open and close rows', () => {
    const { root } = buildTree({ a: 1 });
    const items = flattenTree(
      root,
      expandedFor(root, () => true),
    );
    const map = buildVisibleIndexMap(items);
    // Root is at index 0 (open); the close row at index 2 should not
    // overwrite the canonical open-row index.
    expect(map.get('$')).toBe(0);
  });
});
