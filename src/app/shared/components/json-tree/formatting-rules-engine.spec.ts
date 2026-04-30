import {
  EMPTY_RULE_RESULT,
  describeRule,
  evaluateFormattingRules,
  type RuleEngineNode
} from './formatting-rules-engine';
import type {
  FormattingRule,
  FormattingRuleSet,
  FormattingStyle
} from '../../../core/api/models';

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

function set(
  rules: FormattingRule[],
  overrides: Partial<FormattingRuleSet> = {}
): FormattingRuleSet {
  return {
    id: 's1',
    userId: 'u1',
    name: 'Set 1',
    rules,
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides
  };
}

function node(overrides: Partial<RuleEngineNode> = {}): RuleEngineNode {
  return { key: null, valueText: null, isContainer: false, ...overrides };
}

const RED_BG: FormattingStyle = { backgroundColor: '#ff0000' };
const BLUE_TEXT: FormattingStyle = { textColor: '#0000ff' };
const BOLD: FormattingStyle = { bold: true };
const NOT_BOLD: FormattingStyle = { bold: false };

describe('evaluateFormattingRules', () => {
  describe('empty / no-match cases', () => {
    it('returns the EMPTY_RULE_RESULT sentinel by identity when no sets supplied', () => {
      expect(evaluateFormattingRules([], node({ key: 'x' }))).toBe(EMPTY_RULE_RESULT);
    });

    it('returns the EMPTY_RULE_RESULT sentinel when no rules match', () => {
      const sets = [set([rule({ matchValue: 'never-found' })])];
      const result = evaluateFormattingRules(sets, node({ key: 'foo', valueText: 'bar' }));
      expect(result).toBe(EMPTY_RULE_RESULT);
    });

    it('EMPTY_RULE_RESULT and its inner objects are frozen', () => {
      expect(Object.isFrozen(EMPTY_RULE_RESULT)).toBe(true);
      expect(Object.isFrozen(EMPTY_RULE_RESULT.rowStyle)).toBe(true);
      expect(Object.isFrozen(EMPTY_RULE_RESULT.keyStyle)).toBe(true);
      expect(Object.isFrozen(EMPTY_RULE_RESULT.valueStyle)).toBe(true);
      expect(Object.isFrozen(EMPTY_RULE_RESULT.matchedRules)).toBe(true);
    });
  });

  describe('match-type x target matrix', () => {
    it('exact key match', () => {
      const r = rule({ target: 'key', matchType: 'exact', matchValue: 'foo', style: BOLD });
      const result = evaluateFormattingRules([set([r])], node({ key: 'foo' }));
      expect(result.keyStyle.bold).toBe(true);
      expect(result.valueStyle).toEqual({});
    });

    it('contains key match', () => {
      const r = rule({ target: 'key', matchType: 'contains', matchValue: 'err', style: BOLD });
      const result = evaluateFormattingRules([set([r])], node({ key: 'error_msg' }));
      expect(result.keyStyle.bold).toBe(true);
    });

    it('starts_with key match', () => {
      const r = rule({
        target: 'key',
        matchType: 'starts_with',
        matchValue: 'pre_',
        style: BOLD
      });
      const result = evaluateFormattingRules([set([r])], node({ key: 'pre_thing' }));
      expect(result.keyStyle.bold).toBe(true);
    });

    it('ends_with key match', () => {
      const r = rule({
        target: 'key',
        matchType: 'ends_with',
        matchValue: '_id',
        style: BOLD
      });
      const result = evaluateFormattingRules([set([r])], node({ key: 'user_id' }));
      expect(result.keyStyle.bold).toBe(true);
    });

    it('exact value match', () => {
      const r = rule({
        target: 'value',
        matchType: 'exact',
        matchValue: '200',
        style: BLUE_TEXT
      });
      const result = evaluateFormattingRules(
        [set([r])],
        node({ key: 'status', valueText: '200' })
      );
      expect(result.valueStyle.color).toBe('#0000ff');
      expect(result.keyStyle).toEqual({});
    });

    it('value-target does not match the key', () => {
      const r = rule({
        target: 'value',
        matchType: 'exact',
        matchValue: 'foo',
        style: BOLD
      });
      const result = evaluateFormattingRules(
        [set([r])],
        node({ key: 'foo', valueText: 'bar' })
      );
      expect(result).toBe(EMPTY_RULE_RESULT);
    });

    it('key-target does not match the value', () => {
      const r = rule({
        target: 'key',
        matchType: 'exact',
        matchValue: 'bar',
        style: BOLD
      });
      const result = evaluateFormattingRules(
        [set([r])],
        node({ key: 'foo', valueText: 'bar' })
      );
      expect(result).toBe(EMPTY_RULE_RESULT);
    });
  });

  describe('case sensitivity', () => {
    it('default matches case-insensitively', () => {
      const r = rule({ matchValue: 'ERROR' });
      const result = evaluateFormattingRules(
        [set([r, rule({ id: 'r-style', matchValue: 'ERROR', style: BOLD })])],
        node({ key: 'errorMessage' })
      );
      expect(result.keyStyle.bold).toBe(true);
    });

    it('caseSensitive=true rejects mismatched case', () => {
      const r = rule({ matchValue: 'ERROR', caseSensitive: true, style: BOLD });
      const result = evaluateFormattingRules([set([r])], node({ key: 'errorMessage' }));
      expect(result).toBe(EMPTY_RULE_RESULT);
    });

    it('caseSensitive=true accepts matching case', () => {
      const r = rule({ matchValue: 'ERROR', caseSensitive: true, style: BOLD });
      const result = evaluateFormattingRules([set([r])], node({ key: 'ERROR_LOG' }));
      expect(result.keyStyle.bold).toBe(true);
    });
  });

  describe('target=key_and_value semantics', () => {
    const keyAndValue = (style: FormattingStyle, matchValue = 'foo') =>
      rule({ target: 'key_and_value', matchType: 'exact', matchValue, style });

    it('only key matches: styles only the key side', () => {
      const result = evaluateFormattingRules(
        [set([keyAndValue(BOLD)])],
        node({ key: 'foo', valueText: 'something-else' })
      );
      expect(result.keyStyle.bold).toBe(true);
      expect(result.valueStyle).toEqual({});
    });

    it('only value matches: styles only the value side', () => {
      const result = evaluateFormattingRules(
        [set([keyAndValue(BOLD)])],
        node({ key: 'whatever', valueText: 'foo' })
      );
      expect(result.valueStyle.bold).toBe(true);
      expect(result.keyStyle).toEqual({});
    });

    it('both match: styles both sides', () => {
      const result = evaluateFormattingRules(
        [set([keyAndValue(BOLD)])],
        node({ key: 'foo', valueText: 'foo' })
      );
      expect(result.keyStyle.bold).toBe(true);
      expect(result.valueStyle.bold).toBe(true);
    });

    it('records exactly one matchedRules entry regardless of how many sides matched', () => {
      const result = evaluateFormattingRules(
        [set([keyAndValue(BOLD)])],
        node({ key: 'foo', valueText: 'foo' })
      );
      expect(result.matchedRules.length).toBe(1);
    });

    it('row-level style fires whether key or value matched', () => {
      const r = keyAndValue(RED_BG);
      const onlyKey = evaluateFormattingRules(
        [set([r])],
        node({ key: 'foo', valueText: 'x' })
      );
      const onlyValue = evaluateFormattingRules(
        [set([r])],
        node({ key: 'x', valueText: 'foo' })
      );
      expect(onlyKey.rowStyle.backgroundColor).toBe('#ff0000');
      expect(onlyValue.rowStyle.backgroundColor).toBe('#ff0000');
    });
  });

  describe('container nodes', () => {
    const valueRule = rule({
      target: 'value',
      matchType: 'exact',
      matchValue: 'whatever',
      style: BOLD
    });

    it('value-target rule is skipped on container nodes (F8)', () => {
      const result = evaluateFormattingRules(
        [set([valueRule])],
        node({ key: 'wrapper', valueText: null, isContainer: true })
      );
      expect(result).toBe(EMPTY_RULE_RESULT);
    });

    it('key-target rule still fires on container nodes', () => {
      const r = rule({ target: 'key', matchType: 'exact', matchValue: 'wrapper', style: BOLD });
      const result = evaluateFormattingRules(
        [set([r])],
        node({ key: 'wrapper', valueText: null, isContainer: true })
      );
      expect(result.keyStyle.bold).toBe(true);
    });

    it('key_and_value on a container only styles the key side, even if its matchValue would have matched a value', () => {
      const r = rule({
        target: 'key_and_value',
        matchType: 'exact',
        matchValue: 'wrapper',
        style: BOLD
      });
      const result = evaluateFormattingRules(
        [set([r])],
        node({ key: 'wrapper', valueText: null, isContainer: true })
      );
      expect(result.keyStyle.bold).toBe(true);
      expect(result.valueStyle).toEqual({});
    });
  });

  describe('root and array elements have null key', () => {
    it('skips key-target rules when key is null (root)', () => {
      const r = rule({ target: 'key', matchValue: 'whatever', style: BOLD });
      const result = evaluateFormattingRules(
        [set([r])],
        node({ key: null, valueText: '42' })
      );
      expect(result).toBe(EMPTY_RULE_RESULT);
    });

    it('value-target rules still fire when key is null', () => {
      const r = rule({
        target: 'value',
        matchType: 'exact',
        matchValue: '42',
        style: BLUE_TEXT
      });
      const result = evaluateFormattingRules(
        [set([r])],
        node({ key: null, valueText: '42' })
      );
      expect(result.valueStyle.color).toBe('#0000ff');
    });
  });

  describe('within-set merge order', () => {
    it('later rule overrides earlier on same property', () => {
      const r1 = rule({ id: 'r1', matchValue: 'foo', style: { textColor: '#ff0000' } });
      const r2 = rule({ id: 'r2', matchValue: 'foo', style: { textColor: '#0000ff' } });
      const result = evaluateFormattingRules(
        [set([r1, r2])],
        node({ key: 'foo' })
      );
      expect(result.keyStyle.color).toBe('#0000ff');
    });

    it('absent property in later rule does NOT clobber earlier', () => {
      const r1 = rule({ id: 'r1', matchValue: 'foo', style: { textColor: '#ff0000', bold: true } });
      const r2 = rule({ id: 'r2', matchValue: 'foo', style: { italic: true } });
      const result = evaluateFormattingRules(
        [set([r1, r2])],
        node({ key: 'foo' })
      );
      expect(result.keyStyle.color).toBe('#ff0000');
      expect(result.keyStyle.bold).toBe(true);
      expect(result.keyStyle.italic).toBe(true);
    });

    it('explicit false in later rule clobbers earlier true', () => {
      const r1 = rule({ id: 'r1', matchValue: 'foo', style: BOLD });
      const r2 = rule({ id: 'r2', matchValue: 'foo', style: NOT_BOLD });
      const result = evaluateFormattingRules(
        [set([r1, r2])],
        node({ key: 'foo' })
      );
      expect(result.keyStyle.bold).toBe(false);
    });

    it('records both rules in matchedRules in evaluation order', () => {
      const r1 = rule({ id: 'r1', matchValue: 'foo', style: BOLD });
      const r2 = rule({ id: 'r2', matchValue: 'foo', style: NOT_BOLD });
      const result = evaluateFormattingRules(
        [set([r1, r2])],
        node({ key: 'foo' })
      );
      expect(result.matchedRules.map((m) => m.ruleId)).toEqual(['r1', 'r2']);
    });
  });

  describe('cross-set merge order', () => {
    it('later set overrides earlier set on same property', () => {
      const a = set([rule({ matchValue: 'foo', style: { textColor: '#ff0000' } })], {
        id: 'set-a'
      });
      const b = set([rule({ matchValue: 'foo', style: { textColor: '#0000ff' } })], {
        id: 'set-b'
      });
      const result = evaluateFormattingRules([a, b], node({ key: 'foo' }));
      expect(result.keyStyle.color).toBe('#0000ff');
    });

    it('matchedRules carries the source setId for each match', () => {
      const a = set([rule({ id: 'r-a', matchValue: 'foo', style: BOLD })], { id: 'set-a' });
      const b = set([rule({ id: 'r-b', matchValue: 'foo', style: NOT_BOLD })], { id: 'set-b' });
      const result = evaluateFormattingRules([a, b], node({ key: 'foo' }));
      expect(result.matchedRules).toEqual([
        { setId: 'set-a', ruleId: 'r-a', label: 'key contains "foo"' },
        { setId: 'set-b', ruleId: 'r-b', label: 'key contains "foo"' }
      ]);
    });
  });

  describe('row-level style projection', () => {
    it('backgroundColor goes to rowStyle for any matched target', () => {
      const r = rule({ target: 'value', matchType: 'exact', matchValue: '200', style: RED_BG });
      const result = evaluateFormattingRules(
        [set([r])],
        node({ key: 'status', valueText: '200' })
      );
      expect(result.rowStyle.backgroundColor).toBe('#ff0000');
    });

    it('borderColor goes to rowStyle', () => {
      const r = rule({
        target: 'key',
        matchType: 'exact',
        matchValue: 'foo',
        style: { borderColor: '#cccccc' }
      });
      const result = evaluateFormattingRules([set([r])], node({ key: 'foo' }));
      expect(result.rowStyle.borderColor).toBe('#cccccc');
    });

    it('inline-only style does not populate rowStyle', () => {
      const r = rule({ matchValue: 'foo', style: BLUE_TEXT });
      const result = evaluateFormattingRules([set([r])], node({ key: 'foo' }));
      expect(result.rowStyle).toEqual({});
    });
  });

  describe('F8 numeric vs string match (producer contract)', () => {
    // The engine compares plain strings; the F8 guarantee that a
    // number 200 and a string "200" both match `value exact "200"`
    // is realised by the producer passing valueText='200' for both.
    // These tests pin that contract from the engine side.
    it('matches when a string value arrives unquoted', () => {
      const r = rule({
        target: 'value',
        matchType: 'exact',
        matchValue: '200',
        style: BOLD
      });
      const result = evaluateFormattingRules(
        [set([r])],
        node({ key: 'status', valueText: '200' })
      );
      expect(result.valueStyle.bold).toBe(true);
    });

    it('does NOT match when the producer accidentally passed quoted text', () => {
      const r = rule({
        target: 'value',
        matchType: 'exact',
        matchValue: '200',
        style: BOLD
      });
      const result = evaluateFormattingRules(
        [set([r])],
        node({ key: 'status', valueText: '"200"' })
      );
      expect(result).toBe(EMPTY_RULE_RESULT);
    });
  });

  describe('structurally invalid rules are silently skipped', () => {
    it('empty matchValue is skipped', () => {
      const r = rule({ matchValue: '', style: BOLD });
      const result = evaluateFormattingRules([set([r])], node({ key: 'anything' }));
      expect(result).toBe(EMPTY_RULE_RESULT);
    });

    it('unknown target is skipped', () => {
      const r = rule({ style: BOLD });
      // Cast through `as unknown` to simulate runtime data that bypassed
      // the validator (e.g. a future enum value reaching an older client).
      (r as unknown as { target: string }).target = 'who-knows';
      const result = evaluateFormattingRules([set([r])], node({ key: 'foo' }));
      expect(result).toBe(EMPTY_RULE_RESULT);
    });

    it('unknown matchType is skipped', () => {
      const r = rule({ style: BOLD });
      (r as unknown as { matchType: string }).matchType = 'regex';
      const result = evaluateFormattingRules([set([r])], node({ key: 'foo' }));
      expect(result).toBe(EMPTY_RULE_RESULT);
    });
  });

  describe('icon projection', () => {
    it('latest icon wins when two rules both project icons', () => {
      const r1 = rule({ id: 'r1', matchValue: 'foo', style: { icon: 'warning' } });
      const r2 = rule({ id: 'r2', matchValue: 'foo', style: { icon: 'error' } });
      const result = evaluateFormattingRules(
        [set([r1, r2])],
        node({ key: 'foo' })
      );
      expect(result.keyStyle.icon).toBe('error');
    });

    it('icon projects to keyStyle for target=key', () => {
      const r = rule({ target: 'key', matchValue: 'foo', style: { icon: 'star' } });
      const result = evaluateFormattingRules([set([r])], node({ key: 'foo' }));
      expect(result.keyStyle.icon).toBe('star');
      expect(result.valueStyle.icon).toBeUndefined();
    });

    it('icon projects to valueStyle for target=value', () => {
      const r = rule({
        target: 'value',
        matchType: 'exact',
        matchValue: '200',
        style: { icon: 'check' }
      });
      const result = evaluateFormattingRules(
        [set([r])],
        node({ key: 'status', valueText: '200' })
      );
      expect(result.valueStyle.icon).toBe('check');
      expect(result.keyStyle.icon).toBeUndefined();
    });
  });

  describe('performance baseline', () => {
    it('evaluates 10 rules over 1,000 nodes in well under 50 ms', () => {
      const rules: FormattingRule[] = Array.from({ length: 10 }, (_, i) =>
        rule({ id: `r${i}`, matchValue: `marker-${i}`, style: BOLD })
      );
      const sets = [set(rules)];
      const nodes: RuleEngineNode[] = Array.from({ length: 1000 }, (_, i) =>
        node({ key: `key-${i % 50}`, valueText: `val-${i}` })
      );
      const start = performance.now();
      for (const n of nodes) {
        evaluateFormattingRules(sets, n);
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(50);
    });
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
      describeRule(
        rule({ target: 'key', matchType: 'ends_with', matchValue: '_id', caseSensitive: true })
      )
    ).toBe('key ends_with "_id" (case-sensitive)');
  });

  it('escapes embedded quotes in matchValue', () => {
    expect(describeRule(rule({ matchValue: 'foo"bar' }))).toBe('key contains "foo\\"bar"');
  });

  it('handles an empty matchValue without throwing', () => {
    expect(describeRule(rule({ matchValue: '' }))).toBe('key contains ""');
  });
});
