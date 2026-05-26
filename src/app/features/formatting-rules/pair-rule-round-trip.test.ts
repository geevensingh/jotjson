import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, Subject } from 'rxjs';

import { type MockInstance } from 'vitest';
import { provideFakeAuth, signInFakeUser } from '../../../testing/auth.testing';
import type {
  FormattingRule,
  FormattingRulePair,
  FormattingRuleSet,
  FormattingRuleSimple,
  FormattingStyle,
  RuleSetPayload,
  ValuePredicate,
} from '../../core/api/models';
import { RuleSetsService } from '../../core/api/rule-sets.service';
import { AuthService } from '../../core/auth/auth.service';
import {
  EMPTY_RULE_RESULT,
  describeRule,
  evaluateFormattingRules,
  type RuleEngineNode,
  type RuleEngineResult,
} from '../../shared/components/json-tree/formatting-rules-engine';
import {
  JsonTreeComponent,
  type TreeNode,
} from '../../shared/components/json-tree/json-tree.component';
import { RuleEditorComponent } from './rule-editor/rule-editor.component';

const PREFERENCES_STORAGE_KEY = 'jotjson.preferences.v1';
const TREE_SEARCH_STORAGE_KEY = 'jotjson.treeSearch.v1';
const PAIR_TEXT_COLOR = '#ff0000';
const PAIR_STYLE: FormattingStyle = { textColor: PAIR_TEXT_COLOR };
const TEST_HEADER_HAS_CONTENT_BACKGROUND = '#ffcdd2';
const TEST_HEADER_LACKS_CONTENT_BACKGROUND = '#c8e6c9';
const TEST_HEADER_SPELLINGS = ['test-header', 'testHeader', 'test_header'] as const;

type TestHeaderSpelling = (typeof TEST_HEADER_SPELLINGS)[number];

interface EditorSetupOptions {
  initialCache?: FormattingRuleSet[] | null;
  paramId?: string;
}

interface EditorSetup {
  fixture: ComponentFixture<RuleEditorComponent>;
  service: {
    ruleSets: () => FormattingRuleSet[] | null;
    get: MockInstance;
    update: MockInstance;
    updateSubjects: Subject<FormattingRuleSet>[];
    getSubjects: Subject<FormattingRuleSet>[];
    events$: Subject<{ kind: 'conflict' | 'error'; id: string; status?: number }>;
    pendingWriteIds: () => ReadonlySet<string>;
  };
}

interface TreeSetup {
  fixture: ComponentFixture<JsonTreeComponent>;
  component: JsonTreeComponent;
}

function ruleSet(overrides: Partial<FormattingRuleSet> = {}): FormattingRuleSet {
  return {
    id: 'round-trip-set',
    userId: 'oid-1',
    name: 'Round trip set',
    rules: [],
    version: 1,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function simpleRule(overrides: Partial<FormattingRuleSimple> = {}): FormattingRuleSimple {
  return {
    id: 'rule-1',
    kind: 'simple',
    target: 'value',
    matchType: 'exact',
    matchValue: 'foo',
    caseSensitive: false,
    style: { textColor: '#111111' },
    ...overrides,
  };
}

function pairRule(overrides: Partial<FormattingRulePair> = {}): FormattingRulePair {
  return {
    id: 'pair-rule-1',
    kind: 'pair',
    keyMatch: { matchType: 'exact', matchValue: 'testHeader', caseSensitive: false },
    valueMatch: { kind: 'predicate', predicate: 'is_not_null' },
    style: { ...PAIR_STYLE },
    ...overrides,
  };
}

function predicatePairRule(
  predicate: ValuePredicate,
  overrides: Partial<FormattingRulePair> = {},
): FormattingRulePair {
  return pairRule({
    keyMatch: { matchType: 'contains', matchValue: 'field', caseSensitive: false },
    valueMatch: { kind: 'predicate', predicate },
    ...overrides,
  });
}

function testHeaderContentRule(
  ruleId: string,
  keyMatchValue: TestHeaderSpelling,
  predicate: ValuePredicate,
  backgroundColor: string,
): FormattingRulePair {
  return {
    id: ruleId,
    kind: 'pair',
    keyMatch: { matchType: 'exact', matchValue: keyMatchValue, caseSensitive: false },
    valueMatch: { kind: 'predicate', predicate },
    style: { backgroundColor },
  };
}

const TEST_HEADER_CONTENT_RULES: readonly FormattingRulePair[] = [
  testHeaderContentRule(
    'kebab-has',
    'test-header',
    'has_content',
    TEST_HEADER_HAS_CONTENT_BACKGROUND,
  ),
  testHeaderContentRule(
    'kebab-lacks',
    'test-header',
    'lacks_content',
    TEST_HEADER_LACKS_CONTENT_BACKGROUND,
  ),
  testHeaderContentRule(
    'camel-has',
    'testHeader',
    'has_content',
    TEST_HEADER_HAS_CONTENT_BACKGROUND,
  ),
  testHeaderContentRule(
    'camel-lacks',
    'testHeader',
    'lacks_content',
    TEST_HEADER_LACKS_CONTENT_BACKGROUND,
  ),
  testHeaderContentRule(
    'snake-has',
    'test_header',
    'has_content',
    TEST_HEADER_HAS_CONTENT_BACKGROUND,
  ),
  testHeaderContentRule(
    'snake-lacks',
    'test_header',
    'lacks_content',
    TEST_HEADER_LACKS_CONTENT_BACKGROUND,
  ),
];

function testHeaderDocument(value: unknown): Record<TestHeaderSpelling, unknown> {
  return {
    'test-header': value,
    testHeader: value,
    test_header: value,
  };
}

function futureRule(): FormattingRule {
  // Test-only cast simulates a stale tab receiving a future rule kind.
  return {
    id: 'future-rule',
    kind: 'unknown_future_kind',
    style: { ...PAIR_STYLE },
  } as unknown as FormattingRule;
}

function expectSimpleRule(rule: FormattingRule | undefined): FormattingRuleSimple {
  if (!rule) {
    throw new Error('Expected a formatting rule.');
  }
  expect(rule.kind ?? 'simple').toBe('simple');
  return rule as FormattingRuleSimple;
}

function expectPairRule(rule: FormattingRule | undefined): FormattingRulePair {
  if (!rule) {
    throw new Error('Expected a formatting rule.');
  }
  expect(rule.kind).toBe('pair');
  return rule as FormattingRulePair;
}

function firstEditableRule(component: RuleEditorComponent): FormattingRule {
  const rules = component.editable()?.rules;
  const firstRule = rules?.[0];
  if (!firstRule) {
    throw new Error('Expected the editor to contain at least one rule.');
  }
  return firstRule;
}

function requiredSubject<T>(subjects: Subject<T>[], index: number, label: string): Subject<T> {
  const subject = subjects[index];
  if (!subject) {
    throw new Error(`Expected ${label} subject at index ${index}.`);
  }
  return subject;
}

function setupEditor(options: EditorSetupOptions = {}): EditorSetup {
  TestBed.resetTestingModule();
  const cache = signal<FormattingRuleSet[] | null>(
    options.initialCache === undefined ? null : options.initialCache,
  );
  const paramMap = new BehaviorSubject(
    convertToParamMap({ id: options.paramId ?? 'round-trip-set' }),
  );
  const updateSubjects: Subject<FormattingRuleSet>[] = [];
  const getSubjects: Subject<FormattingRuleSet>[] = [];
  const events$ = new Subject<{ kind: 'conflict' | 'error'; id: string; status?: number }>();
  const pendingIds = signal<ReadonlySet<string>>(new Set());
  const service = {
    ruleSets: cache.asReadonly(),
    pendingWriteIds: pendingIds.asReadonly(),
    events$,
    get: vi.fn().mockImplementation(() => {
      const subject = new Subject<FormattingRuleSet>();
      getSubjects.push(subject);
      return subject.asObservable();
    }),
    update: vi.fn().mockImplementation(() => {
      const subject = new Subject<FormattingRuleSet>();
      updateSubjects.push(subject);
      return subject.asObservable();
    }),
  };

  TestBed.configureTestingModule({
    imports: [RuleEditorComponent],
    providers: [
      ...provideFakeAuth(),
      provideRouter([]),
      { provide: RuleSetsService, useValue: service },
      { provide: MatSnackBar, useValue: { open: vi.fn() } },
      { provide: ActivatedRoute, useValue: { paramMap } },
    ],
  });

  signInFakeUser(TestBed.inject(AuthService), {
    user: { id: 'oid-1', displayName: 'Test User', email: 'user@example.com' },
  });

  const fixture = TestBed.createComponent(RuleEditorComponent);
  return {
    fixture,
    service: {
      ...service,
      updateSubjects,
      getSubjects,
    },
  };
}

function loadedEditor(initialRuleSet: FormattingRuleSet): EditorSetup {
  const editorSetup = setupEditor({ initialCache: [initialRuleSet] });
  editorSetup.fixture.detectChanges();
  return editorSetup;
}

function setupTree(value: unknown, rules: readonly FormattingRule[]): TreeSetup {
  TestBed.resetTestingModule();
  const activeSet = ruleSet({ rules: Array.from(rules) });
  const activeRuleSets = signal<FormattingRuleSet[]>([]);
  const ruleSets = signal<FormattingRuleSet[] | null>([activeSet]);
  const activeRuleSetIds = signal<readonly string[]>([]);
  const ruleSetsService = {
    ruleSets: ruleSets.asReadonly(),
    activeRuleSets: activeRuleSets.asReadonly(),
    activeRuleSetIds: activeRuleSetIds.asReadonly(),
  };

  TestBed.configureTestingModule({
    imports: [JsonTreeComponent],
    providers: [
      ...provideFakeAuth(),
      { provide: RuleSetsService, useValue: ruleSetsService },
      { provide: MatSnackBar, useValue: { open: vi.fn() } },
    ],
  });

  const fixture = TestBed.createComponent(JsonTreeComponent);
  fixture.componentRef.setInput('value', value);
  fixture.componentRef.setInput('overrideRuleSets', [activeSet]);
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance };
}

function rootChildren(component: JsonTreeComponent): readonly TreeNode[] {
  const root = component.root();
  if (!root?.children) {
    throw new Error('Expected the JSON tree root to have children.');
  }
  return root.children;
}

function findTreeNode(component: JsonTreeComponent, key: string): TreeNode {
  const matchingNode = rootChildren(component).find((child) => child.segment === key);
  if (!matchingNode) {
    throw new Error(`Expected sample tree to contain key ${key}.`);
  }
  return matchingNode;
}

function resultForKey(component: JsonTreeComponent, key: string): RuleEngineResult {
  return component.ruleResultFor(findTreeNode(component, key));
}

function expectMatched(component: JsonTreeComponent, key: string): RuleEngineResult {
  const result = resultForKey(component, key);
  expect(result, `${key} should match`).not.toBe(EMPTY_RULE_RESULT);
  return result;
}

function expectNotMatched(component: JsonTreeComponent, key: string): void {
  expect(resultForKey(component, key), `${key} should not match`).toBe(EMPTY_RULE_RESULT);
}

function expectPairInlineStyle(result: RuleEngineResult): void {
  expect(result.keyStyle.color).toBe(PAIR_TEXT_COLOR);
  expect(result.valueStyle.color).toBe(PAIR_TEXT_COLOR);
}

function expectRowBackground(
  component: JsonTreeComponent,
  key: string,
  expectedBackgroundColor: string,
  context: string,
): RuleEngineResult {
  const result = expectMatched(component, key);
  expect(result.rowStyle.backgroundColor, `${context} row background`).toBe(
    expectedBackgroundColor,
  );
  expect(result.matchedRules.length, `${context} matched rule count`).toBe(1);
  return result;
}

function expectSingleMatchedRuleTooltip(component: JsonTreeComponent, key: string): void {
  const node = findTreeNode(component, key);
  const result = component.ruleResultFor(node);
  expect(result.matchedRules.length, `${key} matched rule count`).toBe(1);
  const matchedRuleTitle = component.matchedRuleTitle(node);
  expect(matchedRuleTitle, `${key} matched rule title`).not.toBeNull();
  expect(matchedRuleTitle ?? '', `${key} matched rule title`).not.toContain('\n');
}

function engineNode(overrides: Partial<RuleEngineNode> = {}): RuleEngineNode {
  return {
    key: 'field',
    valueText: null,
    isContainer: false,
    valueKind: null,
    isEmpty: false,
    ...overrides,
  };
}

const TRUTH_TABLE_NODES: readonly { name: string; node: RuleEngineNode }[] = [
  { name: 'nullValue', node: engineNode({ valueText: 'null', valueKind: 'null' }) },
  { name: 'stringValue', node: engineNode({ valueText: 'text', valueKind: 'string' }) },
  { name: 'emptyString', node: engineNode({ valueText: '', valueKind: 'string' }) },
  { name: 'whitespaceString', node: engineNode({ valueText: '   ', valueKind: 'string' }) },
  { name: 'numberValue', node: engineNode({ valueText: '1.5', valueKind: 'number' }) },
  { name: 'integerValue', node: engineNode({ valueText: '42', valueKind: 'integer' }) },
  { name: 'trueValue', node: engineNode({ valueText: 'true', valueKind: 'boolean' }) },
  { name: 'falseValue', node: engineNode({ valueText: 'false', valueKind: 'boolean' }) },
  {
    name: 'arrayValue',
    node: engineNode({ valueKind: 'array', isContainer: true, isEmpty: false }),
  },
  {
    name: 'emptyArray',
    node: engineNode({ valueKind: 'array', isContainer: true, isEmpty: true }),
  },
  {
    name: 'objectValue',
    node: engineNode({ valueKind: 'object', isContainer: true, isEmpty: false }),
  },
  {
    name: 'emptyObject',
    node: engineNode({ valueKind: 'object', isContainer: true, isEmpty: true }),
  },
];

function allTruthTableNamesExcept(excludedNames: readonly string[]): string[] {
  const excluded = new Set(excludedNames);
  return TRUTH_TABLE_NODES.map((entry) => entry.name).filter((name) => !excluded.has(name));
}

describe('pair rule editor and engine round trip', () => {
  beforeEach(() => {
    localStorage.removeItem(PREFERENCES_STORAGE_KEY);
    localStorage.removeItem(TREE_SEARCH_STORAGE_KEY);
  });

  afterEach(() => {
    localStorage.removeItem(PREFERENCES_STORAGE_KEY);
    localStorage.removeItem(TREE_SEARCH_STORAGE_KEY);
  });

  describe('editor selector mode drafts and mocked persistence', () => {
    it('restores simple and pair drafts across selectorMode toggles', () => {
      const editorSetup = loadedEditor(ruleSet({ rules: [simpleRule()] }));
      const component = editorSetup.fixture.componentInstance;

      expect(component.selectorModeFor(firstEditableRule(component))).toBe('value');

      component.setSelectorMode(0, 'pair');
      component.patchPairKeyMatch(0, { matchValue: 'testHeader' });
      component.setPairValueMatchMode(0, 'predicate');
      component.setPairPredicate(0, 'is_not_null');
      const editedPairRule = expectPairRule(firstEditableRule(component));
      expect(editedPairRule.keyMatch).toEqual({
        matchType: 'exact',
        matchValue: 'testHeader',
        caseSensitive: false,
      });
      expect(editedPairRule.valueMatch).toEqual({ kind: 'predicate', predicate: 'is_not_null' });

      component.setSelectorMode(0, 'value');
      const restoredSimpleRule = expectSimpleRule(firstEditableRule(component));
      expect(restoredSimpleRule.target).toBe('value');
      expect(restoredSimpleRule.matchType).toBe('exact');
      expect(restoredSimpleRule.matchValue).toBe('foo');
      expect(restoredSimpleRule.caseSensitive).toBe(false);

      component.setSelectorMode(0, 'pair');
      const restoredPairRule = expectPairRule(firstEditableRule(component));
      expect(restoredPairRule.keyMatch).toEqual({
        matchType: 'exact',
        matchValue: 'testHeader',
        caseSensitive: false,
      });
      expect(restoredPairRule.valueMatch).toEqual({ kind: 'predicate', predicate: 'is_not_null' });
    });

    it('saves a pair rule, reloads it through the mocked service, and evaluates it', async () => {
      const firstEditorSetup = loadedEditor(
        ruleSet({ rules: [simpleRule({ style: { ...PAIR_STYLE } })] }),
      );
      const firstComponent = firstEditorSetup.fixture.componentInstance;

      firstComponent.setSelectorMode(0, 'pair');
      firstComponent.patchPairKeyMatch(0, { matchValue: 'testHeader' });
      firstComponent.setPairValueMatchMode(0, 'predicate');
      firstComponent.setPairPredicate(0, 'is_not_null');
      // Real-time wait for the 600ms editor debounce. Vitest's
      // fakeAsync zone does not drain native Promise.then chains
      // (the rule-editor uses `await firstValueFrom(...)`), so we
      // wait on a real timer and a vi.waitFor below.
      await new Promise((resolve) => setTimeout(resolve, 700));
      firstEditorSetup.fixture.detectChanges();

      await vi.waitFor(() => expect(firstEditorSetup.service.update).toHaveBeenCalledTimes(1));
      const savePayloadCall =
        firstEditorSetup.service.update.mock.calls[
          firstEditorSetup.service.update.mock.calls.length - 1
        ];
      const savePayload = savePayloadCall[1] as RuleSetPayload;
      const savedPairRule = expectPairRule(savePayload.rules[0]);
      expect(savedPairRule.keyMatch.matchValue).toBe('testHeader');
      expect(savedPairRule.valueMatch).toEqual({ kind: 'predicate', predicate: 'is_not_null' });

      const savedRuleSet = ruleSet({ rules: savePayload.rules, version: 2 });
      const updateSubject = requiredSubject(firstEditorSetup.service.updateSubjects, 0, 'update');
      updateSubject.next(savedRuleSet);
      updateSubject.complete();
      await Promise.resolve();
      firstEditorSetup.fixture.destroy();

      const secondEditorSetup = setupEditor({ initialCache: [] });
      secondEditorSetup.fixture.detectChanges();
      const getSubject = requiredSubject(secondEditorSetup.service.getSubjects, 0, 'get');
      getSubject.next(savedRuleSet);
      getSubject.complete();
      // Wait for the second editor to load the rule (its `get(id)` flow
      // uses `await firstValueFrom(...)`). Drain microtasks and CD until
      // the rule is editable.
      await vi.waitFor(() => {
        secondEditorSetup.fixture.detectChanges();
        expect(
          secondEditorSetup.fixture.componentInstance.editable()?.rules.length ?? 0,
        ).toBeGreaterThan(0);
      });
      secondEditorSetup.fixture.detectChanges();

      const reloadedPairRule = expectPairRule(
        firstEditableRule(secondEditorSetup.fixture.componentInstance),
      );
      expect(reloadedPairRule.keyMatch).toEqual(savedPairRule.keyMatch);
      expect(reloadedPairRule.valueMatch).toEqual(savedPairRule.valueMatch);

      const engineResult = evaluateFormattingRules(
        [savedRuleSet],
        engineNode({ key: 'testHeader', valueText: 'v1', valueKind: 'string' }),
      );
      expectPairInlineStyle(engineResult);
    });
  });

  describe('engine behavior on real JSON tree nodes', () => {
    it('matches testHeader with is_not_null and styles both key and value', () => {
      const treeSetup = setupTree({ testHeader: 'v1', otherKey: null, thirdKey: 'stillHere' }, [
        pairRule(),
      ]);

      const matchingResult = expectMatched(treeSetup.component, 'testHeader');
      expectPairInlineStyle(matchingResult);
      expectNotMatched(treeSetup.component, 'otherKey');
      expectNotMatched(treeSetup.component, 'thirdKey');
    });

    it('matches otherKey with is_null and rejects non-null testHeader', () => {
      const treeSetup = setupTree({ testHeader: 'v1', otherKey: null, thirdKey: 'stillHere' }, [
        pairRule({
          keyMatch: { matchType: 'exact', matchValue: 'otherKey', caseSensitive: false },
          valueMatch: { kind: 'predicate', predicate: 'is_null' },
        }),
      ]);

      const matchingResult = expectMatched(treeSetup.component, 'otherKey');
      expectPairInlineStyle(matchingResult);
      expectNotMatched(treeSetup.component, 'testHeader');
      expectNotMatched(treeSetup.component, 'thirdKey');
    });
  });

  describe('null and string predicate distinctions', () => {
    it('matches JSON null but not the string null for is_null', () => {
      const treeSetup = setupTree({ fieldA: null, fieldB: 'null' }, [
        predicatePairRule('is_null', {
          keyMatch: { matchType: 'starts_with', matchValue: 'field', caseSensitive: false },
        }),
      ]);

      expectMatched(treeSetup.component, 'fieldA');
      expectNotMatched(treeSetup.component, 'fieldB');
    });

    it('matches the string null but not JSON null for is_string', () => {
      const treeSetup = setupTree({ fieldA: null, fieldB: 'null' }, [
        predicatePairRule('is_string', {
          keyMatch: { matchType: 'starts_with', matchValue: 'field', caseSensitive: false },
        }),
      ]);

      expectNotMatched(treeSetup.component, 'fieldA');
      expectMatched(treeSetup.component, 'fieldB');
    });
  });

  describe('number and integer predicate distinctions', () => {
    it('matches only non-integer numbers for is_number', () => {
      const treeSetup = setupTree({ intField: 42, floatField: 1.5, strField: '42' }, [
        predicatePairRule('is_number', {
          keyMatch: { matchType: 'contains', matchValue: 'Field', caseSensitive: false },
        }),
      ]);

      expectNotMatched(treeSetup.component, 'intField');
      expectMatched(treeSetup.component, 'floatField');
      expectNotMatched(treeSetup.component, 'strField');
    });

    it('matches only integers for is_integer', () => {
      const treeSetup = setupTree({ intField: 42, floatField: 1.5, strField: '42' }, [
        predicatePairRule('is_integer', {
          keyMatch: { matchType: 'contains', matchValue: 'Field', caseSensitive: false },
        }),
      ]);

      expectMatched(treeSetup.component, 'intField');
      expectNotMatched(treeSetup.component, 'floatField');
      expectNotMatched(treeSetup.component, 'strField');
    });
  });

  describe('empty predicate truth table', () => {
    it('matches the empty string, empty array, and empty object for is_empty', () => {
      const treeSetup = setupTree(
        {
          fieldEmptyStr: '',
          fieldEmptyArr: [],
          fieldEmptyObj: {},
          fieldWs: '   ',
          fieldZero: 0,
          fieldFalse: false,
          fieldNul: null,
        },
        [predicatePairRule('is_empty')],
      );

      expectMatched(treeSetup.component, 'fieldEmptyStr');
      expectMatched(treeSetup.component, 'fieldEmptyArr');
      expectMatched(treeSetup.component, 'fieldEmptyObj');
    });

    it('does not treat whitespace, zero, false, or null as empty', () => {
      const treeSetup = setupTree(
        {
          fieldEmptyStr: '',
          fieldEmptyArr: [],
          fieldEmptyObj: {},
          fieldWs: '   ',
          fieldZero: 0,
          fieldFalse: false,
          fieldNul: null,
        },
        [predicatePairRule('is_empty')],
      );

      expectNotMatched(treeSetup.component, 'fieldWs');
      expectNotMatched(treeSetup.component, 'fieldZero');
      expectNotMatched(treeSetup.component, 'fieldFalse');
      expectNotMatched(treeSetup.component, 'fieldNul');
    });
  });

  describe('full predicate truth table', () => {
    it('evaluates every predicate and inverse predicate against representative nodes', () => {
      const predicateCases: readonly {
        predicate: ValuePredicate;
        matchingNames: readonly string[];
      }[] = [
        { predicate: 'is_null', matchingNames: ['nullValue'] },
        { predicate: 'is_not_null', matchingNames: allTruthTableNamesExcept(['nullValue']) },
        { predicate: 'is_empty', matchingNames: ['emptyString', 'emptyArray', 'emptyObject'] },
        {
          predicate: 'is_not_empty',
          matchingNames: allTruthTableNamesExcept(['emptyString', 'emptyArray', 'emptyObject']),
        },
        {
          predicate: 'is_string',
          matchingNames: ['stringValue', 'emptyString', 'whitespaceString'],
        },
        {
          predicate: 'is_not_string',
          matchingNames: allTruthTableNamesExcept([
            'stringValue',
            'emptyString',
            'whitespaceString',
          ]),
        },
        { predicate: 'is_number', matchingNames: ['numberValue'] },
        { predicate: 'is_not_number', matchingNames: allTruthTableNamesExcept(['numberValue']) },
        { predicate: 'is_integer', matchingNames: ['integerValue'] },
        { predicate: 'is_not_integer', matchingNames: allTruthTableNamesExcept(['integerValue']) },
        { predicate: 'is_boolean', matchingNames: ['trueValue', 'falseValue'] },
        {
          predicate: 'is_not_boolean',
          matchingNames: allTruthTableNamesExcept(['trueValue', 'falseValue']),
        },
        { predicate: 'is_object', matchingNames: ['objectValue', 'emptyObject'] },
        {
          predicate: 'is_not_object',
          matchingNames: allTruthTableNamesExcept(['objectValue', 'emptyObject']),
        },
        { predicate: 'is_array', matchingNames: ['arrayValue', 'emptyArray'] },
        {
          predicate: 'is_not_array',
          matchingNames: allTruthTableNamesExcept(['arrayValue', 'emptyArray']),
        },
      ];

      for (const predicateCase of predicateCases) {
        const activeSet = ruleSet({
          rules: [
            pairRule({
              keyMatch: { matchType: 'exact', matchValue: 'field', caseSensitive: false },
              valueMatch: { kind: 'predicate', predicate: predicateCase.predicate },
            }),
          ],
        });
        const actualNames = TRUTH_TABLE_NODES.filter(
          (entry) => evaluateFormattingRules([activeSet], entry.node) !== EMPTY_RULE_RESULT,
        ).map((entry) => entry.name);

        expect(actualNames, predicateCase.predicate).toEqual(predicateCase.matchingNames);
      }
    });
  });

  describe('test-header-content preset', () => {
    it('paints null and empty values green for all test-header spellings', () => {
      const greenCases: readonly { label: string; value: unknown }[] = [
        { label: 'null', value: null },
        { label: 'empty string', value: '' },
        { label: 'empty array', value: [] },
        { label: 'empty object', value: {} },
      ];

      for (const testCase of greenCases) {
        const treeSetup = setupTree(testHeaderDocument(testCase.value), TEST_HEADER_CONTENT_RULES);

        for (const key of TEST_HEADER_SPELLINGS) {
          expectRowBackground(
            treeSetup.component,
            key,
            TEST_HEADER_LACKS_CONTENT_BACKGROUND,
            `${testCase.label} ${key}`,
          );
        }

        if (testCase.value === null) {
          expectSingleMatchedRuleTooltip(treeSetup.component, 'testHeader');
        }
      }
    });

    it('paints content values red for all test-header spellings', () => {
      const redCases: readonly { label: string; value: unknown }[] = [
        { label: 'whitespace string', value: '   ' },
        { label: 'non-empty string', value: 'hello' },
        { label: 'positive number', value: 42 },
        { label: 'zero', value: 0 },
        { label: 'true', value: true },
        { label: 'false', value: false },
        { label: 'non-empty array', value: [1, 2] },
        { label: 'non-empty object', value: { x: 1 } },
      ];

      for (const testCase of redCases) {
        const treeSetup = setupTree(testHeaderDocument(testCase.value), TEST_HEADER_CONTENT_RULES);

        for (const key of TEST_HEADER_SPELLINGS) {
          expectRowBackground(
            treeSetup.component,
            key,
            TEST_HEADER_HAS_CONTENT_BACKGROUND,
            `${testCase.label} ${key}`,
          );
        }
      }
    });

    it('matches test-header keys case-insensitively', () => {
      const treeSetup = setupTree(
        {
          'Test-Header': 'hello',
          TESTHEADER: 'hello',
          TestHeader: 'hello',
        },
        TEST_HEADER_CONTENT_RULES,
      );

      for (const key of ['Test-Header', 'TESTHEADER', 'TestHeader'] as const) {
        expectRowBackground(
          treeSetup.component,
          key,
          TEST_HEADER_HAS_CONTENT_BACKGROUND,
          `${key} case-insensitive match`,
        );
      }
    });
  });

  describe('stale tab defensive handling', () => {
    it('skips an unknown future rule kind without throwing or matching', () => {
      const unknownKindRule = futureRule();
      const activeSet = ruleSet({ rules: [unknownKindRule] });
      let result: RuleEngineResult = EMPTY_RULE_RESULT;

      expect(() => {
        result = evaluateFormattingRules(
          [activeSet],
          engineNode({ key: 'field', valueText: 'text', valueKind: 'string' }),
        );
      }).not.toThrow();
      expect(result).toBe(EMPTY_RULE_RESULT);
      expect(() => describeRule(unknownKindRule)).not.toThrow();
    });

    it('lets editor labels and validity inspect unknown future rule kinds without throwing', () => {
      const unknownKindRule = futureRule();
      const editorSetup = loadedEditor(ruleSet({ rules: [unknownKindRule] }));
      const component = editorSetup.fixture.componentInstance;

      expect(() => component.ruleLabel(unknownKindRule)).not.toThrow();
      expect(component.ruleLabel(unknownKindRule)).toBe('Unknown rule (skipped)');
      expect(() => component.isKnownRule(unknownKindRule)).not.toThrow();
      expect(() => component.selectorModeFor(unknownKindRule)).not.toThrow();
      expect(() => component.validity()).not.toThrow();
    });
  });
});
