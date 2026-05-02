import {
  RuleSetValidationError,
  RuleSetVersionConflictError,
  assertRule,
  assertRuleSetPayload,
  assertStyle,
  createRuleSet,
  deleteRuleSetById,
  findRuleSetById,
  listRuleSetsByOwner,
  readRuleSet,
  replaceRuleSet,
  __resetRuleSetsContainerForTesting,
  type FormattingRulePair,
  type FormattingRuleSimple,
  type RuleSetDocument,
  type ValuePredicate,
} from './ruleSets';

interface FakeContainer {
  items: RuleSetDocument[];
  failNextRead?: { code: number };
}

let fake: FakeContainer;

jest.mock('./cosmos', () => {
  return {
    getCosmos: () => ({
      database: {
        container: () => ({
          items: {
            query: ({
              query,
              parameters,
            }: {
              query: string;
              parameters: { name: string; value: unknown }[];
            }) => ({
              fetchAll: async () => {
                const params = Object.fromEntries(parameters.map((p) => [p.name, p.value]));
                if (/c\.userId = @userId/.test(query)) {
                  const userId = params['@userId'];
                  const resources = fake.items
                    .filter((r) => r.userId === userId)
                    .slice()
                    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
                  return { resources };
                }
                if (/c\.id = @id/.test(query)) {
                  const id = params['@id'];
                  const resources = fake.items.filter((r) => r.id === id);
                  return { resources };
                }
                throw new Error(`Unexpected query: ${query}`);
              },
            }),
            create: async (doc: RuleSetDocument) => {
              fake.items.push(doc);
              return { resource: doc };
            },
          },
          item: (id: string, partitionKey: string) => ({
            read: async () => {
              if (fake.failNextRead) {
                const err = fake.failNextRead;
                delete fake.failNextRead;
                throw err;
              }
              const found = fake.items.find((r) => r.id === id && r.userId === partitionKey);
              return { resource: found ?? null };
            },
            replace: async (next: RuleSetDocument) => {
              const idx = fake.items.findIndex((r) => r.id === id && r.userId === partitionKey);
              if (idx === -1) throw Object.assign(new Error('not found'), { code: 404 });
              fake.items[idx] = next;
              return { resource: next };
            },
            delete: async () => {
              const idx = fake.items.findIndex((r) => r.id === id && r.userId === partitionKey);
              if (idx === -1) throw Object.assign(new Error('not found'), { code: 404 });
              fake.items.splice(idx, 1);
              return { resource: undefined };
            },
          }),
        }),
      },
    }),
  };
});

beforeEach(() => {
  fake = { items: [] };
  __resetRuleSetsContainerForTesting();
});

const VALUE_PREDICATES: readonly ValuePredicate[] = [
  'is_null',
  'is_not_null',
  'is_empty',
  'is_not_empty',
  'is_string',
  'is_not_string',
  'is_number',
  'is_not_number',
  'is_integer',
  'is_not_integer',
  'is_boolean',
  'is_not_boolean',
  'is_object',
  'is_not_object',
  'is_array',
  'is_not_array',
] as const;

function validRule(overrides: Partial<FormattingRuleSimple> = {}): FormattingRuleSimple {
  return {
    id: 'r1',
    target: 'key',
    matchType: 'contains',
    matchValue: 'error',
    caseSensitive: false,
    style: { backgroundColor: '#ffeb3b' },
    ...overrides,
  };
}

function validPairRule(overrides: Partial<FormattingRulePair> = {}): FormattingRulePair {
  return {
    id: 'pair-1',
    kind: 'pair',
    keyMatch: {
      matchType: 'exact',
      matchValue: 'status',
      caseSensitive: false,
    },
    valueMatch: {
      kind: 'text',
      matchType: 'exact',
      matchValue: '500',
      caseSensitive: false,
    },
    style: { backgroundColor: '#ffeb3b' },
    ...overrides,
  };
}

describe('assertStyle', () => {
  it('accepts an empty style object', () => {
    expect(assertStyle({}, 'style')).toEqual({});
  });

  it('normalizes hex colors to lowercase', () => {
    expect(assertStyle({ backgroundColor: '#FFEB3B', textColor: '#1A2B3C' }, 'style')).toEqual({
      backgroundColor: '#ffeb3b',
      textColor: '#1a2b3c',
    });
  });

  it('rejects malformed hex colors', () => {
    expect(() => assertStyle({ backgroundColor: 'red' }, 'style')).toThrow(RuleSetValidationError);
  });

  it('rejects unknown style fields', () => {
    expect(() => assertStyle({ glow: true }, 'style')).toThrow(/unknown field/);
  });

  it('rejects icons not in the whitelist', () => {
    expect(() => assertStyle({ icon: 'rocket' }, 'style')).toThrow(/icon/);
  });

  it('accepts each whitelisted icon', () => {
    for (const icon of ['warning', 'check', 'star', 'info', 'error', 'flag', 'bookmark']) {
      expect(assertStyle({ icon }, 'style').icon).toBe(icon);
    }
  });

  it('rejects a non-object style', () => {
    expect(() => assertStyle('nope', 'style')).toThrow(/object/);
  });
});

describe('assertRule', () => {
  it('accepts a valid legacy rule without kind', () => {
    expect(assertRule(validRule(), 'rule')).toEqual(validRule());
  });

  it('accepts an explicit simple kind', () => {
    const rule = validRule({ kind: 'simple' });
    expect(assertRule(rule, 'rule')).toEqual(rule);
  });

  it('rejects invalid rule kinds', () => {
    for (const invalidKind of ['unknown', '', 42, null]) {
      expect(() => assertRule({ ...validRule(), kind: invalidKind }, 'rule')).toThrow(/rule.kind/);
    }
  });

  it('accepts a pair rule with text valueMatch', () => {
    const rule = validPairRule();
    expect(assertRule(rule, 'rule')).toEqual(rule);
  });

  it('accepts each predicate valueMatch on a pair rule', () => {
    for (const predicate of VALUE_PREDICATES) {
      const rule = validPairRule({
        id: `pair-${predicate}`,
        valueMatch: { kind: 'predicate', predicate },
      });
      expect(assertRule(rule, 'rule')).toEqual(rule);
    }
  });

  it('rejects legacy simple fields on pair rules', () => {
    const legacyFields: ReadonlyArray<readonly [string, unknown]> = [
      ['target', 'key'],
      ['matchType', 'contains'],
      ['matchValue', 'error'],
      ['caseSensitive', false],
    ];

    for (const [fieldName, fieldValue] of legacyFields) {
      expect(() => assertRule({ ...validPairRule(), [fieldName]: fieldValue }, 'rule')).toThrow(
        new RegExp(`unknown field "${fieldName}"`),
      );
    }
  });

  it('rejects pair fields on simple rules', () => {
    const pairFields: ReadonlyArray<readonly [string, unknown]> = [
      ['keyMatch', validPairRule().keyMatch],
      ['valueMatch', validPairRule().valueMatch],
    ];

    for (const [fieldName, fieldValue] of pairFields) {
      expect(() => assertRule({ ...validRule(), [fieldName]: fieldValue }, 'rule')).toThrow(
        new RegExp(`unknown field "${fieldName}"`),
      );
      expect(() =>
        assertRule({ ...validRule({ kind: 'simple' }), [fieldName]: fieldValue }, 'rule'),
      ).toThrow(new RegExp(`unknown field "${fieldName}"`));
    }
  });

  it('rejects pair rules missing keyMatch or valueMatch', () => {
    expect(() =>
      assertRule(
        {
          id: 'pair-1',
          kind: 'pair',
          valueMatch: validPairRule().valueMatch,
          style: { backgroundColor: '#ffeb3b' },
        },
        'rule',
      ),
    ).toThrow(/keyMatch.*object/);

    expect(() =>
      assertRule(
        {
          id: 'pair-1',
          kind: 'pair',
          keyMatch: validPairRule().keyMatch,
          style: { backgroundColor: '#ffeb3b' },
        },
        'rule',
      ),
    ).toThrow(/valueMatch.*object/);
  });

  it('rejects pair rules with unknown valueMatch kind', () => {
    expect(() =>
      assertRule(
        {
          ...validPairRule(),
          valueMatch: { kind: 'number', predicate: 'is_number' },
        },
        'rule',
      ),
    ).toThrow(/valueMatch.kind/);
  });

  it('rejects pair rules with unknown predicates', () => {
    expect(() =>
      assertRule(
        {
          ...validPairRule(),
          valueMatch: { kind: 'predicate', predicate: 'is_date' },
        },
        'rule',
      ),
    ).toThrow(/valueMatch.predicate/);
  });

  it('rejects empty matchValue in pair key and text value matches', () => {
    expect(() =>
      assertRule(
        {
          ...validPairRule(),
          keyMatch: { ...validPairRule().keyMatch, matchValue: '' },
        },
        'rule',
      ),
    ).toThrow(/keyMatch.matchValue.*non-empty/);

    expect(() =>
      assertRule(
        {
          ...validPairRule(),
          valueMatch: { kind: 'text', matchType: 'exact', matchValue: '', caseSensitive: false },
        },
        'rule',
      ),
    ).toThrow(/valueMatch.matchValue.*non-empty/);
  });

  it('rejects matchValue over the cap in pair key and text value matches', () => {
    const tooLong = 'x'.repeat(201);

    expect(() =>
      assertRule(
        {
          ...validPairRule(),
          keyMatch: { ...validPairRule().keyMatch, matchValue: tooLong },
        },
        'rule',
      ),
    ).toThrow(/keyMatch.matchValue.*max 200/);

    expect(() =>
      assertRule(
        {
          ...validPairRule(),
          valueMatch: {
            kind: 'text',
            matchType: 'exact',
            matchValue: tooLong,
            caseSensitive: false,
          },
        },
        'rule',
      ),
    ).toThrow(/valueMatch.matchValue.*max 200/);
  });

  it('rejects extra fields in pair rule shapes', () => {
    expect(() => assertRule({ ...validPairRule(), extra: true }, 'rule')).toThrow(
      /unknown field "extra"/,
    );

    expect(() =>
      assertRule(
        {
          ...validPairRule(),
          keyMatch: { ...validPairRule().keyMatch, extra: true },
        },
        'rule',
      ),
    ).toThrow(/keyMatch.*unknown field "extra"/);

    expect(() =>
      assertRule(
        {
          ...validPairRule(),
          valueMatch: { ...validPairRule().valueMatch, extra: true },
        },
        'rule',
      ),
    ).toThrow(/valueMatch.*unknown field "extra"/);
  });

  it('rejects text fields on predicate valueMatch', () => {
    expect(() =>
      assertRule(
        {
          ...validPairRule(),
          valueMatch: { kind: 'predicate', predicate: 'is_null', matchValue: 'null' },
        },
        'rule',
      ),
    ).toThrow(/valueMatch.*unknown field "matchValue"/);

    expect(() =>
      assertRule(
        {
          ...validPairRule(),
          valueMatch: { kind: 'predicate', predicate: 'is_null', matchType: 'exact' },
        },
        'rule',
      ),
    ).toThrow(/valueMatch.*unknown field "matchType"/);
  });

  it('rejects regex match-type (deferred to v1.1)', () => {
    expect(() => assertRule(validRule({ matchType: 'regex' as never }), 'rule')).toThrow(
      /matchType/,
    );
  });

  it('rejects an empty matchValue', () => {
    expect(() => assertRule(validRule({ matchValue: '' }), 'rule')).toThrow(/non-empty/);
  });

  it('rejects matchValue longer than the cap', () => {
    expect(() => assertRule(validRule({ matchValue: 'x'.repeat(201) }), 'rule')).toThrow(/max 200/);
  });

  it('accepts matchValue at exactly MAX_RULE_MATCH_VALUE_LENGTH chars', () => {
    const exact = 'x'.repeat(200);
    expect(assertRule(validRule({ matchValue: exact }), 'rule')).toEqual(
      validRule({ matchValue: exact }),
    );
  });

  it('rejects unknown rule fields', () => {
    const bad = { ...validRule(), tag: 'x' };
    expect(() => assertRule(bad, 'rule')).toThrow(/unknown field/);
  });

  it('rejects an empty id', () => {
    expect(() => assertRule(validRule({ id: '' }), 'rule')).toThrow(/id/);
  });

  it('rejects unknown target values', () => {
    expect(() => assertRule(validRule({ target: 'both' as never }), 'rule')).toThrow(/target/);
  });
});

describe('assertRuleSetPayload', () => {
  it('trims whitespace from name', () => {
    const out = assertRuleSetPayload({ name: '  Errors  ', rules: [] });
    expect(out.name).toBe('Errors');
  });

  it('rejects blank name', () => {
    expect(() => assertRuleSetPayload({ name: '   ', rules: [] })).toThrow(/blank/);
  });

  it('rejects name longer than 80 chars', () => {
    expect(() => assertRuleSetPayload({ name: 'x'.repeat(81), rules: [] })).toThrow(/max 80/);
  });

  it('accepts name at exactly MAX_RULE_SET_NAME_LENGTH chars', () => {
    const exact = 'x'.repeat(80);
    const out = assertRuleSetPayload({ name: exact, rules: [] });
    expect(out.name).toBe(exact);
  });

  it('rejects rules that is not an array', () => {
    expect(() => assertRuleSetPayload({ name: 'x', rules: {} })).toThrow(/array/);
  });

  it('rejects more than 50 rules', () => {
    const rules = Array.from({ length: 51 }, (_, i) => validRule({ id: `r${i}` }));
    expect(() => assertRuleSetPayload({ name: 'x', rules })).toThrow(/max 50/);
  });

  it('rejects more than 50 mixed simple and pair rules', () => {
    const rules = Array.from({ length: 51 }, (_, index) =>
      index % 2 === 0
        ? validRule({ id: `simple-${index}` })
        : validPairRule({ id: `pair-${index}` }),
    );
    expect(() => assertRuleSetPayload({ name: 'x', rules })).toThrow(/max 50/);
  });

  it('accepts exactly MAX_RULES_PER_SET rules', () => {
    const rules = Array.from({ length: 50 }, (_, i) => validRule({ id: `r${i}` }));
    const out = assertRuleSetPayload({ name: 'x', rules });
    expect(out.rules).toHaveLength(50);
  });

  it('rejects duplicate rule ids', () => {
    expect(() =>
      assertRuleSetPayload({
        name: 'x',
        rules: [validRule({ id: 'r1' }), validRule({ id: 'r1' })],
      }),
    ).toThrow(/Duplicate rule id/);
  });

  it('rejects unknown payload fields', () => {
    expect(() => assertRuleSetPayload({ name: 'x', rules: [], extra: 1 })).toThrow(
      /Unknown field "extra"/,
    );
  });

  it('passes a valid payload through', () => {
    const out = assertRuleSetPayload({ name: 'Errors', rules: [validRule()] });
    expect(out).toEqual({ name: 'Errors', rules: [validRule()] });
  });

  it('passes mixed simple and pair rules through', () => {
    const simpleRule = validRule({ id: 'simple-1' });
    const pairRule = validPairRule({ id: 'pair-1' });
    const out = assertRuleSetPayload({ name: 'Mixed', rules: [simpleRule, pairRule] });
    expect(out).toEqual({ name: 'Mixed', rules: [simpleRule, pairRule] });
  });
});

describe('repository', () => {
  it('createRuleSet stamps id, version=1, and timestamps', async () => {
    const before = Date.now();
    const doc = await createRuleSet('u-1', { name: 'Errors', rules: [validRule()] });
    expect(doc.userId).toBe('u-1');
    expect(doc.name).toBe('Errors');
    expect(doc.version).toBe(1);
    expect(doc.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(doc.createdAt).getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(doc.createdAt).toBe(doc.updatedAt);
    expect(fake.items).toHaveLength(1);
  });

  it('listRuleSetsByOwner sorts by createdAt ascending', async () => {
    fake.items = [
      makeStored('a', 'u-1', '2026-01-03T00:00:00Z'),
      makeStored('b', 'u-1', '2026-01-01T00:00:00Z'),
      makeStored('c', 'u-1', '2026-01-02T00:00:00Z'),
      makeStored('z', 'other-user', '2026-01-01T00:00:00Z'),
    ];
    const got = await listRuleSetsByOwner('u-1');
    expect(got.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('listRuleSetsByOwner returns [] for empty userId', async () => {
    expect(await listRuleSetsByOwner('')).toEqual([]);
  });

  it('readRuleSet returns the doc when partition matches', async () => {
    fake.items = [makeStored('a', 'u-1', '2026-01-01T00:00:00Z')];
    expect(await readRuleSet('a', 'u-1')).not.toBeNull();
  });

  it('readRuleSet returns null on 404 from cosmos', async () => {
    fake.failNextRead = { code: 404 };
    expect(await readRuleSet('missing', 'u-1')).toBeNull();
  });

  it('readRuleSet rethrows non-404 cosmos errors', async () => {
    fake.failNextRead = { code: 500 };
    await expect(readRuleSet('a', 'u-1')).rejects.toMatchObject({ code: 500 });
  });

  it('findRuleSetById matches across partitions', async () => {
    fake.items = [makeStored('a', 'someone-else', '2026-01-01T00:00:00Z')];
    const found = await findRuleSetById('a');
    expect(found?.userId).toBe('someone-else');
  });

  it('replaceRuleSet bumps version, refreshes updatedAt, preserves createdAt', async () => {
    const stored = makeStored('a', 'u-1', '2026-01-01T00:00:00Z');
    fake.items = [stored];
    const next = await replaceRuleSet(
      stored,
      { name: 'Renamed', rules: [validRule({ id: 'r2' })] },
      1,
    );
    expect(next.version).toBe(2);
    expect(next.createdAt).toBe('2026-01-01T00:00:00Z');
    expect(next.updatedAt).not.toBe('2026-01-01T00:00:00Z');
    expect(next.name).toBe('Renamed');
  });

  it('replaceRuleSet throws RuleSetVersionConflictError on version mismatch', async () => {
    const stored = makeStored('a', 'u-1', '2026-01-01T00:00:00Z');
    fake.items = [stored];
    await expect(replaceRuleSet(stored, { name: 'x', rules: [] }, 999)).rejects.toBeInstanceOf(
      RuleSetVersionConflictError,
    );
    // No mutation when the precondition fails.
    expect(fake.items[0]?.version).toBe(1);
  });

  it('deleteRuleSetById returns true when the doc was removed', async () => {
    fake.items = [makeStored('a', 'u-1', '2026-01-01T00:00:00Z')];
    expect(await deleteRuleSetById('a', 'u-1')).toBe(true);
    expect(fake.items).toHaveLength(0);
  });

  it('deleteRuleSetById returns false on 404', async () => {
    expect(await deleteRuleSetById('missing', 'u-1')).toBe(false);
  });
});

function makeStored(id: string, userId: string, createdAt: string): RuleSetDocument {
  return {
    id,
    userId,
    name: `Set ${id}`,
    rules: [],
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
}
