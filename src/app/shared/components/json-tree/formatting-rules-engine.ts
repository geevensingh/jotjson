/**
 * Formatting-rules engine.
 *
 * This file evaluates active formatting rule sets against one normalized
 * tree node at a time. It implements simple legacy text rules and pair
 * rules with text or predicate value matches. The tree component owns
 * per-node memoization; this module stays pure and side-effect free.
 *
 * The split between `rowStyle`, `keyStyle`, and `valueStyle` is what
 * makes the `target: 'key' | 'value' | 'key_and_value'` config
 * meaningful at render time: a rule whose `target` is `key` projects
 * onto `keyStyle` only, while `backgroundColor` and `borderColor`
 * always project onto `rowStyle` regardless of target (the row paints
 * the background; the inline tokens paint the foreground).
 *
 * Non-participation: JSONC comments (M7k) are not a match target. Rules
 * see only keys and values; the comment-bundle map is rendered by the
 * tree as decoration and never reaches this engine.
 */

import type {
  FormattingIcon,
  FormattingRule,
  FormattingRuleMatchType,
  FormattingRulePair,
  FormattingRuleSet,
  FormattingRuleSimple,
  FormattingStyle,
  KeyMatch,
  ValueKind,
  ValueMatch,
  ValuePredicate,
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
 * **`valueKind` / `isEmpty` contract:** pair-rule predicates use the
 * deterministic formatting classifier, not preference-sensitive search
 * classification. `valueKind` is one of the seven JSON formatting kinds
 * for classified nodes, or `null` when the row is a container aggregate
 * without a classified value or the producer cannot classify. Container
 * object/array rows that should participate in predicates pass
 * `valueKind: 'object' | 'array'` and set `isEmpty` to whether the
 * container has zero own entries. For non-empty-sensitive kinds, pass
 * `isEmpty: false`.
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
  /** True when the node is `{}` or `[]` (excluded from simple value-target text rules). */
  isContainer: boolean;
  /** Deterministic value kind for pair predicates, or null when unclassified. */
  valueKind: ValueKind | null;
  /** True only for empty strings, arrays, and objects as classified by the producer. */
  isEmpty: boolean;
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
  matchedRules: Object.freeze([]) as readonly MatchedRuleRef[],
}) as RuleEngineResult;

/**
 * Allowed `target` values. A rule whose `target` is not one of these
 * is structurally invalid (see DESIGN_SPEC.md §Features 7 line 539-540)
 * and silently skipped at evaluation time.
 */
const VALID_TARGETS: ReadonlySet<FormattingRuleSimple['target']> = new Set([
  'key',
  'value',
  'key_and_value',
]);

/**
 * Allowed `matchType` values. Rules with any other matchType are
 * silently skipped (defends against future enum additions reaching
 * older clients, and the spec-mandated "skip structurally invalid
 * rules" rule). Note: `regex` is intentionally absent - deferred to
 * v1.1 per the spec.
 */
const VALID_MATCH_TYPES: ReadonlySet<FormattingRuleMatchType> = new Set([
  'exact',
  'contains',
  'starts_with',
  'ends_with',
]);

/**
 * Test a single string against a rule's match config. Pulled out of
 * the main evaluation loop for testability and so we can fold
 * case-insensitive normalization into one place.
 */
function matchString(
  candidate: string,
  matchType: FormattingRuleMatchType,
  matchValue: string,
  caseSensitive: boolean,
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

type TextMatchConfig = KeyMatch | Extract<ValueMatch, { kind: 'text' }>;

function isValidMatchType(matchType: unknown): matchType is FormattingRuleMatchType {
  return (
    matchType === 'exact' ||
    matchType === 'contains' ||
    matchType === 'starts_with' ||
    matchType === 'ends_with'
  );
}

function isValidTextMatchConfig(match: unknown): match is TextMatchConfig {
  if (match === null || typeof match !== 'object') return false;
  if (!('matchType' in match) || !('matchValue' in match) || !('caseSensitive' in match)) {
    return false;
  }
  const { matchType, matchValue, caseSensitive } = match;
  return (
    isValidMatchType(matchType) &&
    typeof matchValue === 'string' &&
    matchValue.length > 0 &&
    typeof caseSensitive === 'boolean'
  );
}

function isValidPredicate(predicate: unknown): predicate is ValuePredicate {
  switch (predicate) {
    case 'is_null':
    case 'is_not_null':
    case 'is_empty':
    case 'is_not_empty':
    case 'is_string':
    case 'is_not_string':
    case 'is_number':
    case 'is_not_number':
    case 'is_integer':
    case 'is_not_integer':
    case 'is_boolean':
    case 'is_not_boolean':
    case 'is_object':
    case 'is_not_object':
    case 'is_array':
    case 'is_not_array':
      return true;
    default:
      return false;
  }
}

function isValidValueMatch(match: unknown): match is ValueMatch {
  if (match === null || typeof match !== 'object') return false;
  if (!('kind' in match)) return false;
  const { kind } = match;
  if (kind === 'text') return isValidTextMatchConfig(match);
  if (kind !== 'predicate' || !('predicate' in match)) return false;
  return isValidPredicate(match.predicate);
}

function evaluatePredicate(predicate: ValuePredicate, node: RuleEngineNode): boolean {
  switch (predicate) {
    case 'is_null':
      return node.valueKind === 'null';
    case 'is_not_null':
      return !evaluatePredicate('is_null', node);
    case 'is_empty':
      return (
        (node.valueKind === 'string' && node.valueText === '') ||
        (node.valueKind === 'array' && node.isEmpty) ||
        (node.valueKind === 'object' && node.isEmpty)
      );
    case 'is_not_empty':
      return !evaluatePredicate('is_empty', node);
    case 'is_string':
      return node.valueKind === 'string';
    case 'is_not_string':
      return !evaluatePredicate('is_string', node);
    case 'is_number':
      return node.valueKind === 'number';
    case 'is_not_number':
      return !evaluatePredicate('is_number', node);
    case 'is_integer':
      return node.valueKind === 'integer';
    case 'is_not_integer':
      return !evaluatePredicate('is_integer', node);
    case 'is_boolean':
      return node.valueKind === 'boolean';
    case 'is_not_boolean':
      return !evaluatePredicate('is_boolean', node);
    case 'is_object':
      return node.valueKind === 'object';
    case 'is_not_object':
      return !evaluatePredicate('is_object', node);
    case 'is_array':
      return node.valueKind === 'array';
    case 'is_not_array':
      return !evaluatePredicate('is_array', node);
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
function projectInlineStyle(target: RuleStyleProjection, style: FormattingStyle): void {
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

function isSimpleRuleKind(rule: FormattingRule): rule is FormattingRuleSimple {
  return (rule.kind ?? 'simple') === 'simple';
}

function isPairRuleKind(rule: FormattingRule): rule is FormattingRulePair {
  return rule.kind === 'pair';
}

function pairValueMatches(match: ValueMatch, node: RuleEngineNode): boolean {
  if (match.kind === 'text') {
    return (
      node.valueText !== null &&
      matchString(node.valueText, match.matchType, match.matchValue, match.caseSensitive)
    );
  }
  return evaluatePredicate(match.predicate, node);
}

function pairRuleMatches(rule: FormattingRulePair, node: RuleEngineNode): boolean {
  if (!isValidTextMatchConfig(rule.keyMatch)) return false;
  if (!isValidValueMatch(rule.valueMatch)) return false;
  if (node.key === null) return false;
  if (
    !matchString(
      node.key,
      rule.keyMatch.matchType,
      rule.keyMatch.matchValue,
      rule.keyMatch.caseSensitive,
    )
  ) {
    return false;
  }
  return pairValueMatches(rule.valueMatch, node);
}

/**
 * Evaluate the active rule sets against a single tree node and
 * return the merged formatting projection.
 *
 * Algorithm (matches DESIGN_SPEC.md §Features 7 line 855-880 and
 * F1/F8 in M6a.5):
 *
 * 1. Iterate `activeSets` in array order. The caller orders them by
 *    `createdAt ASC` per F2 - that's the documented precedence sort
 *    and we trust it here rather than re-sorting per-node.
 * 2. Within each set, iterate `rules` in array order.
 * 3. Read `rule.kind ?? 'simple'`. Unknown kinds and structurally
 *    invalid match configs are skipped without throwing.
 * 4. Simple rules keep legacy projection:
 *      - `target=key` -> key side only.
 *      - `target=value` -> value side only, skipped on containers.
 *      - `target=key_and_value` -> OR-on-fields; style only the side
 *        that matched, or both sides when both matched.
 * 5. Pair rules require key and value to match the same node. On a
 *    match, inline style projects to both `keyStyle` and `valueStyle`.
 * 6. Row-level (`backgroundColor`, `borderColor`) always projects onto
 *    `rowStyle` for every matched rule kind.
 * 7. Append a single `MatchedRuleRef` per matched rule.
 * 8. Properties merge by overwrite-when-defined: later rules clobber
 *    earlier ones for any property they explicitly set, including
 *    `false`. Properties they leave undefined are preserved.
 * 9. If no rules matched any node, return the shared frozen
 *    `EMPTY_RULE_RESULT` sentinel by identity so downstream
 *    consumers can short-circuit cheaply.
 */
export function evaluateFormattingRules(
  activeSets: readonly FormattingRuleSet[],
  node: RuleEngineNode,
): RuleEngineResult {
  const rowStyle: RuleRowStyle = {};
  const keyStyle: RuleStyleProjection = {};
  const valueStyle: RuleStyleProjection = {};
  const matchedRules: MatchedRuleRef[] = [];

  for (const set of activeSets) {
    for (const rule of set.rules) {
      const ruleKind = rule.kind ?? 'simple';

      if (ruleKind === 'simple') {
        if (!isSimpleRuleKind(rule)) continue;
        if (!VALID_TARGETS.has(rule.target)) continue;
        if (!VALID_MATCH_TYPES.has(rule.matchType)) continue;
        if (typeof rule.matchValue !== 'string' || rule.matchValue.length === 0) continue;
        if (typeof rule.caseSensitive !== 'boolean') continue;

        // Determine which sides this rule can match against, given the
        // node's role and the rule's target. Containers exclude the
        // value side regardless of target.
        const tryKey =
          (rule.target === 'key' || rule.target === 'key_and_value') && node.key !== null;
        const tryValue =
          (rule.target === 'value' || rule.target === 'key_and_value') &&
          !node.isContainer &&
          node.valueText !== null;

        if (!tryKey && !tryValue) continue;

        const keyMatched =
          tryKey && node.key !== null
            ? matchString(node.key, rule.matchType, rule.matchValue, rule.caseSensitive)
            : false;
        const valueMatched =
          tryValue && node.valueText !== null
            ? matchString(node.valueText, rule.matchType, rule.matchValue, rule.caseSensitive)
            : false;

        if (!keyMatched && !valueMatched) continue;

        projectRowStyle(rowStyle, rule.style);
        if (keyMatched) projectInlineStyle(keyStyle, rule.style);
        if (valueMatched) projectInlineStyle(valueStyle, rule.style);

        matchedRules.push({
          setId: set.id,
          ruleId: rule.id,
          label: describeRule(rule),
        });
        continue;
      }

      if (ruleKind !== 'pair' || !isPairRuleKind(rule)) continue;
      if (!pairRuleMatches(rule, node)) continue;

      projectRowStyle(rowStyle, rule.style);
      projectInlineStyle(keyStyle, rule.style);
      projectInlineStyle(valueStyle, rule.style);

      matchedRules.push({
        setId: set.id,
        ruleId: rule.id,
        label: describeRule(rule),
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
function describeTextMatch(label: 'key' | 'value', match: TextMatchConfig): string {
  const quoted = JSON.stringify(match.matchValue ?? '');
  const sensitivity = match.caseSensitive ? ' (case-sensitive)' : '';
  return `${label} ${match.matchType} ${quoted}${sensitivity}`;
}

function describeValueMatch(match: ValueMatch): string {
  if (match.kind === 'text') return describeTextMatch('value', match);
  return `value ${match.predicate}`;
}

export function describeRule(rule: FormattingRule): string {
  if (rule.kind === 'pair') {
    return `${describeTextMatch('key', rule.keyMatch)} AND ${describeValueMatch(rule.valueMatch)}`;
  }

  const target = rule.target === 'key' ? 'key' : rule.target === 'value' ? 'value' : 'key or value';
  const quoted = JSON.stringify(rule.matchValue ?? '');
  const sensitivity = rule.caseSensitive ? ' (case-sensitive)' : '';
  return `${target} ${rule.matchType} ${quoted}${sensitivity}`;
}
