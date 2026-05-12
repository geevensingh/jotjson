import {
  buildChildren,
  buildNode,
  buildTree,
  formatPath,
  jsonTypeOf,
  type TreeBuildCounter,
  type TreeNode,
} from './build-tree';

/**
 * Unit tests for the import-isolated pure-function `build-tree` module.
 *
 * The companion `build-tree.parity.spec.ts` proves
 * `JsonTreeComponent.buildRoot` delegates correctly. The legacy
 * `json-tree.component.spec.ts` exercises the component surface
 * end-to-end through Angular DI.
 *
 * Tests below focus on the surface the Layer-1 perf bench
 * (`perf/bench/build-tree.bench.ts`) drives: zero DI, no `inject()`,
 * no Angular imports, no repo-internal imports. `new`-able from a Node
 * ESM bench harness.
 */
describe('buildTree (pure)', () => {
  it('builds a single-node tree for primitive root', () => {
    const result = buildTree(42);
    expect(result.nodeCount).toBe(1);
    expect(result.root.value).toBe(42);
    expect(result.root.type).toBe('number');
    expect(result.root.children).toBeUndefined();
    expect(result.root.pathString).toBe('$');
    expect(result.root.depth).toBe(0);
  });

  it('builds tree for flat object', () => {
    const result = buildTree({ a: 1, b: 'two', c: null });
    expect(result.nodeCount).toBe(4); // root + 3 children
    expect(result.root.children?.length).toBe(3);
    expect(result.root.children?.[0].pathString).toBe('$.a');
    expect(result.root.children?.[1].pathString).toBe('$.b');
    expect(result.root.children?.[2].pathString).toBe('$.c');
    expect(result.root.children?.[2].type).toBe('null');
  });

  it('builds tree for nested array + object', () => {
    const result = buildTree({ a: [1, { b: true }] });
    expect(result.nodeCount).toBe(5); // root, a, a[0], a[1], a[1].b
    const aNode = result.root.children?.[0];
    expect(aNode?.type).toBe('array');
    expect(aNode?.children?.[0].pathString).toBe('$.a[0]');
    expect(aNode?.children?.[1].pathString).toBe('$.a[1]');
    expect(aNode?.children?.[1].children?.[0].pathString).toBe('$.a[1].b');
  });

  it('preserves insertion order for object children', () => {
    const result = buildTree({ z: 1, a: 2, m: 3 });
    const keys = result.root.children?.map((c) => c.segment);
    expect(keys).toEqual(['z', 'a', 'm']);
  });

  it('records depth for each node', () => {
    const result = buildTree({ a: { b: { c: 'leaf' } } });
    const aNode = result.root.children?.[0] as TreeNode;
    const bNode = aNode.children?.[0] as TreeNode;
    const cNode = bNode.children?.[0] as TreeNode;
    expect(aNode.depth).toBe(1);
    expect(bNode.depth).toBe(2);
    expect(cNode.depth).toBe(3);
  });

  it('handles empty container at root', () => {
    expect(buildTree({}).nodeCount).toBe(1);
    expect(buildTree([]).nodeCount).toBe(1);
  });
});

describe('buildChildren / buildNode', () => {
  it('buildChildren returns [] for primitive', () => {
    const counter: TreeBuildCounter = { nodeCount: 1 };
    expect(buildChildren(42, [], counter)).toEqual([]);
    expect(counter.nodeCount).toBe(1);
  });

  it('buildNode increments counter per node', () => {
    const counter: TreeBuildCounter = { nodeCount: 1 };
    buildNode('foo', { a: 1 }, ['foo'], counter);
    // root container + 1 child
    expect(counter.nodeCount).toBe(3);
  });
});

describe('formatPath', () => {
  it('renders root for empty', () => {
    expect(formatPath([])).toBe('$');
  });

  it('uses dot for identifier keys', () => {
    expect(formatPath(['foo', 'bar'])).toBe('$.foo.bar');
  });

  it('uses bracket for numeric indices', () => {
    expect(formatPath(['arr', 0])).toBe('$.arr[0]');
  });

  it('uses bracket + JSON string for non-identifier keys', () => {
    expect(formatPath(['a.b'])).toBe('$["a.b"]');
  });
});

describe('jsonTypeOf', () => {
  it('classifies primitives', () => {
    expect(jsonTypeOf(null)).toBe('null');
    expect(jsonTypeOf(undefined)).toBe('undefined');
    expect(jsonTypeOf(true)).toBe('boolean');
    expect(jsonTypeOf(42)).toBe('number');
    expect(jsonTypeOf('hi')).toBe('string');
  });

  it('classifies containers', () => {
    expect(jsonTypeOf([])).toBe('array');
    expect(jsonTypeOf({})).toBe('object');
  });
});
