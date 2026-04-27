/**
 * Built-in formatting-rule-set presets.
 *
 * Presets are server-side constants - NOT stored in Cosmos. They are
 * exposed via `GET /api/rule-sets/presets` and copied (with a fresh
 * UUID + the caller's `userId`) into the `rule-sets` container by
 * `POST /api/rule-sets/presets/:id/clone`.
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

// -------- Preset definitions --------

/**
 * Error Detection - flags keys that name an error / failure concept
 * with a red background.
 *
 * Spec lists "error, err, exception, fault" as the target keywords.
 * Each lands as its own `contains` rule (instead of a single
 * `error|err|exception|fault` regex) because the regex match type
 * is deferred to v1.1. `contains` is preferred over `exact` so the
 * preset matches `errors`, `errorMessage`, `lastError`, etc., which
 * is what users actually have in their JSON.
 */
const ERROR_DETECTION: RuleSetPreset = {
  id: 'error-detection',
  name: 'Error Detection',
  rules: [
    {
      id: 'error',
      target: 'key',
      matchType: 'contains',
      matchValue: 'error',
      caseSensitive: false,
      style: STYLE_RED_BG
    },
    {
      id: 'err',
      target: 'key',
      matchType: 'contains',
      matchValue: 'err',
      caseSensitive: false,
      style: STYLE_RED_BG
    },
    {
      id: 'exception',
      target: 'key',
      matchType: 'contains',
      matchValue: 'exception',
      caseSensitive: false,
      style: STYLE_RED_BG
    },
    {
      id: 'fault',
      target: 'key',
      matchType: 'contains',
      matchValue: 'fault',
      caseSensitive: false,
      style: STYLE_RED_BG
    }
  ]
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
    style: bg
  };
}

const STATUS_CODES: RuleSetPreset = {
  id: 'status-codes',
  name: 'Status Codes',
  rules: [
    ...STATUS_CODES_2XX.map((c) => statusRule(c, STYLE_GREEN_BG)),
    ...STATUS_CODES_4XX.map((c) => statusRule(c, STYLE_AMBER_BG)),
    ...STATUS_CODES_5XX.map((c) => statusRule(c, STYLE_RED_BG))
  ]
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
      style: STYLE_YELLOW_BG
    }
  ]
};

/**
 * Ordered list of presets returned by `GET /api/rule-sets/presets`.
 * Order is stable so the UI's "Clone preset" menu doesn't shuffle
 * between requests.
 */
export const PRESET_RULE_SETS: readonly RuleSetPreset[] = [
  ERROR_DETECTION,
  STATUS_CODES,
  NULL_FINDER
] as const;

const PRESET_BY_ID: ReadonlyMap<string, RuleSetPreset> = new Map(
  PRESET_RULE_SETS.map((preset) => [preset.id, preset])
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
      style: { ...rule.style }
    }))
  };
}
