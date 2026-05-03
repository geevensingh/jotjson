/**
 * Built-in formatting-rule-set presets.
 *
 * Presets are server-side constants - NOT stored in Cosmos. They are
 * exposed via `GET /api/rule-set-presets` and copied (with a fresh
 * UUID + the caller's `userId`) into the `rule-sets` container by
 * `POST /api/rule-set-presets/:id/clone`.
 *
 * IDs are stable kebab-case slugs (per DESIGN_SPEC.md §Features 7
 * "Built-in Presets") so the clone URLs are human-readable and
 * survive rebuilds. User-created rule sets always get UUIDs.
 *
 * Every preset rule passes `assertRule` (validated at module load
 * by the test suite) - that's the contract that lets the clone
 * handler run them through `createRuleSet` without re-validation.
 *
 * Regex match-type is deferred to v1.1, so presets that conceptually
 * want a regex (e.g. all 2xx status codes) are decomposed into
 * individual `exact`/`contains` rules. This is documented in the
 * spec as a v1 trade-off.
 */
import type { FormattingRule, UpdateRuleSetPayload } from './ruleSets';

export interface RuleSetPreset {
  /** Stable kebab-case slug; clone URL identifier. */
  id: string;
  /** Human-readable name used as the cloned set's `name`. */
  name: string;
  /** Embedded rules; each has its own stable kebab-case rule id. */
  rules: FormattingRule[];
}

// -------- Style palette --------
//
// Hex colors are lowercase on disk (matches the validator's
// `normalizeHex` output) so a clone of a preset is byte-identical
// to a user-created rule with the same color picked from the UI.

const STYLE_RED_BG = { backgroundColor: '#ffcdd2' };
const STYLE_GREEN_BG = { backgroundColor: '#c8e6c9' };
const STYLE_AMBER_BG = { backgroundColor: '#ffe0b2' };
const STYLE_YELLOW_BG = { backgroundColor: '#fff59d' };

// Convenience composite styles. These reuse `STYLE_RED_BG`'s
// `backgroundColor` and add the corresponding default icon, so a
// preset rule that wants a red row with an error icon can write
// `style: STYLE_RED_BG_WITH_ERROR_ICON` instead of repeating the
// shape inline. Defined here (alongside the other shared color
// styles) so future preset additions stay one-liners.
const STYLE_RED_BG_WITH_ERROR_ICON = { ...STYLE_RED_BG, icon: 'error' as const };
const STYLE_RED_BG_WITH_WARNING_ICON = { ...STYLE_RED_BG, icon: 'warning' as const };

// -------- Preset definitions --------

/**
 * Error Detection - flags keys (and most values) that name an
 * error / failure concept with a red background and the `error`
 * icon (so each match also surfaces as a beacon).
 *
 * Spec lists "error, err, exception, fault" as the target keywords;
 * v1.1 adds "failure" and "failed" because they're equally common
 * in real JSON and the bare term "Error Detection" reads as
 * inclusive. Most terms land as their own `contains` rule (instead
 * of a single regex) because the regex match type is deferred to
 * v1.1, and `contains` catches embedded forms like `errorMessage`,
 * `lastError`, `TypeError`, `ParseError`.
 *
 * Two terms use a tighter match-type than `contains` because the
 * literal substring is too noisy to scan arbitrary text with:
 * - `err` is keys-only (`target: 'key'`) and uses `matchType: 'exact'`
 *   because case-insensitive contains-match for "err" hits "merry",
 *   "berry", "where", "every", and case-insensitive contains-match
 *   in keys also fires on `lastError` / `TypeError` (already covered
 *   by the `error` rule). Exact-match keeps the rule meaningful for
 *   the bare key `err` without piling onto rows the other rules
 *   already flag.
 * - `fault` uses `matchType: 'starts_with'` because the substring
 *   "fault" embeds in the very common word "default", which is
 *   pervasive in configuration and code-generated JSON. Starts-with
 *   keeps `fault`, `faultCount`, `FaultDetail` matching while
 *   skipping `default`, `defaultValue`, etc.
 *
 * The other terms use `target: 'key_and_value'` so a value like
 * "TypeError" or "ParseError" gets highlighted on its own.
 */
const ERROR_DETECTION: RuleSetPreset = {
  id: 'error-detection',
  name: 'Error Detection',
  rules: [
    {
      id: 'error',
      target: 'key_and_value',
      matchType: 'contains',
      matchValue: 'error',
      caseSensitive: false,
      style: STYLE_RED_BG_WITH_ERROR_ICON,
    },
    {
      id: 'err',
      target: 'key',
      matchType: 'exact',
      matchValue: 'err',
      caseSensitive: false,
      style: STYLE_RED_BG_WITH_ERROR_ICON,
    },
    {
      id: 'exception',
      target: 'key_and_value',
      matchType: 'contains',
      matchValue: 'exception',
      caseSensitive: false,
      style: STYLE_RED_BG_WITH_ERROR_ICON,
    },
    {
      id: 'fault',
      target: 'key_and_value',
      matchType: 'starts_with',
      matchValue: 'fault',
      caseSensitive: false,
      style: STYLE_RED_BG_WITH_ERROR_ICON,
    },
    {
      id: 'failure',
      target: 'key_and_value',
      matchType: 'contains',
      matchValue: 'failure',
      caseSensitive: false,
      style: STYLE_RED_BG_WITH_ERROR_ICON,
    },
    {
      id: 'failed',
      target: 'key_and_value',
      matchType: 'contains',
      matchValue: 'failed',
      caseSensitive: false,
      style: STYLE_RED_BG_WITH_ERROR_ICON,
    },
  ],
};

/**
 * Status Codes - color-codes a fixed list of common HTTP response
 * codes by class via `exact` value matches (per the spec list at
 * §Features 7).
 *
 * One rule per code is intentional: when regex lands in v1.1 these
 * collapse into three rules (`^2\d{2}$`, `^4\d{2}$`, `^5\d{2}$`),
 * but in v1 the explicit list is more honest about what's actually
 * highlighted. Rule IDs use the `code-NNN` form so cloned sets
 * read sensibly in the editor.
 */
const STATUS_CODES_2XX = ['200', '201', '204'];
const STATUS_CODES_4XX = ['400', '401', '403', '404'];
const STATUS_CODES_5XX = ['500', '502', '503'];

function statusRule(code: string, bg: { backgroundColor: string }): FormattingRule {
  return {
    id: `code-${code}`,
    target: 'value',
    matchType: 'exact',
    matchValue: code,
    caseSensitive: false,
    style: bg,
  };
}

const STATUS_CODES: RuleSetPreset = {
  id: 'status-codes',
  name: 'Status Codes',
  rules: [
    ...STATUS_CODES_2XX.map((c) => statusRule(c, STYLE_GREEN_BG)),
    ...STATUS_CODES_4XX.map((c) => statusRule(c, STYLE_AMBER_BG)),
    ...STATUS_CODES_5XX.map((c) => statusRule(c, STYLE_RED_BG)),
  ],
};

/**
 * Null Finder - highlights the literal value `null` with a yellow
 * background. The engine compares the rendered text of a node, so
 * `exact` against `'null'` lights up every JSON null without
 * accidentally catching the string `"null"` (string nodes render
 * with quotes; null nodes render bare).
 */
const NULL_FINDER: RuleSetPreset = {
  id: 'null-finder',
  name: 'Null Finder',
  rules: [
    {
      id: 'null-value',
      target: 'value',
      matchType: 'exact',
      matchValue: 'null',
      caseSensitive: true,
      style: STYLE_YELLOW_BG,
    },
  ],
};

/**
 * Status Highlights - color-codes outcome and lifecycle vocabulary
 * with green (positive) and amber (warning / in-progress)
 * backgrounds.
 *
 * Most terms are `contains` so they catch shapes like "successCount",
 * "wasSuccessful", "loginPassed", "warningLevel", "pendingItems",
 * etc. The bare tokens `ok` and `warn` need `exact` matches because
 * `contains` would hit innocuous English (took, look, broken,
 * Warner, warned). `exact` + case-insensitive still catches the
 * very common shapes `{"status":"OK"}` and `{"level":"warn"}`,
 * which was the whole point of including them.
 *
 * Every rule uses `target: 'key_and_value'`: most outcome shapes
 * appear as values (`{"status":"success"}`) but key-side matches
 * (`{"successCount": 42}`, `{"warning": "..."}`) are equally
 * worth flagging.
 */
const STATUS_HIGHLIGHTS: RuleSetPreset = {
  id: 'status-highlights',
  name: 'Status Highlights',
  rules: [
    // Green - positive outcomes
    {
      id: 'success',
      target: 'key_and_value',
      matchType: 'contains',
      matchValue: 'success',
      caseSensitive: false,
      style: STYLE_GREEN_BG,
    },
    {
      id: 'succeeded',
      target: 'key_and_value',
      matchType: 'contains',
      matchValue: 'succeeded',
      caseSensitive: false,
      style: STYLE_GREEN_BG,
    },
    {
      id: 'passed',
      target: 'key_and_value',
      matchType: 'contains',
      matchValue: 'passed',
      caseSensitive: false,
      style: STYLE_GREEN_BG,
    },
    {
      id: 'ok',
      target: 'key_and_value',
      matchType: 'exact',
      matchValue: 'ok',
      caseSensitive: false,
      style: STYLE_GREEN_BG,
    },
    // Amber - warnings / in-progress
    {
      id: 'warning',
      target: 'key_and_value',
      matchType: 'contains',
      matchValue: 'warning',
      caseSensitive: false,
      style: STYLE_AMBER_BG,
    },
    {
      id: 'warn',
      target: 'key_and_value',
      matchType: 'exact',
      matchValue: 'warn',
      caseSensitive: false,
      style: STYLE_AMBER_BG,
    },
    {
      id: 'pending',
      target: 'key_and_value',
      matchType: 'contains',
      matchValue: 'pending',
      caseSensitive: false,
      style: STYLE_AMBER_BG,
    },
    {
      id: 'retry',
      target: 'key_and_value',
      matchType: 'contains',
      matchValue: 'retry',
      caseSensitive: false,
      style: STYLE_AMBER_BG,
    },
  ],
};

/**
 * Test Header Content - highlights `test-header`, `testHeader`, and
 * `test_header` pairs based on whether the value carries content, so
 * test header fields with payload stand out red (with the `warning`
 * icon, since a populated test-header is usually noteworthy in
 * production-side data) and missing / empty payloads show as green
 * (no icon).
 *
 * The `has_content` and `lacks_content` predicates are complementary:
 * for any matched key, exactly one rule fires, keeping the matched-rule
 * tooltip clean. This preset paints row backgrounds, so it can collide
 * with other row-bg presets such as `null-finder`; cross-set precedence
 * then depends on rule-set `createdAt` order. Note that `"   "` matches
 * `has_content` (red), because the engine's `is_empty` check is strict-
 * literal-empty.
 */
const TEST_HEADER_CONTENT: RuleSetPreset = {
  id: 'test-header-content',
  name: 'Test Header Content',
  rules: [
    {
      id: 'kebab-has',
      kind: 'pair',
      keyMatch: {
        matchType: 'exact',
        matchValue: 'test-header',
        caseSensitive: false,
      },
      valueMatch: { kind: 'predicate', predicate: 'has_content' },
      style: STYLE_RED_BG_WITH_WARNING_ICON,
    },
    {
      id: 'kebab-lacks',
      kind: 'pair',
      keyMatch: {
        matchType: 'exact',
        matchValue: 'test-header',
        caseSensitive: false,
      },
      valueMatch: { kind: 'predicate', predicate: 'lacks_content' },
      style: STYLE_GREEN_BG,
    },
    {
      id: 'camel-has',
      kind: 'pair',
      keyMatch: {
        matchType: 'exact',
        matchValue: 'testHeader',
        caseSensitive: false,
      },
      valueMatch: { kind: 'predicate', predicate: 'has_content' },
      style: STYLE_RED_BG_WITH_WARNING_ICON,
    },
    {
      id: 'camel-lacks',
      kind: 'pair',
      keyMatch: {
        matchType: 'exact',
        matchValue: 'testHeader',
        caseSensitive: false,
      },
      valueMatch: { kind: 'predicate', predicate: 'lacks_content' },
      style: STYLE_GREEN_BG,
    },
    {
      id: 'snake-has',
      kind: 'pair',
      keyMatch: {
        matchType: 'exact',
        matchValue: 'test_header',
        caseSensitive: false,
      },
      valueMatch: { kind: 'predicate', predicate: 'has_content' },
      style: STYLE_RED_BG_WITH_WARNING_ICON,
    },
    {
      id: 'snake-lacks',
      kind: 'pair',
      keyMatch: {
        matchType: 'exact',
        matchValue: 'test_header',
        caseSensitive: false,
      },
      valueMatch: { kind: 'predicate', predicate: 'lacks_content' },
      style: STYLE_GREEN_BG,
    },
  ],
};

/**
 * Ordered list of presets returned by `GET /api/rule-set-presets`.
 * Order is stable so the UI's "Clone preset" menu doesn't shuffle
 * between requests.
 */
export const PRESET_RULE_SETS: readonly RuleSetPreset[] = [
  ERROR_DETECTION,
  STATUS_CODES,
  NULL_FINDER,
  STATUS_HIGHLIGHTS,
  TEST_HEADER_CONTENT,
] as const;

const PRESET_BY_ID: ReadonlyMap<string, RuleSetPreset> = new Map(
  PRESET_RULE_SETS.map((preset) => [preset.id, preset]),
);

export function listPresets(): readonly RuleSetPreset[] {
  return PRESET_RULE_SETS;
}

export function findPreset(id: string): RuleSetPreset | undefined {
  return PRESET_BY_ID.get(id);
}

/**
 * Adapt a preset into the payload shape consumed by `createRuleSet`.
 * Returns a deep clone so the caller can't mutate the shared preset
 * constants. The caller is responsible for the limit checks; this
 * function performs no validation.
 */
export function presetToCreatePayload(preset: RuleSetPreset): UpdateRuleSetPayload {
  return {
    name: preset.name,
    rules: preset.rules.map((rule) => ({
      ...rule,
      style: { ...rule.style },
    })),
  };
}
