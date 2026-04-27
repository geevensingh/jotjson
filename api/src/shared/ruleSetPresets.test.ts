jest.mock('./cosmos', () => ({
  getCosmos: jest.fn(() => {
    throw new Error('cosmos must not be touched in preset-data tests');
  })
}));

import { assertRule, assertRuleSetPayload } from './ruleSets';
import {
  PRESET_RULE_SETS,
  findPreset,
  listPresets,
  presetToCreatePayload
} from './ruleSetPresets';

describe('built-in rule-set presets', () => {
  it('exposes the three spec presets in a stable order', () => {
    const ids = PRESET_RULE_SETS.map((p) => p.id);
    expect(ids).toEqual(['error-detection', 'status-codes', 'null-finder']);
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

  it('error-detection targets keys with contains', () => {
    const preset = findPreset('error-detection')!;
    expect(preset).toBeDefined();
    expect(preset.rules).toHaveLength(4);
    for (const rule of preset.rules) {
      expect(rule.target).toBe('key');
      expect(rule.matchType).toBe('contains');
      expect(rule.style.backgroundColor).toBe('#ffcdd2');
    }
    expect(preset.rules.map((r) => r.matchValue)).toEqual([
      'error',
      'err',
      'exception',
      'fault'
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
