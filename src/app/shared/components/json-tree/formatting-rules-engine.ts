/**
 * Formatting-rules engine - M6a.75 contract stub.
 *
 * This file establishes the public shape of the rule-evaluation engine
 * agreed to in M6a.5 / DESIGN_SPEC.md §Features 7. The full implementation
 * (within-set merge, cross-set merge, memoization) lands in M6f. Until
 * then `evaluateFormattingRules` is a no-op that returns
 * `EMPTY_RULE_RESULT` so the tree component, profile preview, and tests
 * can wire to a stable interface without depending on feature code that
 * does not yet exist.
 *
 * The split between `rowStyle`, `keyStyle`, and `valueStyle` is what
 * makes the `target: 'key' | 'value' | 'key_and_value'` config
 * meaningful at render time: a rule whose `target` is `key` projects
 * onto `keyStyle` only, while `backgroundColor` and `borderColor`
 * always project onto `rowStyle` regardless of target (the row paints
 * the background; the inline tokens paint the foreground).
 */

import type {
  FormattingIcon,
  FormattingRule,
  FormattingRuleSet
} from '../../../core/api/models';

/**
 * Per-target inline style projection. Mirrors `FormattingStyle` minus
 * the row-level fields (`backgroundColor`, `borderColor`) which always
 * land on `rowStyle`.
 */
export interface RuleStyleProjection {
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  icon?: FormattingIcon;
}

/**
 * Row-level style. Renders against the tree row container, not the
 * inline key/value tokens.
 */
export interface RuleRowStyle {
  backgroundColor?: string;
  borderColor?: string;
}

/**
 * Reference to a single rule that contributed to a node's final style,
 * surfaced in tooltips and the editor's matched-rule list. `label` is
 * the auto-generated, human-readable description from `describeRule`.
 */
export interface MatchedRuleRef {
  setId: string;
  ruleId: string;
  label: string;
}

/**
 * Output of evaluating the active rule sets against a single tree node.
 */
export interface RuleEngineResult {
  rowStyle: RuleRowStyle;
  keyStyle: RuleStyleProjection;
  valueStyle: RuleStyleProjection;
  matchedRules: readonly MatchedRuleRef[];
}

/**
 * Single tree node, normalized for the engine. `valueText` is the
 * **rendered** text the user sees in the tree (so a JSON number `200`
 * arrives here as `'200'`); per F8 in M6a.5 this is what rules match
 * against. Container nodes pass `valueText: null` so value-target
 * rules skip them.
 */
export interface RuleEngineNode {
  /** The node's key, or null for the root and array elements. */
  key: string | null;
  /** Rendered value text, or null when the node is a container. */
  valueText: string | null;
  /** True when the node is `{}` or `[]` (excluded from value-target rules). */
  isContainer: boolean;
}

/**
 * Frozen empty result. Returned by the M6a.75 stub and reused by
 * downstream callers as a "no formatting" sentinel so we don't
 * allocate per-row.
 */
export const EMPTY_RULE_RESULT: RuleEngineResult = Object.freeze({
  rowStyle: Object.freeze({}) as RuleRowStyle,
  keyStyle: Object.freeze({}) as RuleStyleProjection,
  valueStyle: Object.freeze({}) as RuleStyleProjection,
  matchedRules: Object.freeze([]) as readonly MatchedRuleRef[]
}) as RuleEngineResult;

/**
 * Evaluate the active rule sets against a single tree node.
 *
 * **M6a.75 stub:** always returns `EMPTY_RULE_RESULT`. The real
 * implementation lands in M6f and will:
 *   - iterate `activeSets` in array order (caller passes them in
 *     `createdAt` order per F2),
 *   - within each set iterate rules in array order,
 *   - skip rules whose target excludes the node's role (key vs value),
 *   - skip value-target rules on container nodes,
 *   - merge later matches over earlier ones for conflicting per-target
 *     properties, and
 *   - return the accumulated result with `matchedRules` listing every
 *     contributing rule for tooltip rendering.
 */
export function evaluateFormattingRules(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  activeSets: readonly FormattingRuleSet[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  node: RuleEngineNode
): RuleEngineResult {
  return EMPTY_RULE_RESULT;
}

/**
 * Auto-generate a human-readable label for a rule from its match
 * config. Surfaced in hover tooltips and the editor's matched-rule
 * list. Per F1 in M6a.5, rules have no user-edited `name` field;
 * this label is the canonical display string.
 *
 * Examples:
 *   `key contains "error"`
 *   `value exact "200"`
 *   `key or value starts_with "x_"` (case-sensitive)
 *
 * The match-type token is rendered as the literal enum value
 * (`exact`, `contains`, `starts_with`, `ends_with`) for v1 - we
 * deliberately do not localize it because the same enum tokens
 * appear in URL query params and in the rule editor's match-type
 * dropdown, and keeping them stable across surfaces makes
 * cross-referencing easier. Translatable surfacing of the label is a
 * post-v1 follow-up.
 */
export function describeRule(rule: FormattingRule): string {
  const target =
    rule.target === 'key'
      ? 'key'
      : rule.target === 'value'
        ? 'value'
        : 'key or value';
  const quoted = JSON.stringify(rule.matchValue ?? '');
  const sensitivity = rule.caseSensitive ? ' (case-sensitive)' : '';
  return `${target} ${rule.matchType} ${quoted}${sensitivity}`;
}
