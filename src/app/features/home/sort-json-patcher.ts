import type { Node, ParseError } from 'jsonc-parser';
import { findNodeAtLocation, parseTree } from 'jsonc-parser';
import { compareKeysCodeunit } from '../../core/json/sort-keys';
import { bomShift } from './json-patch-utils';

export interface SortPatchResult {
  patched: string;
  targetOffset: number;
  targetLength: number;
  /** The text actually spliced in (the rebuilt object body, inclusive of the outer `{` and `}`). */
  replacementText: string;
}

/**
 * Return shape for {@link patchSortKeysDeep}: the whole-document Sort
 * does not expose surgical splice coordinates because it folds many
 * splices into a single text. Callers only need the final string and
 * whether anything changed.
 */
export interface SortDocumentResult {
  patched: string;
  /** `true` iff at least one object body was rebuilt. */
  changed: boolean;
}

interface PropertySlice {
  key: string;
  sourceText: string;
}

interface ObjectSplice {
  start: number;
  end: number;
  replacement: string;
}

/**
 * Shallow-sort the immediate keys of the object at `path` in `text`,
 * preserving the rest of the document byte-for-byte. The patcher
 * uses byte-splicing to preserve number precision (e.g.,
 * 9007199254740993 stays as the original digits, not the
 * round-tripped 9007199254740992), escape forms ("\u0041" stays
 * "\u0041" not "A"), nested comments inside property values, and
 * the prevailing newline style (LF vs CRLF) of the targeted
 * object's prefix.
 *
 * Inter-property comments inside the targeted object body are
 * lost - they are not associated with any property and the
 * canonical-separator rebuild does not preserve them. This is a
 * documented trade-off per the plan.
 *
 * Throws:
 *   - `'sort.patch.parse-failed'` if `text` has JSONC parse errors
 *     or has no parse root.
 *   - `'sort.patch.path-not-found'` if the path does not resolve.
 *   - `'sort.patch.not-object'` if the node at `path` is not an object.
 *   - `'sort.patch.empty-or-single'` if the object has < 2 properties
 *     (sort would be a no-op; caller should gate via the predicate).
 */
export function patchSortKeysAtPath(
  text: string,
  path: (string | number)[],
  comparator: (a: string, b: string) => number = compareKeysCodeunit,
): SortPatchResult {
  return patchSortKeysAtPathImpl(text, path, comparator);
}

/**
 * Whole-document recursive sort: walks the JSONC AST once and
 * alphabetizes every multi-key object's keys in place via
 * byte-splicing. Preserves the same fidelity properties as
 * {@link patchSortKeysAtPath} - number precision, escape forms,
 * trailing commas, CRLF style, BOM, comments outside any object
 * body, value-internal comments, and existing document whitespace
 * (Sort does not re-pretty-print compact input). Inter-property
 * comments inside each sorted object body are lost - the same
 * trade-off as the row-level patcher, multiplied across every
 * multi-key object in the document.
 *
 * Single-parse implementation: parses `text` once, then rebuilds
 * the source bottom-up from the AST. Each non-leaf node's rebuilt
 * text incorporates its children's already-rebuilt text, so nested
 * sorts compose correctly without any offset arithmetic across
 * splices. Cost is O(text), one `parseTree` call.
 *
 * Throws:
 *   - `'sort.patch.parse-failed'` if `text` has JSONC parse errors
 *     or has no parse root. No other discriminators can fire from
 *     this function (the multi-key gate inside the object rebuild
 *     pre-empts `'sort.patch.empty-or-single'`; `'path-not-found'`
 *     and `'not-object'` are row-level concerns).
 */
export function patchSortKeysDeep(
  text: string,
  comparator: (a: string, b: string) => number = compareKeysCodeunit,
): SortDocumentResult {
  const shift = bomShift(text);
  const parseText = shift > 0 ? text.slice(shift) : text;
  const errors: ParseError[] = [];
  const root = parseTree(parseText, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (!root || errors.length > 0) {
    throw new Error('sort.patch.parse-failed');
  }

  const rebuiltRoot = rebuildSortedNode(text, shift, root, comparator);
  const head = text.substring(0, root.offset + shift);
  const tail = text.substring(root.offset + shift + root.length);
  const patched = head + rebuiltRoot + tail;

  return { patched, changed: patched !== text };
}

function rebuildSortedNode(
  text: string,
  shift: 0 | 1,
  node: Node,
  comparator: (a: string, b: string) => number,
): string {
  if (node.type === 'object') {
    return rebuildSortedObjectNode(text, shift, node, comparator);
  }
  if (node.type === 'array') {
    return rebuildSortedArrayNode(text, shift, node, comparator);
  }
  return text.substring(node.offset + shift, node.offset + shift + node.length);
}

function rebuildSortedObjectNode(
  text: string,
  shift: 0 | 1,
  node: Node,
  comparator: (a: string, b: string) => number,
): string {
  const properties = node.children ?? [];
  const offset = node.offset + shift;
  const nodeEnd = offset + node.length;

  if (properties.length === 0) {
    return text.substring(offset, nodeEnd);
  }

  const bodyStart = offset + 1;
  const bodyEnd = nodeEnd - 1;
  const firstProperty = properties[0];
  const lastProperty = properties[properties.length - 1];
  if (!firstProperty || !lastProperty) {
    throw new Error('sort.patch.parse-failed');
  }

  if (properties.length < 2) {
    // Single-key object: rebuild the one property's value recursively
    // (which may contain nested multi-key objects worth sorting), but
    // do not touch the surrounding bytes. Empty bodies were handled
    // above.
    return (
      '{' +
      text.substring(bodyStart, firstProperty.offset + shift) +
      rebuildPropertyText(text, shift, firstProperty, comparator) +
      text.substring(firstProperty.offset + shift + firstProperty.length, bodyEnd) +
      '}'
    );
  }

  const prefix = text.substring(bodyStart, firstProperty.offset + shift);
  const suffix = text.substring(lastProperty.offset + shift + lastProperty.length, bodyEnd);
  const separator = synthesizeSeparator(prefix);

  const propertySlices = properties.map((propertyNode) => ({
    key: getPropertyKey(propertyNode),
    sourceText: rebuildPropertyText(text, shift, propertyNode, comparator),
  }));
  const sortedPropertySlices = [...propertySlices].sort((left, right) =>
    comparator(left.key, right.key),
  );

  return (
    '{' +
    prefix +
    sortedPropertySlices.map((slice) => slice.sourceText).join(separator) +
    suffix +
    '}'
  );
}

function rebuildSortedArrayNode(
  text: string,
  shift: 0 | 1,
  node: Node,
  comparator: (a: string, b: string) => number,
): string {
  const elements = node.children ?? [];
  const offset = node.offset + shift;
  const nodeEnd = offset + node.length;

  if (elements.length === 0) {
    return text.substring(offset, nodeEnd);
  }

  const bodyStart = offset + 1;
  const bodyEnd = nodeEnd - 1;
  const firstElement = elements[0];
  const lastElement = elements[elements.length - 1];
  if (!firstElement || !lastElement) {
    throw new Error('sort.patch.parse-failed');
  }

  let out = '[' + text.substring(bodyStart, firstElement.offset + shift);
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index]!;
    if (index > 0) {
      const previous = elements[index - 1]!;
      out += text.substring(previous.offset + shift + previous.length, element.offset + shift);
    }
    out += rebuildSortedNode(text, shift, element, comparator);
  }
  out += text.substring(lastElement.offset + shift + lastElement.length, bodyEnd);
  out += ']';
  return out;
}

function rebuildPropertyText(
  text: string,
  shift: 0 | 1,
  propertyNode: Node,
  comparator: (a: string, b: string) => number,
): string {
  if (propertyNode.type !== 'property') {
    throw new Error('sort.patch.parse-failed');
  }

  const propStart = propertyNode.offset + shift;
  const propEnd = propStart + propertyNode.length;
  const valueNode = propertyNode.children?.[1];

  if (!valueNode) {
    return text.substring(propStart, propEnd);
  }

  const valueStart = valueNode.offset + shift;
  const valueEnd = valueStart + valueNode.length;
  const beforeValue = text.substring(propStart, valueStart);
  const afterValue = text.substring(valueEnd, propEnd);
  const rebuiltValue = rebuildSortedNode(text, shift, valueNode, comparator);

  return beforeValue + rebuiltValue + afterValue;
}

function getPropertyKey(propertyNode: Node): string {
  if (propertyNode.type !== 'property') {
    throw new Error('sort.patch.parse-failed');
  }
  const keyNode = propertyNode.children?.[0];
  if (!keyNode || typeof keyNode.value !== 'string') {
    throw new Error('sort.patch.parse-failed');
  }
  return keyNode.value;
}

function realPatchSortKeysAtPath(
  text: string,
  path: (string | number)[],
  comparator: (a: string, b: string) => number = compareKeysCodeunit,
): SortPatchResult {
  const shift = bomShift(text);
  const parseText = shift > 0 ? text.slice(shift) : text;
  const errors: ParseError[] = [];
  const root = parseTree(parseText, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (!root || errors.length > 0) {
    throw new Error('sort.patch.parse-failed');
  }

  const target = findNodeAtLocation(root, path);
  if (!target) {
    throw new Error('sort.patch.path-not-found');
  }

  if (target.type !== 'object') {
    throw new Error('sort.patch.not-object');
  }

  const propertyNodes = target.children ?? [];
  if (propertyNodes.length < 2) {
    throw new Error('sort.patch.empty-or-single');
  }

  const splice = buildSortedObjectSplice(text, shift, target, comparator);
  const patched = text.substring(0, splice.start) + splice.replacement + text.substring(splice.end);

  return {
    patched,
    targetOffset: splice.start,
    targetLength: splice.end - splice.start,
    replacementText: splice.replacement,
  };
}

/**
 * Compute the splice (start byte offset, end byte offset, and
 * replacement text) that sorts the immediate keys of `node`,
 * preserving everything outside the object body byte-for-byte.
 * Caller is responsible for ensuring `node.type === 'object'` and
 * `node.children?.length >= 2`.
 */
function buildSortedObjectSplice(
  text: string,
  shift: 0 | 1,
  node: Node,
  comparator: (a: string, b: string) => number,
): ObjectSplice {
  const propertyNodes = node.children ?? [];
  const firstProperty = propertyNodes[0];
  const lastProperty = propertyNodes[propertyNodes.length - 1];
  if (!firstProperty || !lastProperty) {
    throw new Error('sort.patch.parse-failed');
  }

  const targetOffset = node.offset + shift;
  const bodyStart = targetOffset + 1;
  const bodyEnd = targetOffset + node.length - 1;
  const prefix = text.substring(bodyStart, firstProperty.offset + shift);
  const suffix = text.substring(lastProperty.offset + shift + lastProperty.length, bodyEnd);
  const separator = synthesizeSeparator(prefix);

  const propertySlices = propertyNodes.map((propertyNode) =>
    toPropertySlice(text, shift, propertyNode),
  );
  const sortedPropertySlices = [...propertySlices].sort((left, right) =>
    comparator(left.key, right.key),
  );
  const replacement =
    '{' +
    prefix +
    sortedPropertySlices.map((propertySlice) => propertySlice.sourceText).join(separator) +
    suffix +
    '}';

  return {
    start: targetOffset,
    end: targetOffset + node.length,
    replacement,
  };
}

function toPropertySlice(text: string, shift: 0 | 1, propertyNode: Node): PropertySlice {
  if (propertyNode.type !== 'property') {
    throw new Error('sort.patch.parse-failed');
  }

  const keyNode = propertyNode.children?.[0];
  if (!keyNode || typeof keyNode.value !== 'string') {
    throw new Error('sort.patch.parse-failed');
  }

  return {
    key: keyNode.value,
    sourceText: text.substring(
      propertyNode.offset + shift,
      propertyNode.offset + shift + propertyNode.length,
    ),
  };
}

function synthesizeSeparator(prefix: string): string {
  // The synthesized separator matches the EOL of the existing prefix
  // (CRLF if any `\r\n` is present, else LF). Document-wide
  // newline-style consistency is the caller's responsibility; this
  // function preserves only the prefix-local style.
  if (prefix.includes('\n')) {
    const indentation = prefix.substring(prefix.lastIndexOf('\n') + 1);
    const newline = prefix.includes('\r\n') ? '\r\n' : '\n';
    return ',' + newline + indentation;
  }

  return /^\s+$/.test(prefix) ? ', ' : ',';
}

type PatchSortKeysAtPathImpl = (
  text: string,
  path: (string | number)[],
  comparator?: (a: string, b: string) => number,
) => SortPatchResult;

let patchSortKeysAtPathImpl: PatchSortKeysAtPathImpl = realPatchSortKeysAtPath;

/**
 * Test seam: replace the patcher implementation used by
 * `patchSortKeysAtPath`. Allows specs to force unexpected throws
 * (errors outside the four documented `sort.patch.*` discriminators)
 * to exercise the default branch in `HomeComponent.onSortKeysRequest`.
 * Production code must never call this.
 */
export function __setPatchSortKeysAtPathImplForTesting(impl: PatchSortKeysAtPathImpl): void {
  patchSortKeysAtPathImpl = impl;
}

/**
 * Test seam: restore the production patcher implementation. Pair every
 * `__setPatchSortKeysAtPathImplForTesting` call with this in a
 * `finally` (or `afterEach`) to prevent cross-spec leakage.
 */
export function __resetPatchSortKeysAtPathImplForTesting(): void {
  patchSortKeysAtPathImpl = realPatchSortKeysAtPath;
}
