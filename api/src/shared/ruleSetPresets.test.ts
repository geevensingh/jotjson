jest.mock('./cosmos', () => ({
  getCosmos: jest.fn(() => {
    throw new Error('cosmos must not be touched in preset-data tests');
  }),
}));

import { assertRule, assertRuleSetPayload } from './ruleSets';
import { PRESET_RULE_SETS, findPreset, listPresets, presetToCreatePayload } from './ruleSetPresets';

describe('built-in rule-set presets', () => {
  it('exposes the five spec presets in a stable order', () => {
    const ids = PRESET_RULE_SETS.map((preset) => preset.id);
    expect(ids).toEqual([
      'error-detection',
      'status-codes',
      'null-finder',
      'status-highlights',
      'test-header-content',
    ]);
  });

  it('uses kebab-case preset IDs (not UUIDs)', () => {
    for (const preset of PRESET_RULE_SETS) {
      expect(preset.id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('every preset rule passes assertRule', () => {
    for (const preset of PRESET_RULE_SETS) {
      preset.rules.forEach((rule, idx) => {
        // Throws if invalid; we additionally compare the structure
        // returned to confirm normalization is a no-op (presets are
        // already on-disk-canonical, so the assert should be an
        // identity transform).
        const normalized = assertRule(rule, `presets.${preset.id}[${idx}]`);
        expect(normalized).toEqual(rule);
      });
    }
  });

  it('every preset payload passes assertRuleSetPayload', () => {
    for (const preset of PRESET_RULE_SETS) {
      const payload = presetToCreatePayload(preset);
      expect(() => assertRuleSetPayload(payload)).not.toThrow();
    }
  });

  it('error-detection targets keys and values, mostly with contains', () => {
    const preset = findPreset('error-detection')!;
    expect(preset).toBeDefined();
    expect(preset.rules).toHaveLength(6);
    for (const rule of preset.rules) {
      expect(rule.caseSensitive).toBe(false);
      expect(rule.style.backgroundColor).toBe('#ffcdd2');
      expect(rule.style.icon).toBe('error');
    }
    const byId = new Map(preset.rules.map((r) => [r.id, r]));
    // `err` is keys-only and exact-match because case-insensitive
    // `contains 'err'` hits common English noise (`merry`, `where`,
    // `every`) and embedded-error keys (`lastError`) are already
    // covered by the `error` rule.
    expect(byId.get('err')?.target).toBe('key');
    expect(byId.get('err')?.matchType).toBe('exact');
    // `fault` uses `starts_with` because contains-match for "fault"
    // hits the very common word "default".
    expect(byId.get('fault')?.matchType).toBe('starts_with');
    // The remaining rules retain `contains` so they catch embedded
    // forms like `lastError`, `TypeError`, `failureCount`, `failedAt`.
    for (const id of ['error', 'exception', 'failure', 'failed']) {
      expect(byId.get(id)?.matchType).toBe('contains');
    }
    for (const id of ['error', 'exception', 'fault', 'failure', 'failed']) {
      expect(byId.get(id)?.target).toBe('key_and_value');
    }
    expect(preset.rules.map((r) => r.matchValue)).toEqual([
      'error',
      'err',
      'exception',
      'fault',
      'failure',
      'failed',
    ]);
  });

  it('status-codes ships individual exact rules colored by class', () => {
    const preset = findPreset('status-codes')!;
    expect(preset.rules).toHaveLength(10);
    const byCode = new Map(preset.rules.map((r) => [r.matchValue, r]));
    for (const code of ['200', '201', '204']) {
      expect(byCode.get(code)?.style.backgroundColor).toBe('#c8e6c9');
    }
    for (const code of ['400', '401', '403', '404']) {
      expect(byCode.get(code)?.style.backgroundColor).toBe('#ffe0b2');
    }
    for (const code of ['500', '502', '503']) {
      expect(byCode.get(code)?.style.backgroundColor).toBe('#ffcdd2');
    }
    for (const rule of preset.rules) {
      expect(rule.target).toBe('value');
      expect(rule.matchType).toBe('exact');
    }
  });

  it('null-finder matches the literal value "null" exactly', () => {
    const preset = findPreset('null-finder')!;
    expect(preset.rules).toHaveLength(1);
    const rule = preset.rules[0]!;
    expect(rule.target).toBe('value');
    expect(rule.matchType).toBe('exact');
    expect(rule.matchValue).toBe('null');
    expect(rule.caseSensitive).toBe(true);
    expect(rule.style.backgroundColor).toBe('#fff59d');
  });

  it('status-highlights ships green and amber rules for outcome vocab', () => {
    const preset = findPreset('status-highlights')!;
    expect(preset).toBeDefined();
    expect(preset.rules).toHaveLength(8);
    for (const rule of preset.rules) {
      expect(rule.target).toBe('key_and_value');
      expect(rule.caseSensitive).toBe(false);
    }
    const byId = new Map(preset.rules.map((r) => [r.id, r]));
    // Green (positive outcomes)
    for (const id of ['success', 'succeeded', 'passed', 'ok']) {
      expect(byId.get(id)?.style.backgroundColor).toBe('#c8e6c9');
    }
    // Amber (warning / in-progress)
    for (const id of ['warning', 'warn', 'pending', 'retry']) {
      expect(byId.get(id)?.style.backgroundColor).toBe('#ffe0b2');
    }
    // `ok` and `warn` use exact-match because contains would hit
    // English noise (took, look, broken, Warner, warned). Every
    // other term uses contains so it catches embedded forms
    // (successCount, warningLevel, etc.).
    for (const id of ['ok', 'warn']) {
      expect(byId.get(id)?.matchType).toBe('exact');
    }
    for (const id of ['success', 'succeeded', 'passed', 'warning', 'pending', 'retry']) {
      expect(byId.get(id)?.matchType).toBe('contains');
    }
    expect(preset.rules.map((r) => r.matchValue)).toEqual([
      'success',
      'succeeded',
      'passed',
      'ok',
      'warning',
      'warn',
      'pending',
      'retry',
    ]);
  });

  describe('test-header-content preset', () => {
    it('ships complementary pair rules for each supported key spelling', () => {
      const redBackgroundColor = '#ffcdd2';
      const greenBackgroundColor = '#c8e6c9';
      const expectedRuleIds = [
        'kebab-has',
        'kebab-lacks',
        'camel-has',
        'camel-lacks',
        'snake-has',
        'snake-lacks',
      ];
      const expectedSpellings = ['test-header', 'testHeader', 'test_header'];
      const preset = findPreset('test-header-content')!;
      expect(preset).toBeDefined();
      expect(preset.rules).toHaveLength(6);
      expect(preset.rules.map((rule) => rule.id)).toEqual(expectedRuleIds);

      const pairRules = preset.rules.map((rule, index) => {
        const normalized = assertRule(rule, `presets.${preset.id}[${index}]`);
        expect(normalized).toEqual(rule);
        expect(rule.kind).toBe('pair');
        if (rule.kind !== 'pair') {
          throw new Error(`Expected ${rule.id} to be a pair rule`);
        }
        expect(rule.keyMatch.matchType).toBe('exact');
        expect(rule.keyMatch.caseSensitive).toBe(false);
        expect(rule.valueMatch.kind).toBe('predicate');
        return rule;
      });

      for (const spelling of expectedSpellings) {
        const rulesForSpelling = pairRules.filter((rule) => rule.keyMatch.matchValue === spelling);
        expect(rulesForSpelling).toHaveLength(2);

        const hasContentRules = rulesForSpelling.filter(
          (rule) =>
            rule.valueMatch.kind === 'predicate' && rule.valueMatch.predicate === 'has_content',
        );
        expect(hasContentRules).toHaveLength(1);
        expect(hasContentRules[0]?.style.backgroundColor).toBe(redBackgroundColor);
        // has_content rules carry the `warning` icon so populated
        // test-header values surface as beacons.
        expect(hasContentRules[0]?.style.icon).toBe('warning');

        const lacksContentRules = rulesForSpelling.filter(
          (rule) =>
            rule.valueMatch.kind === 'predicate' && rule.valueMatch.predicate === 'lacks_content',
        );
        expect(lacksContentRules).toHaveLength(1);
        expect(lacksContentRules[0]?.style.backgroundColor).toBe(greenBackgroundColor);
        // lacks_content rules carry no icon - an empty test-header
        // is the boring/expected case.
        expect(lacksContentRules[0]?.style.icon).toBeUndefined();
      }
    });
  });

  it('findPreset returns undefined for unknown ids', () => {
    expect(findPreset('does-not-exist')).toBeUndefined();
  });

  it('listPresets matches PRESET_RULE_SETS', () => {
    expect(listPresets()).toBe(PRESET_RULE_SETS);
  });

  it('presetToCreatePayload deep-clones rules so mutation is safe', () => {
    const preset = findPreset('null-finder')!;
    const payload = presetToCreatePayload(preset);
    payload.rules[0]!.style.backgroundColor = '#000000';
    expect(preset.rules[0]!.style.backgroundColor).toBe('#fff59d');
  });

  it('preset rule IDs are unique within a set', () => {
    for (const preset of PRESET_RULE_SETS) {
      const ids = preset.rules.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
