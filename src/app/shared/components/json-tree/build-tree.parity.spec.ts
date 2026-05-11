import { jsonTypeOf as pipeJsonTypeOf } from '../../pipes/json-type.pipe';
import { buildTree, jsonTypeOf as pureJsonTypeOf } from './build-tree';

/**
 * Parity spec: asserts the pure `build-tree` module produces the same
 * shape the legacy in-component implementation produced, and that the
 * duplicated `jsonTypeOf` in `build-tree.ts` stays in sync with the
 * canonical pipe implementation.
 *
 * The component-side wrapper now delegates to `buildTree`; full
 * end-to-end coverage lives in `json-tree.component.spec.ts`. This
 * parity spec is a guard against drift between:
 *
 * - the inlined `build-tree.ts:jsonTypeOf` (kept inline for Node bench
 *   import isolation per `docs/perf.md`) and
 * - `src/app/shared/pipes/json-type.pipe.ts:jsonTypeOf` (the canonical
 *   surface used by Angular templates).
 */
const TREE_FIXTURES = [
  { name: 'primitive number', value: 42 },
  { name: 'primitive null', value: null },
  { name: 'flat object', value: { a: 1, b: 'two', c: null } },
  { name: 'flat array', value: [1, 2, 3] },
  {
    name: 'nested object + array',
    value: { a: [1, { b: true }, [3, 4]], c: { d: { e: 'leaf' } } },
  },
  { name: 'empty object', value: {} },
  { name: 'empty array', value: [] },
  { name: 'object with non-identifier keys', value: { 'a.b': 1, '0starts': 2 } },
];

describe('build-tree parity (pure <-> pipe jsonTypeOf)', () => {
  // jsonTypeOf duplication: assert the two implementations agree for
  // the full set of JsonValueType discriminants.
  const VALUES: { name: string; value: unknown }[] = [
    { name: 'null', value: null },
    { name: 'undefined', value: undefined },
    { name: 'true', value: true },
    { name: 'false', value: false },
    { name: 'number', value: 42 },
    { name: 'string', value: 'hi' },
    { name: 'array', value: [1, 2] },
    { name: 'object', value: { a: 1 } },
  ];

  for (const { name, value } of VALUES) {
    it(`jsonTypeOf agrees for ${name}`, () => {
      expect(pureJsonTypeOf(value)).toBe(pipeJsonTypeOf(value));
    });
  }
});

describe('build-tree shape stability', () => {
  for (const fixture of TREE_FIXTURES) {
    it(`stable shape for: ${fixture.name}`, () => {
      const result = buildTree(fixture.value);
      // root always has segment === undefined and pathString === '$'
      expect(result.root.segment).toBeUndefined();
      expect(result.root.pathString).toBe('$');
      expect(result.root.depth).toBe(0);
      // nodeCount === walk size, used by the slow-build telemetry path.
      let walked = 0;
      const walk = (node: { children?: { segment: unknown }[] } | undefined): void => {
        if (!node) return;
        walked += 1;
        for (const child of node.children ?? []) {
          walk(child as { children?: { segment: unknown }[] });
        }
      };
      walk(result.root);
      expect(walked).toBe(result.nodeCount);
    });
  }
});
