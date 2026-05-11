/**
 * Pure tree builder, extracted from `JsonTreeComponent` so it can run
 * in a Node bench harness with no Angular DI context.
 *
 * The file has zero repo-internal imports (only stdlib types), so
 * `tsc -p tsconfig.perf.json` produces a `.mjs` that Node ESM can
 * resolve without rewriting relative specifiers. See
 * `perf/bench/build-tree.bench.ts` and `docs/perf.md`.
 *
 * `JsonTreeComponent.buildRoot` is now a thin wrapper that calls
 * `buildTree` and emits `tree.build.slow` telemetry around it.
 *
 * `JsonValueType`, `jsonTypeOf`, and `formatPath` are intentionally
 * duplicated here from `src/app/shared/pipes/json-type.pipe.ts` and
 * `JsonParserService.pathToString` respectively to keep this file
 * import-isolated. The component imports `formatPath` back from this
 * module so its other ~8 callsites stay deduplicated.
 */

export type JsonValueType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'undefined';

export interface TreeNode {
  segment: string | number | undefined;
  path: (string | number)[];
  pathString: string;
  value: unknown;
  type: JsonValueType;
  depth: number;
  children?: TreeNode[];
}

export interface TreeBuildCounter {
  nodeCount: number;
}

export interface TreeBuildResult {
  root: TreeNode;
  nodeCount: number;
}

/**
 * Builds the canonical `TreeNode` tree from a parsed JSON value.
 *
 * Returns both the root and the total node count (incl. the root) so
 * callers can drive `tree.build.slow` telemetry, virtual-scroll
 * sizing, and any other consumers that care about total size without
 * a second walk.
 */
export function buildTree(raw: unknown): TreeBuildResult {
  const counter: TreeBuildCounter = { nodeCount: 1 };
  const root: TreeNode = {
    segment: undefined,
    path: [],
    pathString: '$',
    value: raw,
    type: jsonTypeOf(raw),
    depth: 0,
  };
  if (root.type === 'object' || root.type === 'array') {
    root.children = buildChildren(raw, [], counter);
  }
  return { root, nodeCount: counter.nodeCount };
}

export function buildChildren(
  value: unknown,
  parentPath: (string | number)[],
  counter: TreeBuildCounter,
): TreeNode[] {
  if (Array.isArray(value)) {
    return value.map((child, index) => buildNode(index, child, [...parentPath, index], counter));
  }
  if (value && typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    return Object.keys(objectValue).map((key) =>
      buildNode(key, objectValue[key], [...parentPath, key], counter),
    );
  }
  return [];
}

export function buildNode(
  segment: string | number,
  value: unknown,
  path: (string | number)[],
  counter: TreeBuildCounter,
): TreeNode {
  counter.nodeCount += 1;
  const type = jsonTypeOf(value);
  const node: TreeNode = {
    segment,
    path,
    pathString: formatPath(path),
    value,
    type,
    depth: path.length,
  };
  if (type === 'object' || type === 'array') {
    node.children = buildChildren(value, path, counter);
  }
  return node;
}

/**
 * Renders a canonical JSON path (e.g. `$.foo[0]["a.b"]`) for the given
 * segment array.
 *
 * This duplicates `JsonParserService.pathToString`. The duplication is
 * pre-existing; both produce identical output for all legal segment
 * arrays. Do not consolidate in this PR -- the pre-existing duplication
 * predates the extraction.
 */
export function formatPath(path: (string | number)[]): string {
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

/**
 * Returns the JSON-spec value-type discriminant for a parsed value.
 *
 * Duplicated from `src/app/shared/pipes/json-type.pipe.ts` to keep this
 * module import-isolated for the Node bench harness. The pipe is the
 * canonical surface for templates; this copy is for the tree-build
 * fast path only. Keep these in sync if either changes.
 */
export function jsonTypeOf(value: unknown): JsonValueType {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}
