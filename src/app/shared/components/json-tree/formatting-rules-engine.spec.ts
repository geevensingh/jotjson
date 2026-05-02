import {
  EMPTY_RULE_RESULT,
  describeRule,
  evaluateFormattingRules,
  type RuleEngineNode,
  type RuleEngineResult,
} from './formatting-rules-engine';
import type {
  FormattingRule,
  FormattingRuleMatchType,
  FormattingRulePair,
  FormattingRuleSet,
  FormattingRuleSimple,
  FormattingStyle,
  ValuePredicate,
} from '../../../core/api/models';

function rule(overrides: Partial<FormattingRuleSimple> = {}): FormattingRuleSimple {
  return {
    id: 'r1',
    target: 'key',
    matchType: 'contains',
    matchValue: 'error',
    caseSensitive: false,
    style: {},
    ...overrides,
  };
}

function pairRule(overrides: Partial<FormattingRulePair> = {}): FormattingRulePair {
  return {
    id: 'pair-r1',
    kind: 'pair',
    keyMatch: {
      matchType: 'exact',
      matchValue: 'status',
      caseSensitive: false,
    },
    valueMatch: {
      kind: 'text',
      matchType: 'exact',
      matchValue: 'ok',
      caseSensitive: false,
    },
    style: {},
    ...overrides,
  };
}

function predicatePairRule(
  predicate: ValuePredicate,
  overrides: Partial<FormattingRulePair> = {},
): FormattingRulePair {
  return pairRule({ valueMatch: { kind: 'predicate', predicate }, ...overrides });
}

function set(
  rules: FormattingRule[],
  overrides: Partial<FormattingRuleSet> = {},
): FormattingRuleSet {
  return {
    id: 's1',
    userId: 'u1',
    name: 'Set 1',
    rules,
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function node(overrides: Partial<RuleEngineNode> = {}): RuleEngineNode {
  return {
    key: null,
    valueText: null,
    isContainer: false,
    valueKind: null,
    isEmpty: false,
    ...overrides,
  };
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
        style: BOLD,
      });
      const result = evaluateFormattingRules([set([r])], node({ key: 'pre_thing' }));
      expect(result.keyStyle.bold).toBe(true);
    });

    it('ends_with key match', () => {
      const r = rule({
        target: 'key',
        matchType: 'ends_with',
        matchValue: '_id',
        style: BOLD,
      });
      const result = evaluateFormattingRules([set([r])], node({ key: 'user_id' }));
      expect(result.keyStyle.bold).toBe(true);
    });

    it('exact value match', () => {
      const r = rule({
        target: 'value',
        matchType: 'exact',
        matchValue: '200',
        style: BLUE_TEXT,
      });
      const result = evaluateFormattingRules([set([r])], node({ key: 'status', valueText: '200' }));
      expect(result.valueStyle.color).toBe('#0000ff');
      expect(result.keyStyle).toEqual({});
    });

    it('value-target does not match the key', () => {
      const r = rule({
        target: 'value',
        matchType: 'exact',
        matchValue: 'foo',
        style: BOLD,
      });
      const result = evaluateFormattingRules([set([r])], node({ key: 'foo', valueText: 'bar' }));
      expect(result).toBe(EMPTY_RULE_RESULT);
    });

    it('key-target does not match the value', () => {
      const r = rule({
        target: 'key',
        matchType: 'exact',
        matchValue: 'bar',
        style: BOLD,
      });
      const result = evaluateFormattingRules([set([r])], node({ key: 'foo', valueText: 'bar' }));
      expect(result).toBe(EMPTY_RULE_RESULT);
    });
  });

  describe('case sensitivity', () => {
    it('default matches case-insensitively', () => {
      const r = rule({ matchValue: 'ERROR' });
      const result = evaluateFormattingRules(
        [set([r, rule({ id: 'r-style', matchValue: 'ERROR', style: BOLD })])],
        node({ key: 'errorMessage' }),
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
        node({ key: 'foo', valueText: 'something-else' }),
      );
      expect(result.keyStyle.bold).toBe(true);
      expect(result.valueStyle).toEqual({});
    });

    it('only value matches: styles only the value side', () => {
      const result = evaluateFormattingRules(
        [set([keyAndValue(BOLD)])],
        node({ key: 'whatever', valueText: 'foo' }),
      );
      expect(result.valueStyle.bold).toBe(true);
      expect(result.keyStyle).toEqual({});
    });

    it('both match: styles both sides', () => {
      const result = evaluateFormattingRules(
        [set([keyAndValue(BOLD)])],
        node({ key: 'foo', valueText: 'foo' }),
      );
      expect(result.keyStyle.bold).toBe(true);
      expect(result.valueStyle.bold).toBe(true);
    });

    it('records exactly one matchedRules entry regardless of how many sides matched', () => {
      const result = evaluateFormattingRules(
        [set([keyAndValue(BOLD)])],
        node({ key: 'foo', valueText: 'foo' }),
      );
      expect(result.matchedRules.length).toBe(1);
    });

    it('row-level style fires whether key or value matched', () => {
      const r = keyAndValue(RED_BG);
      const onlyKey = evaluateFormattingRules([set([r])], node({ key: 'foo', valueText: 'x' }));
      const onlyValue = evaluateFormattingRules([set([r])], node({ key: 'x', valueText: 'foo' }));
      expect(onlyKey.rowStyle.backgroundColor).toBe('#ff0000');
      expect(onlyValue.rowStyle.backgroundColor).toBe('#ff0000');
    });
  });

  describe('simple rule compatibility', () => {
    it('treats missing kind as simple for backwards compatibility', () => {
      const legacyRule = rule({
        target: 'value',
        matchType: 'exact',
        matchValue: '200',
        style: BOLD,
      });
      const result = evaluateFormattingRules(
        [set([legacyRule])],
        node({ key: 'status', valueText: '200', valueKind: 'integer' }),
      );

      expect(result.valueStyle.bold).toBe(true);
      expect(result.keyStyle).toEqual({});
    });
  });

  describe('pair rules with text value matches', () => {
    const textMatchCases: readonly {
      matchType: FormattingRuleMatchType;
      matchValue: string;
      matchingText: string;
      failingText: string;
    }[] = [
      { matchType: 'exact', matchValue: 'Alpha', matchingText: 'Alpha', failingText: 'AlphaBeta' },
      { matchType: 'contains', matchValue: 'lph', matchingText: 'Alpha', failingText: 'Beta' },
      { matchType: 'starts_with', matchValue: 'Al', matchingText: 'Alpha', failingText: 'BetaAl' },
      { matchType: 'ends_with', matchValue: 'ha', matchingText: 'Alpha', failingText: 'haBeta' },
    ];

    it('matches only when both key and value text conditions match for every matchType combo', () => {
      for (const keyCase of textMatchCases) {
        for (const valueCase of textMatchCases) {
          const formattingRule = pairRule({
            keyMatch: {
              matchType: keyCase.matchType,
              matchValue: keyCase.matchValue,
              caseSensitive: false,
            },
            valueMatch: {
              kind: 'text',
              matchType: valueCase.matchType,
              matchValue: valueCase.matchValue,
              caseSensitive: false,
            },
            style: BOLD,
          });

          const matchingResult = evaluateFormattingRules(
            [set([formattingRule])],
            node({
              key: keyCase.matchingText,
              valueText: valueCase.matchingText,
              valueKind: 'string',
            }),
          );
          expect(matchingResult.keyStyle.bold)
            .withContext(`${keyCase.matchType} key and ${valueCase.matchType} value should match`)
            .toBe(true);
          expect(matchingResult.valueStyle.bold).toBe(true);

          const keyMissResult = evaluateFormattingRules(
            [set([formattingRule])],
            node({
              key: keyCase.failingText,
              valueText: valueCase.matchingText,
              valueKind: 'string',
            }),
          );
          expect(keyMissResult)
            .withContext(`${keyCase.matchType} key miss should skip pair rule`)
            .toBe(EMPTY_RULE_RESULT);

          const valueMissResult = evaluateFormattingRules(
            [set([formattingRule])],
            node({
              key: keyCase.matchingText,
              valueText: valueCase.failingText,
              valueKind: 'string',
            }),
          );
          expect(valueMissResult)
            .withContext(`${valueCase.matchType} value miss should skip pair rule`)
            .toBe(EMPTY_RULE_RESULT);
        }
      }
    });
  });

  describe('pair rules with predicate value matches', () => {
    function predicateResult(
      predicate: ValuePredicate,
      overrides: Partial<RuleEngineNode>,
      style: FormattingStyle = BOLD,
    ): RuleEngineResult {
      return evaluateFormattingRules(
        [set([predicatePairRule(predicate, { style })])],
        node({ key: 'status', ...overrides }),
      );
    }

    const contentPredicateCases: readonly {
      label: string;
      node: Partial<RuleEngineNode>;
      lacksContent: boolean;
      hasContent: boolean;
    }[] = [
      {
        label: 'null',
        node: { valueKind: 'null', valueText: 'null' },
        lacksContent: true,
        hasContent: false,
      },
      {
        label: 'empty string',
        node: { valueKind: 'string', valueText: '' },
        lacksContent: true,
        hasContent: false,
      },
      {
        label: 'empty array',
        node: { valueKind: 'array', valueText: null, isContainer: true, isEmpty: true },
        lacksContent: true,
        hasContent: false,
      },
      {
        label: 'empty object',
        node: { valueKind: 'object', valueText: null, isContainer: true, isEmpty: true },
        lacksContent: true,
        hasContent: false,
      },
      {
        label: 'whitespace string',
        node: { valueKind: 'string', valueText: '   ' },
        lacksContent: false,
        hasContent: true,
      },
      {
        label: 'non-empty string',
        node: { valueKind: 'string', valueText: 'hello' },
        lacksContent: false,
        hasContent: true,
      },
      {
        label: 'integer 42',
        node: { valueKind: 'integer', valueText: '42' },
        lacksContent: false,
        hasContent: true,
      },
      {
        label: 'integer zero',
        node: { valueKind: 'integer', valueText: '0' },
        lacksContent: false,
        hasContent: true,
      },
      {
        label: 'boolean true',
        node: { valueKind: 'boolean', valueText: 'true' },
        lacksContent: false,
        hasContent: true,
      },
      {
        label: 'boolean false',
        node: { valueKind: 'boolean', valueText: 'false' },
        lacksContent: false,
        hasContent: true,
      },
      {
        label: 'non-empty array',
        node: { valueKind: 'array', valueText: null, isContainer: true, isEmpty: false },
        lacksContent: false,
        hasContent: true,
      },
      {
        label: 'non-empty object',
        node: { valueKind: 'object', valueText: null, isContainer: true, isEmpty: false },
        lacksContent: false,
        hasContent: true,
      },
    ];

    it('matches has_content and lacks_content according to the content truth table', () => {
      for (const contentPredicateCase of contentPredicateCases) {
        const lacksContentMatched =
          predicateResult('lacks_content', contentPredicateCase.node) !== EMPTY_RULE_RESULT;
        const hasContentMatched =
          predicateResult('has_content', contentPredicateCase.node) !== EMPTY_RULE_RESULT;

        expect(lacksContentMatched)
          .withContext(`${contentPredicateCase.label} lacks_content result`)
          .toBe(contentPredicateCase.lacksContent);
        expect(hasContentMatched)
          .withContext(`${contentPredicateCase.label} has_content result`)
          .toBe(contentPredicateCase.hasContent);
      }
    });

    it('keeps has_content and lacks_content mutually exclusive', () => {
      for (const contentPredicateCase of contentPredicateCases) {
        const lacksContentMatched =
          predicateResult('lacks_content', contentPredicateCase.node) !== EMPTY_RULE_RESULT;
        const hasContentMatched =
          predicateResult('has_content', contentPredicateCase.node) !== EMPTY_RULE_RESULT;

        expect(lacksContentMatched && hasContentMatched)
          .withContext(`${contentPredicateCase.label} should not match both content predicates`)
          .toBe(false);
      }
    });

    it('accepts has_content and lacks_content through the predicate validator gate', () => {
      const validPredicateCases: readonly {
        predicate: ValuePredicate;
        node: Partial<RuleEngineNode>;
      }[] = [
        { predicate: 'has_content', node: { valueKind: 'string', valueText: 'present' } },
        { predicate: 'lacks_content', node: { valueKind: 'null', valueText: 'null' } },
      ];

      for (const validPredicateCase of validPredicateCases) {
        const result = predicateResult(validPredicateCase.predicate, validPredicateCase.node);

        expect(result.matchedRules)
          .withContext(`${validPredicateCase.predicate} should pass isValidPredicate`)
          .toEqual([
            {
              setId: 's1',
              ruleId: 'pair-r1',
              label: `key exact "status" AND value ${validPredicateCase.predicate}`,
            },
          ]);
      }
    });

    it('matches is_null only for JSON null, not the string literal "null"', () => {
      expect(
        predicateResult('is_null', { valueKind: 'null', valueText: 'null' }).keyStyle.bold,
      ).toBe(true);
      expect(predicateResult('is_null', { valueKind: 'string', valueText: 'null' })).toBe(
        EMPTY_RULE_RESULT,
      );
    });

    it('matches string, number, and integer value kinds explicitly', () => {
      expect(
        predicateResult('is_string', { valueKind: 'string', valueText: 'abc' }).keyStyle.bold,
      ).toBe(true);
      expect(
        predicateResult('is_number', { valueKind: 'number', valueText: '1.5' }).keyStyle.bold,
      ).toBe(true);
      expect(
        predicateResult('is_integer', { valueKind: 'integer', valueText: '1' }).keyStyle.bold,
      ).toBe(true);
      expect(predicateResult('is_string', { valueKind: 'number', valueText: '1.5' })).toBe(
        EMPTY_RULE_RESULT,
      );
    });

    it('keeps is_number and is_integer mutually exclusive', () => {
      expect(predicateResult('is_number', { valueKind: 'integer', valueText: '1' })).toBe(
        EMPTY_RULE_RESULT,
      );
      expect(predicateResult('is_integer', { valueKind: 'number', valueText: '1.5' })).toBe(
        EMPTY_RULE_RESULT,
      );
    });

    it('implements the is_empty truth table', () => {
      const emptyCases: readonly Partial<RuleEngineNode>[] = [
        { valueKind: 'string', valueText: '' },
        { valueKind: 'array', valueText: null, isContainer: true, isEmpty: true },
        { valueKind: 'object', valueText: null, isContainer: true, isEmpty: true },
      ];
      for (const emptyCase of emptyCases) {
        expect(predicateResult('is_empty', emptyCase).keyStyle.bold).toBe(true);
      }

      const nonEmptyCases: readonly Partial<RuleEngineNode>[] = [
        { valueKind: 'string', valueText: '0' },
        { valueKind: 'string', valueText: 'a' },
        { valueKind: 'string', valueText: ' ' },
        { valueKind: 'integer', valueText: '0' },
        { valueKind: 'number', valueText: '0.5' },
        { valueKind: 'null', valueText: 'null' },
      ];
      for (const nonEmptyCase of nonEmptyCases) {
        expect(predicateResult('is_empty', nonEmptyCase)).toBe(EMPTY_RULE_RESULT);
      }
    });

    it('implements every is_not predicate as the opposite truth value', () => {
      const predicateCases: readonly {
        positive: ValuePredicate;
        negative: ValuePredicate;
        matchingNode: Partial<RuleEngineNode>;
        nonMatchingNode: Partial<RuleEngineNode>;
      }[] = [
        {
          positive: 'is_null',
          negative: 'is_not_null',
          matchingNode: { valueKind: 'null', valueText: 'null' },
          nonMatchingNode: { valueKind: 'string', valueText: 'null' },
        },
        {
          positive: 'is_empty',
          negative: 'is_not_empty',
          matchingNode: { valueKind: 'string', valueText: '' },
          nonMatchingNode: { valueKind: 'string', valueText: 'x' },
        },
        {
          positive: 'is_string',
          negative: 'is_not_string',
          matchingNode: { valueKind: 'string', valueText: 'x' },
          nonMatchingNode: { valueKind: 'boolean', valueText: 'true' },
        },
        {
          positive: 'is_number',
          negative: 'is_not_number',
          matchingNode: { valueKind: 'number', valueText: '1.5' },
          nonMatchingNode: { valueKind: 'integer', valueText: '1' },
        },
        {
          positive: 'is_integer',
          negative: 'is_not_integer',
          matchingNode: { valueKind: 'integer', valueText: '1' },
          nonMatchingNode: { valueKind: 'number', valueText: '1.5' },
        },
        {
          positive: 'is_boolean',
          negative: 'is_not_boolean',
          matchingNode: { valueKind: 'boolean', valueText: 'false' },
          nonMatchingNode: { valueKind: 'string', valueText: 'false' },
        },
        {
          positive: 'is_object',
          negative: 'is_not_object',
          matchingNode: { valueKind: 'object', valueText: null, isContainer: true },
          nonMatchingNode: { valueKind: 'array', valueText: null, isContainer: true },
        },
        {
          positive: 'is_array',
          negative: 'is_not_array',
          matchingNode: { valueKind: 'array', valueText: null, isContainer: true },
          nonMatchingNode: { valueKind: 'object', valueText: null, isContainer: true },
        },
      ];

      for (const predicateCase of predicateCases) {
        expect(predicateResult(predicateCase.positive, predicateCase.matchingNode).keyStyle.bold)
          .withContext(`${predicateCase.positive} should match its positive node`)
          .toBe(true);
        expect(predicateResult(predicateCase.positive, predicateCase.nonMatchingNode))
          .withContext(`${predicateCase.positive} should miss its negative node`)
          .toBe(EMPTY_RULE_RESULT);
        expect(predicateResult(predicateCase.negative, predicateCase.matchingNode))
          .withContext(`${predicateCase.negative} should miss the positive node`)
          .toBe(EMPTY_RULE_RESULT);
        expect(predicateResult(predicateCase.negative, predicateCase.nonMatchingNode).keyStyle.bold)
          .withContext(`${predicateCase.negative} should match the negative node`)
          .toBe(true);
      }
    });
  });

  describe('pair rules on container rows', () => {
    it('skips text valueMatch when valueText is null', () => {
      const formattingRule = pairRule({ style: BOLD });
      const result = evaluateFormattingRules(
        [set([formattingRule])],
        node({ key: 'status', valueText: null, valueKind: 'object', isContainer: true }),
      );

      expect(result).toBe(EMPTY_RULE_RESULT);
    });

    it('allows predicate valueMatch to evaluate object containers', () => {
      const objectRule = predicatePairRule('is_object', { style: BOLD });
      const emptyRule = predicatePairRule('is_empty', { id: 'empty-object', style: BLUE_TEXT });
      const result = evaluateFormattingRules(
        [set([objectRule, emptyRule])],
        node({
          key: 'status',
          valueText: null,
          valueKind: 'object',
          isContainer: true,
          isEmpty: true,
        }),
      );

      expect(result.keyStyle.bold).toBe(true);
      expect(result.valueStyle.bold).toBe(true);
      expect(result.keyStyle.color).toBe('#0000ff');
      expect(result.valueStyle.color).toBe('#0000ff');
    });
  });

  describe('pair style projection', () => {
    it('applies inline style to both keyStyle and valueStyle on match', () => {
      const formattingRule = pairRule({ style: BLUE_TEXT });
      const result = evaluateFormattingRules(
        [set([formattingRule])],
        node({ key: 'status', valueText: 'ok', valueKind: 'string' }),
      );

      expect(result.keyStyle.color).toBe('#0000ff');
      expect(result.valueStyle.color).toBe('#0000ff');
    });

    it('projects backgroundColor to rowStyle, not inline styles', () => {
      const formattingRule = pairRule({ style: RED_BG });
      const result = evaluateFormattingRules(
        [set([formattingRule])],
        node({ key: 'status', valueText: 'ok', valueKind: 'string' }),
      );

      expect(result.rowStyle.backgroundColor).toBe('#ff0000');
      expect(result.keyStyle).toEqual({});
      expect(result.valueStyle).toEqual({});
    });
  });

  describe('mixed simple and pair rule merge order', () => {
    it('lets a later pair rule override a simple keyStyle color in the same set', () => {
      const simpleRule = rule({
        id: 'simple-color',
        target: 'key',
        matchType: 'exact',
        matchValue: 'status',
        style: { textColor: '#ff0000' },
      });
      const laterPairRule = pairRule({
        id: 'pair-color',
        style: { textColor: '#0000ff' },
      });
      const result = evaluateFormattingRules(
        [set([simpleRule, laterPairRule])],
        node({ key: 'status', valueText: 'ok', valueKind: 'string' }),
      );

      expect(result.keyStyle.color).toBe('#0000ff');
      expect(result.valueStyle.color).toBe('#0000ff');
      expect(result.matchedRules.map((match) => match.ruleId)).toEqual([
        'simple-color',
        'pair-color',
      ]);
    });
  });

  describe('container nodes', () => {
    const valueRule = rule({
      target: 'value',
      matchType: 'exact',
      matchValue: 'whatever',
      style: BOLD,
    });

    it('value-target rule is skipped on container nodes (F8)', () => {
      const result = evaluateFormattingRules(
        [set([valueRule])],
        node({ key: 'wrapper', valueText: null, isContainer: true }),
      );
      expect(result).toBe(EMPTY_RULE_RESULT);
    });

    it('key-target rule still fires on container nodes', () => {
      const r = rule({ target: 'key', matchType: 'exact', matchValue: 'wrapper', style: BOLD });
      const result = evaluateFormattingRules(
        [set([r])],
        node({ key: 'wrapper', valueText: null, isContainer: true }),
      );
      expect(result.keyStyle.bold).toBe(true);
    });

    it('key_and_value on a container only styles the key side, even if its matchValue would have matched a value', () => {
      const r = rule({
        target: 'key_and_value',
        matchType: 'exact',
        matchValue: 'wrapper',
        style: BOLD,
      });
      const result = evaluateFormattingRules(
        [set([r])],
        node({ key: 'wrapper', valueText: null, isContainer: true }),
      );
      expect(result.keyStyle.bold).toBe(true);
      expect(result.valueStyle).toEqual({});
    });
  });

  describe('root and array elements have null key', () => {
    it('skips key-target rules when key is null (root)', () => {
      const r = rule({ target: 'key', matchValue: 'whatever', style: BOLD });
      const result = evaluateFormattingRules([set([r])], node({ key: null, valueText: '42' }));
      expect(result).toBe(EMPTY_RULE_RESULT);
    });

    it('value-target rules still fire when key is null', () => {
      const r = rule({
        target: 'value',
        matchType: 'exact',
        matchValue: '42',
        style: BLUE_TEXT,
      });
      const result = evaluateFormattingRules([set([r])], node({ key: null, valueText: '42' }));
      expect(result.valueStyle.color).toBe('#0000ff');
    });
  });

  describe('within-set merge order', () => {
    it('later rule overrides earlier on same property', () => {
      const r1 = rule({ id: 'r1', matchValue: 'foo', style: { textColor: '#ff0000' } });
      const r2 = rule({ id: 'r2', matchValue: 'foo', style: { textColor: '#0000ff' } });
      const result = evaluateFormattingRules([set([r1, r2])], node({ key: 'foo' }));
      expect(result.keyStyle.color).toBe('#0000ff');
    });

    it('absent property in later rule does NOT clobber earlier', () => {
      const r1 = rule({ id: 'r1', matchValue: 'foo', style: { textColor: '#ff0000', bold: true } });
      const r2 = rule({ id: 'r2', matchValue: 'foo', style: { italic: true } });
      const result = evaluateFormattingRules([set([r1, r2])], node({ key: 'foo' }));
      expect(result.keyStyle.color).toBe('#ff0000');
      expect(result.keyStyle.bold).toBe(true);
      expect(result.keyStyle.italic).toBe(true);
    });

    it('explicit false in later rule clobbers earlier true', () => {
      const r1 = rule({ id: 'r1', matchValue: 'foo', style: BOLD });
      const r2 = rule({ id: 'r2', matchValue: 'foo', style: NOT_BOLD });
      const result = evaluateFormattingRules([set([r1, r2])], node({ key: 'foo' }));
      expect(result.keyStyle.bold).toBe(false);
    });

    it('records both rules in matchedRules in evaluation order', () => {
      const r1 = rule({ id: 'r1', matchValue: 'foo', style: BOLD });
      const r2 = rule({ id: 'r2', matchValue: 'foo', style: NOT_BOLD });
      const result = evaluateFormattingRules([set([r1, r2])], node({ key: 'foo' }));
      expect(result.matchedRules.map((m) => m.ruleId)).toEqual(['r1', 'r2']);
    });
  });

  describe('cross-set merge order', () => {
    it('later set overrides earlier set on same property', () => {
      const a = set([rule({ matchValue: 'foo', style: { textColor: '#ff0000' } })], {
        id: 'set-a',
      });
      const b = set([rule({ matchValue: 'foo', style: { textColor: '#0000ff' } })], {
        id: 'set-b',
      });
      const result = evaluateFormattingRules([a, b], node({ key: 'foo' }));
      expect(result.keyStyle.color).toBe('#0000ff');
    });

    it('lets a later null-finder set override testHeader lacks_content background', () => {
      const testHeaderContentSet = set(
        [
          pairRule({
            id: 'test-header-lacks-content',
            keyMatch: { matchType: 'exact', matchValue: 'testHeader', caseSensitive: false },
            valueMatch: { kind: 'predicate', predicate: 'lacks_content' },
            style: { backgroundColor: '#c8e6c9' },
          }),
        ],
        {
          id: 'test-header-content',
          createdAt: '2026-01-01T00:00:00Z',
        },
      );
      const nullFinderSet = set(
        [
          rule({
            id: 'null-value-highlight',
            target: 'value',
            matchType: 'exact',
            matchValue: 'null',
            caseSensitive: false,
            style: { backgroundColor: '#fff59d' },
          }),
        ],
        {
          id: 'null-finder',
          createdAt: '2026-01-02T00:00:00Z',
        },
      );

      const result = evaluateFormattingRules(
        [testHeaderContentSet, nullFinderSet],
        node({ key: 'testHeader', valueKind: 'null', valueText: 'null' }),
      );

      expect(result.rowStyle.backgroundColor).toBe('#fff59d');
      expect(result.matchedRules.map((matchedRule) => matchedRule.setId)).toEqual([
        'test-header-content',
        'null-finder',
      ]);
    });

    it('matchedRules carries the source setId for each match', () => {
      const a = set([rule({ id: 'r-a', matchValue: 'foo', style: BOLD })], { id: 'set-a' });
      const b = set([rule({ id: 'r-b', matchValue: 'foo', style: NOT_BOLD })], { id: 'set-b' });
      const result = evaluateFormattingRules([a, b], node({ key: 'foo' }));
      expect(result.matchedRules).toEqual([
        { setId: 'set-a', ruleId: 'r-a', label: 'key contains "foo"' },
        { setId: 'set-b', ruleId: 'r-b', label: 'key contains "foo"' },
      ]);
    });
  });

  describe('row-level style projection', () => {
    it('backgroundColor goes to rowStyle for any matched target', () => {
      const r = rule({ target: 'value', matchType: 'exact', matchValue: '200', style: RED_BG });
      const result = evaluateFormattingRules([set([r])], node({ key: 'status', valueText: '200' }));
      expect(result.rowStyle.backgroundColor).toBe('#ff0000');
    });

    it('borderColor goes to rowStyle', () => {
      const r = rule({
        target: 'key',
        matchType: 'exact',
        matchValue: 'foo',
        style: { borderColor: '#cccccc' },
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
        style: BOLD,
      });
      const result = evaluateFormattingRules([set([r])], node({ key: 'status', valueText: '200' }));
      expect(result.valueStyle.bold).toBe(true);
    });

    it('does NOT match when the producer accidentally passed quoted text', () => {
      const r = rule({
        target: 'value',
        matchType: 'exact',
        matchValue: '200',
        style: BOLD,
      });
      const result = evaluateFormattingRules(
        [set([r])],
        node({ key: 'status', valueText: '"200"' }),
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

    it('unknown rule kind is skipped without throwing', () => {
      const unknownKindRule = {
        ...rule({ style: BOLD }),
        kind: 'unknown_kind',
      } as unknown as FormattingRule;

      const result = evaluateFormattingRules([set([unknownKindRule])], node({ key: 'error' }));
      expect(result).toBe(EMPTY_RULE_RESULT);
    });

    it('pair rule missing keyMatch or valueMatch is skipped without throwing', () => {
      const missingKeyMatchRule = {
        id: 'missing-key-match',
        kind: 'pair',
        valueMatch: { kind: 'predicate', predicate: 'is_string' },
        style: BOLD,
      } as unknown as FormattingRule;
      const missingValueMatchRule = {
        id: 'missing-value-match',
        kind: 'pair',
        keyMatch: { matchType: 'exact', matchValue: 'status', caseSensitive: false },
        style: BOLD,
      } as unknown as FormattingRule;

      const result = evaluateFormattingRules(
        [set([missingKeyMatchRule, missingValueMatchRule])],
        node({ key: 'status', valueText: 'ok', valueKind: 'string' }),
      );
      expect(result).toBe(EMPTY_RULE_RESULT);
    });

    it('pair rule with unknown predicate is skipped without throwing', () => {
      const unknownPredicateRule = pairRule({
        valueMatch: { kind: 'predicate', predicate: 'is_date' as ValuePredicate },
        style: BOLD,
      });

      const result = evaluateFormattingRules(
        [set([unknownPredicateRule])],
        node({ key: 'status', valueText: '2026-01-01', valueKind: 'string' }),
      );
      expect(result).toBe(EMPTY_RULE_RESULT);
    });
  });

  describe('icon projection', () => {
    it('latest icon wins when two rules both project icons', () => {
      const r1 = rule({ id: 'r1', matchValue: 'foo', style: { icon: 'warning' } });
      const r2 = rule({ id: 'r2', matchValue: 'foo', style: { icon: 'error' } });
      const result = evaluateFormattingRules([set([r1, r2])], node({ key: 'foo' }));
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
        style: { icon: 'check' },
      });
      const result = evaluateFormattingRules([set([r])], node({ key: 'status', valueText: '200' }));
      expect(result.valueStyle.icon).toBe('check');
      expect(result.keyStyle.icon).toBeUndefined();
    });
  });

  describe('performance baseline', () => {
    it('evaluates 10 rules over 1,000 nodes in well under 50 ms', () => {
      const rules: FormattingRule[] = Array.from({ length: 10 }, (_, i) =>
        rule({ id: `r${i}`, matchValue: `marker-${i}`, style: BOLD }),
      );
      const sets = [set(rules)];
      const nodes: RuleEngineNode[] = Array.from({ length: 1000 }, (_, i) =>
        node({ key: `key-${i % 50}`, valueText: `val-${i}` }),
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
    expect(describeRule(rule({ target: 'key', matchType: 'contains', matchValue: 'error' }))).toBe(
      'key contains "error"',
    );
  });

  it('renders a value-target exact rule', () => {
    expect(describeRule(rule({ target: 'value', matchType: 'exact', matchValue: '200' }))).toBe(
      'value exact "200"',
    );
  });

  it('renders a key_and_value-target starts_with rule', () => {
    expect(
      describeRule(rule({ target: 'key_and_value', matchType: 'starts_with', matchValue: 'x_' })),
    ).toBe('key or value starts_with "x_"');
  });

  it('renders a pair rule as key and value descriptions joined by AND', () => {
    expect(
      describeRule(
        pairRule({
          keyMatch: { matchType: 'exact', matchValue: 'testHeader', caseSensitive: false },
          valueMatch: { kind: 'predicate', predicate: 'is_not_null' },
        }),
      ),
    ).toBe('key exact "testHeader" AND value is_not_null');
  });

  it('annotates case-sensitive rules', () => {
    expect(
      describeRule(
        rule({ target: 'key', matchType: 'ends_with', matchValue: '_id', caseSensitive: true }),
      ),
    ).toBe('key ends_with "_id" (case-sensitive)');
  });

  it('escapes embedded quotes in matchValue', () => {
    expect(describeRule(rule({ matchValue: 'foo"bar' }))).toBe('key contains "foo\\"bar"');
  });

  it('handles an empty matchValue without throwing', () => {
    expect(describeRule(rule({ matchValue: '' }))).toBe('key contains ""');
  });
});
