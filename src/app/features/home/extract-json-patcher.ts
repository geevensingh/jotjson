import type { ParseError } from 'jsonc-parser';
import { applyEdits, findNodeAtLocation, parseTree } from 'jsonc-parser';
import type { ExtractedJson } from '../../core/json/json-extractor.service';
import { bomShift, computeColumn, reindentReplacement } from './json-patch-utils';

export interface PatchResult {
  patched: string;
  targetOffset: number;
  targetLength: number;
  /**
   * The text actually spliced in (post-reindent). Equal to `patched.substring(targetOffset, targetOffset + replacementText.length)`.
   */
  replacementText: string;
}

/**
 * Splice the extracted JSON payload over the value at `path` in
 * `text`. Single call site today: `HomeComponent.onExtractRequest`
 * (`features/home/home.component.ts`).
 *
 * Throws:
 *   - `'extract.patch.parse-failed'` if `text` has JSONC parse errors
 *     or has no parse root.
 *   - `'extract.patch.path-not-found'` if the path does not resolve.
 *
 * The handler at the single call site translates these two
 * discriminators to closed-enum `tree.extract.applyFailed` warn
 * reasons; any other throw routes to `tree.extract.unexpectedError`
 * to keep raw exception messages out of `customDimensions` (see
 * AGENTS.md S4 Telemetry / Privacy). Issue #372 tracks evolving
 * this string-discriminator contract to a typed error or
 * `Result<T, E>` shape; until then, the two literals above are the
 * stable contract surface.
 */
export function patchExtractedValue(
  text: string,
  path: (string | number)[],
  replacement: ExtractedJson,
): PatchResult {
  return patchExtractedValueImpl(text, path, replacement);
}

function realPatchExtractedValue(
  text: string,
  path: (string | number)[],
  replacement: ExtractedJson,
): PatchResult {
  const shift = bomShift(text);
  const parseText = shift > 0 ? text.slice(shift) : text;
  const errors: ParseError[] = [];
  const root = parseTree(parseText, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (!root || errors.length > 0) {
    throw new Error('extract.patch.parse-failed');
  }

  const target = findNodeAtLocation(root, path);
  if (!target) {
    throw new Error('extract.patch.path-not-found');
  }

  const targetOffset = target.offset + shift;
  const column = computeColumn(text, targetOffset);
  const indented = reindentReplacement(replacement.text, column);
  const patched = applyEdits(text, [
    { offset: targetOffset, length: target.length, content: indented },
  ]);
  return {
    patched,
    targetOffset,
    targetLength: target.length,
    replacementText: indented,
  };
}

type PatchExtractedValueImpl = (
  text: string,
  path: (string | number)[],
  replacement: ExtractedJson,
) => PatchResult;

let patchExtractedValueImpl: PatchExtractedValueImpl = realPatchExtractedValue;

/**
 * Test seam: replace the patcher implementation used by
 * `patchExtractedValue`. Allows specs to force unexpected throws
 * (errors outside the two documented `extract.patch.*` discriminators)
 * to exercise the default branch in `HomeComponent.onExtractRequest`.
 * Production code must never call this.
 */
export function __setPatchExtractedValueImplForTesting(impl: PatchExtractedValueImpl): void {
  patchExtractedValueImpl = impl;
}

/**
 * Test seam: restore the production patcher implementation. Pair every
 * `__setPatchExtractedValueImplForTesting` call with this in a
 * `finally` (or `afterEach`) to prevent cross-spec leakage.
 */
export function __resetPatchExtractedValueImplForTesting(): void {
  patchExtractedValueImpl = realPatchExtractedValue;
}
