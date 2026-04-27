/**
 * Centralized server-side limits for the formatting-rules feature
 * (M6). DESIGN_SPEC.md §Features 7 cites this file as the source of
 * truth; raising any of these is a one-edit change here, mirroring
 * how `MAX_BLOBS_PER_USER` lives next to the blobs accessor.
 *
 * Kept in `shared/` (not `functions/`) so handlers and tests can both
 * import without dragging Azure Functions runtime types into shared
 * code. Constants are `as const`-friendly so callers can use them in
 * type positions if needed.
 */

/** Maximum rule sets a single user may own. Free-tier quota. */
export const MAX_RULE_SETS_PER_USER = 20;

/** Maximum rules a single rule set may contain. Free-tier quota. */
export const MAX_RULES_PER_SET = 50;

/** Maximum length (in chars) of a rule set's user-supplied `name`. */
export const MAX_RULE_SET_NAME_LENGTH = 80;

/**
 * Maximum length (in chars) of a rule's `matchValue`. Bounded so that
 * a single rule cannot blow up the rule-set document and so the
 * client-side editor can render predictable inline-validation
 * feedback. See DESIGN_SPEC.md §Features 7, "Field-length caps".
 */
export const MAX_RULE_MATCH_VALUE_LENGTH = 200;
