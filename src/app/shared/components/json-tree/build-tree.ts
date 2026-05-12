/**
 * Pure tree builder, extracted from `JsonTreeComponent` so it can run
 * in a Node bench harness with no Angular DI context.
 *
 * The file's only repo-internal imports are to `json-value-type.ts` and
 * `json-path.ts` (also import-isolated leaves). `tsc -p
 * tsconfig.perf.json` emits a `.js` for each module, and
 * `scripts/perf/build.mjs` rewrites the extensionless specifiers to
 * `.js` so Node ESM can resolve them. See
 * `perf/bench/build-tree.bench.ts` and `docs/perf.md`.
 *
 * `JsonTreeComponent.buildRoot` is now a thin wrapper that calls
 * `buildTree` and emits `tree.build.slow` telemetry around it.
 *
 * `JsonValueType`, `jsonTypeOf`, and `pathToString` are re-exported
 * (with `pathToString` aliased as `formatPath` for the existing
 * call-sites in `JsonTreeComponent` + specs) so external callers do
 * not have to change import paths in lock-step with the consolidation.
 */

import { pathToString } from '../../../core/json/json-path';
import { jsonTypeOf, type JsonValueType } from '../../../core/json/json-value-type';

export { pathToString as formatPath, jsonTypeOf, type JsonValueType };

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
    pathString: pathToString(path),
    value,
    type,
    depth: path.length,
  };
  if (type === 'object' || type === 'array') {
    node.children = buildChildren(value, path, counter);
  }
  return node;
}
