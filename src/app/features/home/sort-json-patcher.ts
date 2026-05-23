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

/**
 * Per-property partition of an object body. The four text fields
 * capture every byte of the source layout for one property so that
 * comments and whitespace travel WITH the property under sort.
 *
 *   headerText               -- bytes before `propertyText` and after
 *                               the prior structural anchor (the `{`
 *                               or the previous property's
 *                               `trailerAfterStructure`).
 *   propertyText             -- the property itself. For the deep
 *                               path this is the recursively rebuilt
 *                               key/value text; for the row-level
 *                               path it is the property's literal
 *                               source bytes.
 *   trailerBeforeStructure   -- bytes between value end and the
 *                               structural comma (empty when there
 *                               is no comma).
 *   trailerAfterStructure    -- bytes between the structural comma
 *                               (or value end, when there is no
 *                               comma) and the next structural
 *                               anchor (either the first non-comment
 *                               newline or the start of the next
 *                               property's headerText).
 *
 * Reserialization always emits
 * `headerText + propertyText + trailerBeforeStructure + ',' (if
 * needed) + trailerAfterStructure`. The comma sits between the two
 * trailer fields so a `// line comment` immediately after the value
 * never eats an added comma.
 */
interface PropertyPartition {
  key: string;
  headerText: string;
  propertyText: string;
  trailerBeforeStructure: string;
  trailerAfterStructure: string;
}

/**
 * Partition of an entire `{...}` body. `openingPrefix` is the
 * content immediately after `{` (before the first property's
 * `headerText`); `closingSuffix` is the content immediately before
 * `}` (after the last property's `trailerAfterStructure`).
 * `hasTrailingComma` records whether the source had a trailing
 * comma after the source-last property -- on reserialize we
 * re-emit it iff this flag is true.
 *
 * Contract: callers must ensure `properties.length >= 2`.
 * `partitionObjectContent` is not defined for 0 or 1 properties;
 * the public functions (`patchSortKeysAtPath`, the deep walker
 * `rebuildSortedObjectNode`) short-circuit those cases before
 * partitioning.
 */
interface ObjectPartition {
  openingPrefix: string;
  properties: PropertyPartition[];
  closingSuffix: string;
  hasTrailingComma: boolean;
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
 * "\u0041" not "A"), nested comments inside property values, the
 * prevailing newline style (LF / CRLF / bare CR) of the targeted
 * object's body, and inter-property comments inside the targeted
 * object body.
 *
 * Inter-property comments are associated with the property they
 * sit closest to via the gap-split rules documented in
 * `partitionObjectContent`. Documented limits (do not surface as
 * bugs):
 *
 *   1. Blank lines between properties may visually drift on sort.
 *   2. A `// tail` comment placed after the source-last property's
 *      trailing comma may migrate to a between-properties position
 *      when that property is no longer sorted-last.
 *   3. Leading-comma source layouts (`{"x":1\n  ,"y":2}`) produce
 *      stylistically mixed output because attribution is
 *      source-position based.
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
 * trailing commas, CRLF / LF / bare-CR newline style, BOM,
 * comments outside any object body, value-internal comments, and
 * existing document whitespace (Sort does not re-pretty-print
 * compact input). Inter-property comments inside each sorted
 * multi-key object body are also preserved, attributed to their
 * neighbouring property via the gap-split rules documented in
 * `partitionObjectContent`. The documented limits enumerated on
 * {@link patchSortKeysAtPath} apply at every multi-key object
 * level walked by the deep sort.
 *
 * Single-parse implementation: parses `text` once, then rebuilds
 * the source bottom-up from the AST. Each non-leaf node's rebuilt
 * text incorporates its children's already-rebuilt text, so nested
 * sorts compose correctly without any offset arithmetic across
 * splices. Cost is O(text), one `parseTree` call.
 *
 * Single-key objects are NOT sorted (there is nothing to reorder),
 * but the deep walker still recurses into the single property's
 * value, so `{"only":{"y":2,"x":1}}` correctly becomes
 * `{"only":{"x":1,"y":2}}`.
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

  if (properties.length < 2) {
    const onlyProperty = properties[0];
    if (!onlyProperty) {
      throw new Error('sort.patch.parse-failed');
    }
    const bodyStart = offset + 1;
    const bodyEnd = nodeEnd - 1;
    return (
      '{' +
      text.substring(bodyStart, onlyProperty.offset + shift) +
      rebuildPropertyText(text, shift, onlyProperty, comparator) +
      text.substring(onlyProperty.offset + shift + onlyProperty.length, bodyEnd) +
      '}'
    );
  }

  const partition = partitionObjectContent(text, shift, node, (propertyNode) =>
    rebuildPropertyText(text, shift, propertyNode, comparator),
  );
  return serializeObjectPartition(partition, comparator);
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
  const targetOffset = node.offset + shift;
  const partition = partitionObjectContent(text, shift, node, (propertyNode) =>
    text.substring(propertyNode.offset + shift, propertyNode.offset + shift + propertyNode.length),
  );
  const replacement = serializeObjectPartition(partition, comparator);

  return {
    start: targetOffset,
    end: targetOffset + node.length,
    replacement,
  };
}

/**
 * Partition the body of `node` into per-property text slices using
 * the source-position-based attribution rules locked in the Wave
 * 7.2-revised-2 plan. `rebuildPropertyText` is the per-property
 * text producer: the deep path passes a recursive callback, the
 * row-level path passes a literal-bytes callback.
 *
 * Contract: `node.type === 'object'` AND `node.children.length >=
 * 2`. The 0- and 1-property cases are handled by the calling
 * public functions (see `patchSortKeysAtPath` and
 * `rebuildSortedObjectNode`).
 *
 * Gap-split rules (concise; see plan.md Wave 7.2-revised-2 for the
 * full normative table):
 *
 *   gap 0   (after `{`, before first property)
 *     has structural newline -> openingPrefix = before-incl,
 *                                header[0] = after
 *     no newline             -> openingPrefix = "",
 *                                header[0] = whole gap
 *
 *   middle gap i (between source prop i-1 and source prop i)
 *     find first structural comma (outside `/* * /` + `// ...`)
 *     post-comma has newline -> trailerBefore[i-1] = pre-comma
 *                                trailerAfter[i-1]  = before-incl
 *                                header[i]          = after
 *     post-comma no newline  -> trailerBefore[i-1] = pre-comma
 *                                trailerAfter[i-1]  = whole post-comma
 *                                header[i]          = ""
 *
 *   gap N   (after last source property, before `}`)
 *     find structural comma (`hasTrailingComma`)
 *     has tc, post-comma has nl -> trailerBefore[N-1] = pre-comma
 *                                   trailerAfter[N-1]  = before-incl
 *                                   closing            = after
 *     has tc, post-comma no nl  -> trailerBefore[N-1] = pre-comma
 *                                   trailerAfter[N-1]  = whole post-comma
 *                                   closing            = ""
 *     no tc, has nl             -> trailerBefore[N-1] = ""
 *                                   trailerAfter[N-1]  = before-incl
 *                                   closing            = after
 *     no tc, no nl              -> trailerBefore[N-1] = ""
 *                                   trailerAfter[N-1]  = whole gap
 *                                   closing            = ""
 */
function partitionObjectContent(
  text: string,
  shift: 0 | 1,
  node: Node,
  rebuildPropertyText: (propertyNode: Node) => string,
): ObjectPartition {
  const properties = node.children ?? [];
  if (properties.length < 2) {
    throw new Error('sort.patch.parse-failed');
  }

  const offset = node.offset + shift;
  const bodyStart = offset + 1;
  const bodyEnd = offset + node.length - 1;

  const partitionProperties: PropertyPartition[] = properties.map((propertyNode) => ({
    key: getPropertyKey(propertyNode),
    propertyText: rebuildPropertyText(propertyNode),
    headerText: '',
    trailerBeforeStructure: '',
    trailerAfterStructure: '',
  }));

  const firstProperty = properties[0]!;
  const gap0Text = text.substring(bodyStart, firstProperty.offset + shift);
  const gap0Split = splitGapFirstNewline(gap0Text);
  let openingPrefix: string;
  if (gap0Split.hasNewline) {
    openingPrefix = gap0Split.before;
    partitionProperties[0]!.headerText = gap0Split.after;
  } else {
    openingPrefix = '';
    partitionProperties[0]!.headerText = gap0Text;
  }

  for (let propertyIndex = 1; propertyIndex < properties.length; propertyIndex++) {
    const previousProperty = properties[propertyIndex - 1]!;
    const currentProperty = properties[propertyIndex]!;
    const gapStart = previousProperty.offset + shift + previousProperty.length;
    const gapEnd = currentProperty.offset + shift;
    const gapText = text.substring(gapStart, gapEnd);

    const commaIndex = findStructuralComma(gapText);
    if (commaIndex < 0) {
      throw new Error('sort.patch.parse-failed');
    }

    const preComma = gapText.substring(0, commaIndex);
    const postComma = gapText.substring(commaIndex + 1);
    const postCommaSplit = splitGapFirstNewline(postComma);

    partitionProperties[propertyIndex - 1]!.trailerBeforeStructure = preComma;
    if (postCommaSplit.hasNewline) {
      partitionProperties[propertyIndex - 1]!.trailerAfterStructure = postCommaSplit.before;
      partitionProperties[propertyIndex]!.headerText = postCommaSplit.after;
    } else {
      partitionProperties[propertyIndex - 1]!.trailerAfterStructure = postComma;
      partitionProperties[propertyIndex]!.headerText = '';
    }
  }

  const lastProperty = properties[properties.length - 1]!;
  const gapNStart = lastProperty.offset + shift + lastProperty.length;
  const gapNText = text.substring(gapNStart, bodyEnd);

  const commaIndexN = findStructuralComma(gapNText);
  let hasTrailingComma = false;
  let closingSuffix = '';

  if (commaIndexN >= 0) {
    hasTrailingComma = true;
    const preComma = gapNText.substring(0, commaIndexN);
    const postComma = gapNText.substring(commaIndexN + 1);
    const postCommaSplit = splitGapFirstNewline(postComma);

    partitionProperties[partitionProperties.length - 1]!.trailerBeforeStructure = preComma;
    if (postCommaSplit.hasNewline) {
      partitionProperties[partitionProperties.length - 1]!.trailerAfterStructure =
        postCommaSplit.before;
      closingSuffix = postCommaSplit.after;
    } else {
      partitionProperties[partitionProperties.length - 1]!.trailerAfterStructure = postComma;
      closingSuffix = '';
    }
  } else {
    const gapNSplit = splitGapFirstNewline(gapNText);
    partitionProperties[partitionProperties.length - 1]!.trailerBeforeStructure = '';
    if (gapNSplit.hasNewline) {
      partitionProperties[partitionProperties.length - 1]!.trailerAfterStructure = gapNSplit.before;
      closingSuffix = gapNSplit.after;
    } else {
      partitionProperties[partitionProperties.length - 1]!.trailerAfterStructure = gapNText;
      closingSuffix = '';
    }
  }

  return {
    openingPrefix,
    properties: partitionProperties,
    closingSuffix,
    hasTrailingComma,
  };
}

/**
 * Reserialize an `ObjectPartition` into the rebuilt `{...}` text
 * with properties sorted by `comparator(left.key, right.key)`.
 * Array.sort is stable (ES2019+), so a comparator that returns 0
 * for two distinct keys preserves source order between them.
 */
function serializeObjectPartition(
  partition: ObjectPartition,
  comparator: (a: string, b: string) => number,
): string {
  const sorted = [...partition.properties].sort((left, right) => comparator(left.key, right.key));
  let out = '{' + partition.openingPrefix;
  for (let propertyIndex = 0; propertyIndex < sorted.length; propertyIndex++) {
    const property = sorted[propertyIndex]!;
    out += property.headerText + property.propertyText + property.trailerBeforeStructure;
    if (propertyIndex < sorted.length - 1 || partition.hasTrailingComma) {
      out += ',';
    }
    out += property.trailerAfterStructure;
  }
  out += partition.closingSuffix + '}';
  return out;
}

/**
 * Advance past a `/* ... * /` block comment.
 *
 * Precondition: `text[i] === '/' && text[i + 1] === '*'`. Returns
 * the index immediately AFTER the closing `* /`, or `text.length`
 * if the comment is unterminated (jsonc-parser's `parseTree` gates
 * unterminated comments upstream; this fallback is defensive only).
 */
function skipBlockComment(text: string, i: number): number {
  let j = i + 2;
  while (j + 1 < text.length) {
    if (text.charCodeAt(j) === 0x2a /* '*' */ && text.charCodeAt(j + 1) === 0x2f /* '/' */) {
      return j + 2;
    }
    j++;
  }
  return text.length;
}

/**
 * Advance past a `// ...` line comment.
 *
 * Precondition: `text[i] === '/' && text[i + 1] === '/'`. Returns
 * the index OF the next line terminator (`\n` or `\r`), matching
 * jsonc-parser's terminator set, or `text.length` if EOF reaches
 * before a terminator. The terminator character itself is NOT
 * consumed by this helper.
 */
function skipLineComment(text: string, i: number): number {
  let j = i + 2;
  while (j < text.length) {
    const code = text.charCodeAt(j);
    if (code === 0x0a /* '\n' */ || code === 0x0d /* '\r' */) {
      return j;
    }
    j++;
  }
  return text.length;
}

/**
 * Find the first structural `,` in `text` -- one that sits outside
 * any `/* ... * /` block comment and any `// ...` line comment.
 * Returns the index or `-1` if no structural comma exists.
 *
 * Line-terminator set for `//` matches jsonc-parser: `\n`, `\r\n`,
 * or bare `\r`. Both `//` and `/*` are tokenized; non-comment text
 * is otherwise treated character by character.
 */
function findStructuralComma(text: string): number {
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x2f /* '/' */ && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next === 0x2a /* '*' */) {
        i = skipBlockComment(text, i);
        continue;
      }
      if (next === 0x2f /* '/' */) {
        i = skipLineComment(text, i);
        continue;
      }
    }
    if (code === 0x2c /* ',' */) {
      return i;
    }
    i++;
  }
  return -1;
}

/**
 * Split `text` on its first structural line terminator -- the first
 * `\n` / `\r\n` / `\r` that sits OUTSIDE any `/* ... * /` block
 * comment. `// ...` line comments are NOT skipped (they end at a
 * newline, which is the split point we want).
 *
 * Returns `{ hasNewline, before, after }` where `before` INCLUDES
 * the newline character(s) when present.
 *
 * For `\r\n` to be recognized as a 2-char newline, BOTH `\r` and
 * `\n` must be outside the same block-comment scope; otherwise the
 * `\n` outside the comment is the recognized 1-char newline (the
 * `\r` inside the comment is comment content).
 */
function splitGapFirstNewline(text: string): {
  hasNewline: boolean;
  before: string;
  after: string;
} {
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x2f /* '/' */ && i + 1 < text.length && text.charCodeAt(i + 1) === 0x2a) {
      i = skipBlockComment(text, i);
      continue;
    }
    if (code === 0x0d /* '\r' */) {
      if (i + 1 < text.length && text.charCodeAt(i + 1) === 0x0a /* '\n' */) {
        return {
          hasNewline: true,
          before: text.substring(0, i + 2),
          after: text.substring(i + 2),
        };
      }
      return { hasNewline: true, before: text.substring(0, i + 1), after: text.substring(i + 1) };
    }
    if (code === 0x0a /* '\n' */) {
      return { hasNewline: true, before: text.substring(0, i + 1), after: text.substring(i + 1) };
    }
    i++;
  }
  return { hasNewline: false, before: text, after: '' };
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
