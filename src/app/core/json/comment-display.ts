/**
 * Pure formatters for rendering JSONC comment bundles in
 * `JsonTreeComponent`.
 *
 * Hosts `formatInlineComment` (the visible-vs-tooltip-vs-count
 * contract), the badge formatters (`moreBadge`,
 * `moreBadgeAriaLabel`), and the empty-container trailing-slot
 * merge.
 *
 * No DOM, no Angular DI; unit-testable directly without TestBed.
 */
import type { CommentBundle } from './parse';

/** Per-render inline-comment text payload. The template renders the
 *  badge as a sibling span when `count >= 2`; `visible` never
 *  contains the badge. */
export interface InlineCommentText {
  readonly visible: string;
  readonly tooltipBody: string;
  readonly count: number;
}

/** First-line preview of a single comment body. Used standalone for
 *  the visible slot text and re-used inside `formatInlineComment`. */
export function commentFirstLine(text: string): string {
  const newlineIndex = text.indexOf('\n');
  return newlineIndex === -1 ? text : text.slice(0, newlineIndex);
}

/** Empty / undefined input -> null; otherwise format the first
 *  body's preview plus the multi-body tooltip text. Never embeds
 *  the badge in `visible`. Parameter is the slot array directly;
 *  there is no parallel count to desynchronize. */
export function formatInlineComment(
  bodies: readonly string[] | undefined,
): InlineCommentText | null {
  if (!bodies || bodies.length === 0) return null;

  const firstBody = bodies[0];
  if (firstBody === undefined) return null;

  return {
    visible: commentFirstLine(firstBody),
    tooltipBody: bodies.join('\n'),
    count: bodies.length,
  };
}

/** Visible badge token "(+N)" rendered into `<span class="tree-comment-count">`.
 *  Localized via $localize with stable ID. */
export function moreBadge(extraCount: number): string {
  return $localize`:@@tree.comment.moreBadge:(+${extraCount}:INTERPOLATION:)`;
}

/** Aria-label phrasing for the same badge. Localized via $localize
 *  with stable IDs; uses a singular/plural pair matching the
 *  in-repo `tree.search.count.one`/`.other` precedent. Note that
 *  `extraCount === 1` (a length-2 stack of comments) is the common
 *  case, not an edge case: the renderer template guards `count >= 2`
 *  so `extraCount = count - 1 >= 1`. */
export function moreBadgeAriaLabel(extraCount: number): string {
  if (extraCount === 1) {
    return $localize`:@@tree.comment.moreBadge.aria.one:1 more comment`;
  }
  return $localize`:@@tree.comment.moreBadge.aria.other:${extraCount}:INTERPOLATION: more comments`;
}

/** Empty-container trailing-slot merge. Flattens the bundle's
 *  trailing, closeLeading, and closeTrailing arrays into one
 *  `InlineCommentText`. Pure (no DOM, no component reference) so
 *  it's unit-testable without TestBed. Order: trailing, then
 *  closeLeading, then closeTrailing. Skips absent slots; the
 *  parser never emits empty arrays. */
export function mergeEmptyContainerTrailing(bundle: CommentBundle): InlineCommentText | null {
  const all: string[] = [];

  if (bundle.trailing) all.push(...bundle.trailing);
  if (bundle.closeLeading) all.push(...bundle.closeLeading);
  if (bundle.closeTrailing) all.push(...bundle.closeTrailing);

  return formatInlineComment(all);
}
