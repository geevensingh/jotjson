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
  FormattingRuleSet,
  FormattingStyle
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
 * Single tree node, normalized for the engine.
 *
 * **`valueText` contract (F8 in M6a.5):** the **unquoted, normalized
 * display text** for the node's value. Rules compare against this
 * string with no further processing, so the producer is responsible
 * for stripping JSON-syntax noise:
 *   - strings: the raw string contents - **no surrounding quotes,
 *     no JSON-escape sequences re-encoded**. The string `"200"` and
 *     the number `200` both arrive here as `'200'` so a single
 *     `value exact "200"` rule matches both (this is the F8
 *     guarantee).
 *   - numbers / booleans: the rendered form (`'200'`, `'true'`).
 *   - null: the literal `'null'`.
 *   - containers (`{}`, `[]`): `null`, plus `isContainer: true`.
 *
 * Distinct from the tree component's existing `renderLeaf`, which
 * returns quoted JSON for strings to drive search. Search and
 * formatting have different match contracts; the producer must
 * not reuse `renderLeaf` for engine input.
 */
export interface RuleEngineNode {
  /** The node's key, or null for the root and array elements. */
  key: string | null;
  /** Unquoted display text per the contract above; null for containers. */
  valueText: string | null;
  /** True when the node is `{}` or `[]` (excluded from value-target rules). */
  isContainer: boolean;
}

/**
 * Frozen "no formatting" sentinel. Returned by `evaluateFormattingRules`
 * whenever zero rules match a node, so downstream consumers can
 * short-circuit on identity (`result === EMPTY_RULE_RESULT`) without
 * allocating per-row.
 */
export const EMPTY_RULE_RESULT: RuleEngineResult = Object.freeze({
  rowStyle: Object.freeze({}) as RuleRowStyle,
  keyStyle: Object.freeze({}) as RuleStyleProjection,
  valueStyle: Object.freeze({}) as RuleStyleProjection,
  matchedRules: Object.freeze([]) as readonly MatchedRuleRef[]
}) as RuleEngineResult;

/**
 * Allowed `target` values. A rule whose `target` is not one of these
 * is structurally invalid (see DESIGN_SPEC.md §Features 7 line 539-540)
 * and silently skipped at evaluation time.
 */
const VALID_TARGETS: ReadonlySet<FormattingRule['target']> = new Set([
  'key',
  'value',
  'key_and_value'
]);

/**
 * Allowed `matchType` values. Rules with any other matchType are
 * silently skipped (defends against future enum additions reaching
 * older clients, and the spec-mandated "skip structurally invalid
 * rules" rule). Note: `regex` is intentionally absent - deferred to
 * v1.1 per the spec.
 */
const VALID_MATCH_TYPES: ReadonlySet<FormattingRule['matchType']> = new Set([
  'exact',
  'contains',
  'starts_with',
  'ends_with'
]);

/**
 * Test a single string against a rule's match config. Pulled out of
 * the main evaluation loop for testability and so we can fold
 * case-insensitive normalization into one place.
 */
function matchString(
  candidate: string,
  matchType: FormattingRule['matchType'],
  matchValue: string,
  caseSensitive: boolean
): boolean {
  // Case-insensitive matching folds both sides to lowercase. We pay
  // two `.toLowerCase()` calls per match attempt - acceptable because
  // matchValue could be normalized once at validation time in a
  // future optimization, and node keys/values are short by JSON
  // standards. Per-attempt allocation is the only realistic
  // alternative and isn't measurably faster for v1 scales.
  const lhs = caseSensitive ? candidate : candidate.toLowerCase();
  const rhs = caseSensitive ? matchValue : matchValue.toLowerCase();
  switch (matchType) {
    case 'exact':
      return lhs === rhs;
    case 'contains':
      return lhs.includes(rhs);
    case 'starts_with':
      return lhs.startsWith(rhs);
    case 'ends_with':
      return lhs.endsWith(rhs);
    default:
      return false;
  }
}

/**
 * Project a rule's `style` onto a `RuleStyleProjection` (the
 * per-target inline style). Mutates `target` in place. Skips
 * properties whose value is `undefined` so a rule that doesn't
 * specify (e.g.) `bold` can't erase a previously-set `bold`. Each
 * defined property overwrites the existing value - that includes
 * explicit `false` deliberately clobbering an earlier `true` (the
 * documented expected behaviour, plan.md M6f spec tests).
 */
function projectInlineStyle(
  target: RuleStyleProjection,
  style: FormattingStyle
): void {
  if (style.textColor !== undefined) target.color = style.textColor;
  if (style.bold !== undefined) target.bold = style.bold;
  if (style.italic !== undefined) target.italic = style.italic;
  if (style.underline !== undefined) target.underline = style.underline;
  if (style.icon !== undefined) target.icon = style.icon;
}

/**
 * Project a rule's row-level style (`backgroundColor` / `borderColor`)
 * onto a `RuleRowStyle`. These properties always paint the row,
 * regardless of `target`. Same overwrite-on-defined semantics as
 * `projectInlineStyle`.
 */
function projectRowStyle(target: RuleRowStyle, style: FormattingStyle): void {
  if (style.backgroundColor !== undefined) target.backgroundColor = style.backgroundColor;
  if (style.borderColor !== undefined) target.borderColor = style.borderColor;
}

/**
 * Evaluate the active rule sets against a single tree node and
 * return the merged formatting projection.
 *
 * Algorithm (matches DESIGN_SPEC.md §Features 7 line 524-540 and
 * F1/F8 in M6a.5):
 *
 * 1. Iterate `activeSets` in array order. The caller orders them by
 *    `createdAt ASC` per F2 - that's the documented precedence sort
 *    and we trust it here rather than re-sorting per-node.
 * 2. Within each set, iterate `rules` in array order.
 * 3. Skip structurally invalid rules (unknown target, unknown
 *    matchType, empty matchValue) per spec line 539-540.
 * 4. For each rule, decide whether the **key side** and **value
 *    side** independently match:
 *      - `target=key` -> only the key side is eligible
 *      - `target=value` -> only the value side is eligible (and
 *        skipped entirely on container nodes per F8)
 *      - `target=key_and_value` -> BOTH sides are eligible; either
 *        or both can match independently. On a container, only the
 *        key side is eligible.
 * 5. If at least one side matched, project the rule's style:
 *      - row-level (`backgroundColor`, `borderColor`) always projects
 *        onto `rowStyle`.
 *      - inline (`textColor`, `bold`, `italic`, `underline`, `icon`)
 *        projects onto `keyStyle` if the key side matched, and onto
 *        `valueStyle` if the value side matched. **A side that did
 *        not match is not styled** - this is the one big nuance for
 *        `target=key_and_value`.
 * 6. Append a single `MatchedRuleRef` per matched rule to
 *    `matchedRules`, regardless of how many sides matched.
 * 7. Properties merge by overwrite-when-defined: later rules clobber
 *    earlier ones for any property they explicitly set, including
 *    `false`. Properties they leave undefined are preserved.
 * 8. If no rules matched any node, return the shared frozen
 *    `EMPTY_RULE_RESULT` sentinel by identity so downstream
 *    consumers can short-circuit cheaply.
 */
export function evaluateFormattingRules(
  activeSets: readonly FormattingRuleSet[],
  node: RuleEngineNode
): RuleEngineResult {
  const rowStyle: RuleRowStyle = {};
  const keyStyle: RuleStyleProjection = {};
  const valueStyle: RuleStyleProjection = {};
  const matchedRules: MatchedRuleRef[] = [];

  for (const set of activeSets) {
    for (const rule of set.rules) {
      if (!VALID_TARGETS.has(rule.target)) continue;
      if (!VALID_MATCH_TYPES.has(rule.matchType)) continue;
      if (typeof rule.matchValue !== 'string' || rule.matchValue.length === 0) continue;

      // Determine which sides this rule can match against, given the
      // node's role and the rule's target. Containers exclude the
      // value side regardless of target.
      const tryKey =
        (rule.target === 'key' || rule.target === 'key_and_value') &&
        node.key !== null;
      const tryValue =
        (rule.target === 'value' || rule.target === 'key_and_value') &&
        !node.isContainer &&
        node.valueText !== null;

      if (!tryKey && !tryValue) continue;

      const keyMatched =
        tryKey &&
        matchString(node.key as string, rule.matchType, rule.matchValue, rule.caseSensitive);
      const valueMatched =
        tryValue &&
        matchString(
          node.valueText as string,
          rule.matchType,
          rule.matchValue,
          rule.caseSensitive
        );

      if (!keyMatched && !valueMatched) continue;

      projectRowStyle(rowStyle, rule.style);
      if (keyMatched) projectInlineStyle(keyStyle, rule.style);
      if (valueMatched) projectInlineStyle(valueStyle, rule.style);

      matchedRules.push({
        setId: set.id,
        ruleId: rule.id,
        label: describeRule(rule)
      });
    }
  }

  if (matchedRules.length === 0) return EMPTY_RULE_RESULT;
  return { rowStyle, keyStyle, valueStyle, matchedRules };
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
