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

interface PropertySlice {
  key: string;
  sourceText: string;
}

/**
 * Shallow-sort the immediate keys of the object at `path` in `text`,
 * preserving the rest of the document byte-for-byte. The patcher
 * uses byte-splicing to preserve number precision (e.g.,
 * 9007199254740993 stays as the original digits, not the
 * round-tripped 9007199254740992), escape forms ("\u0041" stays
 * "\u0041" not "A"), and nested comments inside property values.
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

  const firstProperty = propertyNodes[0];
  const lastProperty = propertyNodes[propertyNodes.length - 1];
  if (!firstProperty || !lastProperty) {
    throw new Error('sort.patch.parse-failed');
  }

  const targetOffset = target.offset + shift;
  const bodyStart = targetOffset + 1;
  const bodyEnd = targetOffset + target.length - 1;
  const prefix = text.substring(bodyStart, firstProperty.offset + shift);
  const suffix = text.substring(lastProperty.offset + shift + lastProperty.length, bodyEnd);
  const separator = synthesizeSeparator(prefix);

  const propertySlices = propertyNodes.map((propertyNode) =>
    toPropertySlice(text, shift, propertyNode),
  );
  const sortedPropertySlices = [...propertySlices].sort((left, right) =>
    comparator(left.key, right.key),
  );
  const replacementText =
    '{' +
    prefix +
    sortedPropertySlices.map((propertySlice) => propertySlice.sourceText).join(separator) +
    suffix +
    '}';
  const patched =
    text.substring(0, targetOffset) +
    replacementText +
    text.substring(targetOffset + target.length);

  return {
    patched,
    targetOffset,
    targetLength: target.length,
    replacementText,
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
  if (prefix.includes('\n')) {
    const indentation = prefix.substring(prefix.lastIndexOf('\n') + 1);
    return ',\n' + indentation;
  }

  return /^\s+$/.test(prefix) ? ', ' : ',';
}
