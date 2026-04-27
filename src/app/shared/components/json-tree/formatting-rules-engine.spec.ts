import {
  EMPTY_RULE_RESULT,
  describeRule,
  evaluateFormattingRules
} from './formatting-rules-engine';
import type { FormattingRule, FormattingRuleSet } from '../../../core/api/models';

function rule(overrides: Partial<FormattingRule> = {}): FormattingRule {
  return {
    id: 'r1',
    target: 'key',
    matchType: 'contains',
    matchValue: 'error',
    caseSensitive: false,
    style: {},
    ...overrides
  };
}

describe('formatting-rules-engine (M6a.75 stub)', () => {
  describe('evaluateFormattingRules', () => {
    it('returns EMPTY_RULE_RESULT for any input (stub contract)', () => {
      const result = evaluateFormattingRules([], {
        key: 'foo',
        valueText: 'bar',
        isContainer: false
      });
      expect(result).toBe(EMPTY_RULE_RESULT);
    });

    it('returns EMPTY_RULE_RESULT even when sets are provided (stub)', () => {
      const sets: FormattingRuleSet[] = [
        {
          id: 's1',
          userId: 'u1',
          name: 'Errors',
          rules: [rule()],
          version: 1,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z'
        }
      ];
      const result = evaluateFormattingRules(sets, {
        key: 'errorMessage',
        valueText: null,
        isContainer: false
      });
      expect(result).toBe(EMPTY_RULE_RESULT);
    });

    it('EMPTY_RULE_RESULT is frozen so callers cannot mutate the shared sentinel', () => {
      expect(Object.isFrozen(EMPTY_RULE_RESULT)).toBe(true);
      expect(Object.isFrozen(EMPTY_RULE_RESULT.rowStyle)).toBe(true);
      expect(Object.isFrozen(EMPTY_RULE_RESULT.keyStyle)).toBe(true);
      expect(Object.isFrozen(EMPTY_RULE_RESULT.valueStyle)).toBe(true);
      expect(Object.isFrozen(EMPTY_RULE_RESULT.matchedRules)).toBe(true);
    });
  });

  describe('describeRule', () => {
    it('renders a key-target contains rule', () => {
      expect(describeRule(rule({ target: 'key', matchType: 'contains', matchValue: 'error' })))
        .toBe('key contains "error"');
    });

    it('renders a value-target exact rule', () => {
      expect(describeRule(rule({ target: 'value', matchType: 'exact', matchValue: '200' })))
        .toBe('value exact "200"');
    });

    it('renders a key_and_value-target starts_with rule', () => {
      expect(
        describeRule(
          rule({ target: 'key_and_value', matchType: 'starts_with', matchValue: 'x_' })
        )
      ).toBe('key or value starts_with "x_"');
    });

    it('annotates case-sensitive rules', () => {
      expect(
        describeRule(rule({ target: 'key', matchType: 'ends_with', matchValue: '_id', caseSensitive: true }))
      ).toBe('key ends_with "_id" (case-sensitive)');
    });

    it('escapes embedded quotes in matchValue', () => {
      expect(describeRule(rule({ matchValue: 'foo"bar' })))
        .toBe('key contains "foo\\"bar"');
    });

    it('handles an empty matchValue without throwing', () => {
      expect(describeRule(rule({ matchValue: '' }))).toBe('key contains ""');
    });
  });
});
