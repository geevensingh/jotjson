import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';

import { RulePreviewComponent } from './rule-preview.component';
import { JsonTreeComponent } from '../../../../shared/components/json-tree/json-tree.component';
import type {
  FormattingRule,
  FormattingRulePair,
  FormattingRuleSet,
  FormattingRuleSimple,
} from '../../../../core/api/models';
import { provideFakeAuth } from '../../../../../testing/auth.testing';

function rule(overrides: Partial<FormattingRuleSimple> = {}): FormattingRuleSimple {
  return {
    id: 'r1',
    kind: 'simple',
    target: 'value',
    matchType: 'contains',
    matchValue: 'TypeError',
    caseSensitive: false,
    style: { backgroundColor: '#ffcdd2' },
    ...overrides,
  };
}

function pairRule(overrides: Partial<FormattingRulePair> = {}): FormattingRulePair {
  return {
    id: 'pair-1',
    kind: 'pair',
    keyMatch: {
      matchType: 'exact',
      matchValue: 'testHeader',
      caseSensitive: false,
    },
    valueMatch: { kind: 'predicate', predicate: 'is_not_null' },
    style: { textColor: '#123456', bold: true },
    ...overrides,
  };
}

function unknownRule(): FormattingRule {
  return {
    id: 'future-rule',
    kind: 'future',
    style: { textColor: '#ffffff' },
  } as unknown as FormattingRule;
}

function expectSimpleRule(value: FormattingRule | undefined): FormattingRuleSimple {
  expect(value).toBeTruthy();
  expect(value!.kind ?? 'simple').toBe('simple');
  return value as FormattingRuleSimple;
}

function ruleSet(overrides: Partial<FormattingRuleSet> = {}): FormattingRuleSet {
  return {
    id: 'rs-1',
    userId: 'oid-1',
    name: 'Draft',
    rules: [rule()],
    version: 1,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('RulePreviewComponent', () => {
  let fixture: ComponentFixture<RulePreviewComponent>;

  async function create(draft: FormattingRuleSet): Promise<void> {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [RulePreviewComponent],
      providers: [
        ...provideFakeAuth(),
        { provide: MatSnackBar, useValue: { open: jasmine.createSpy('open') } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(RulePreviewComponent);
    fixture.componentRef.setInput('draft', draft);
    fixture.detectChanges();
  }

  it('renders the production JsonTreeComponent with sample JSON', async () => {
    await create(ruleSet());
    const treeEl = fixture.nativeElement.querySelector('jj-json-tree') as HTMLElement | null;
    expect(treeEl).not.toBeNull();
    const treeDebug = fixture.debugElement.query(
      (el) => el.componentInstance instanceof JsonTreeComponent,
    );
    expect(treeDebug).toBeTruthy();
    const tree = treeDebug.componentInstance as JsonTreeComponent;
    const sample = tree.value() as Record<string, unknown>;
    expect(sample).toBeTruthy();
    expect(typeof sample).toBe('object');
    expect('error' in sample).toBeTrue();
    expect('status' in sample).toBeTrue();
    // M6d-3-fu4: a key whose value is the same token as the key, so
    // a single `target: 'key_and_value'` rule highlights both sides.
    expect(sample['errorType']).toBe('error');
  });

  it('forwards the draft as a one-element overrideRuleSets array', async () => {
    const draft = ruleSet({ name: 'Initial' });
    await create(draft);
    const tree = fixture.debugElement.query(
      (el) => el.componentInstance instanceof JsonTreeComponent,
    ).componentInstance as JsonTreeComponent;
    const override = tree.overrideRuleSets();
    expect(override).not.toBeNull();
    expect(override!.length).toBe(1);
    expect(override![0].name).toBe('Initial');
  });

  it('updates the override when the draft Input changes', async () => {
    await create(ruleSet({ name: 'Before' }));
    const tree = fixture.debugElement.query(
      (el) => el.componentInstance instanceof JsonTreeComponent,
    ).componentInstance as JsonTreeComponent;
    expect(tree.overrideRuleSets()![0].name).toBe('Before');

    const updated = ruleSet({
      name: 'After',
      rules: [rule({ matchValue: 'message' })],
    });
    fixture.componentRef.setInput('draft', updated);
    fixture.detectChanges();

    const next = tree.overrideRuleSets();
    expect(next![0].name).toBe('After');
    expect(expectSimpleRule(next![0].rules[0]).matchValue).toBe('message');
  });

  it('binds embeddedMode=true on the inner JsonTreeComponent (M6d-3-fu2)', async () => {
    await create(ruleSet());
    const tree = fixture.debugElement.query(
      (el) => el.componentInstance instanceof JsonTreeComponent,
    ).componentInstance as JsonTreeComponent;
    expect(tree.embeddedMode()).toBeTrue();
  });

  it('includes pair-rule sample fields for predicate preview coverage', async () => {
    await create(ruleSet());
    const tree = fixture.debugElement.query(
      (el) => el.componentInstance instanceof JsonTreeComponent,
    ).componentInstance as JsonTreeComponent;
    const sample = tree.value() as Record<string, unknown>;
    expect(sample['testHeader']).toBe('present');
    expect(sample['testHeaderNull']).toBeNull();
  });

  it('projects pair-rule inline style to both key and value tokens when both sides match', async () => {
    await create(ruleSet({ rules: [pairRule()] }));
    const tree = fixture.debugElement.query(
      (el) => el.componentInstance instanceof JsonTreeComponent,
    ).componentInstance as JsonTreeComponent;
    const node = findSampleNode(tree, 'testHeader');
    const vars = tree.ruleStyleVars(node);
    expect(vars?.['--tree-key-color']).toBe('#123456');
    expect(vars?.['--tree-value-color']).toBe('#123456');
    expect(vars?.['--tree-key-weight']).toBe('700');
    expect(vars?.['--tree-value-weight']).toBe('700');
  });

  it('does not project pair-rule style when only the key side matches', async () => {
    await create(
      ruleSet({
        rules: [
          pairRule({
            keyMatch: {
              matchType: 'exact',
              matchValue: 'testHeaderNull',
              caseSensitive: false,
            },
            valueMatch: { kind: 'predicate', predicate: 'is_not_null' },
          }),
        ],
      }),
    );
    const tree = fixture.debugElement.query(
      (el) => el.componentInstance instanceof JsonTreeComponent,
    ).componentInstance as JsonTreeComponent;
    const node = findSampleNode(tree, 'testHeaderNull');
    expect(tree.ruleStyleVars(node)).toBeNull();
  });

  it('skips unknown future rule kinds in preview contrast checks without crashing', async () => {
    await create(ruleSet({ rules: [unknownRule()] }));
    expect(fixture.componentInstance.contrastFailures()).toEqual([]);
  });

  function findSampleNode(tree: JsonTreeComponent, key: string) {
    const root = tree.root();
    expect(root).toBeTruthy();
    const node = root!.children!.find((child) => child.segment === key);
    expect(node).withContext(`expected sample to contain key "${key}"`).toBeTruthy();
    return node!;
  }

  describe('contrast warning (M6g-3)', () => {
    it('hides the banner when every rule passes AA in both themes', async () => {
      await create(
        ruleSet({
          rules: [
            rule({
              id: 'r1',
              matchValue: 'ok',
              style: { textColor: '#000000', backgroundColor: '#ffffff' },
            }),
          ],
        }),
      );
      const banner = fixture.nativeElement.querySelector('[data-testid="contrast-warning"]');
      expect(banner).toBeNull();
      expect(fixture.componentInstance.contrastFailures()).toEqual([]);
    });

    it('hides the banner for rules with no color contributions (border only)', async () => {
      await create(
        ruleSet({
          rules: [
            rule({
              id: 'r1',
              matchValue: 'ok',
              // borderColor is decorative; no fg/bg set means the rule
              // does not affect contrast and must not be flagged.
              style: { borderColor: '#888888' },
            }),
          ],
        }),
      );
      expect(fixture.componentInstance.contrastFailures()).toEqual([]);
      const banner = fixture.nativeElement.querySelector('[data-testid="contrast-warning"]');
      expect(banner).toBeNull();
    });

    it('flags a rule that fails AA in the light theme only', async () => {
      // White text + no bg: light theme bg = #fafafa -> ratio ~ 1.04 (fail).
      // Dark theme bg = #1e1e1e -> ratio ~ 17.4 (pass).
      await create(
        ruleSet({
          rules: [
            rule({
              id: 'r-white-text',
              matchValue: 'whiteOnLight',
              style: { textColor: '#ffffff' },
            }),
          ],
        }),
      );
      const failures = fixture.componentInstance.contrastFailures();
      expect(failures.length).toBe(1);
      expect(failures[0].ruleId).toBe('r-white-text');
      expect(failures[0].failsLight).toBeTrue();
      expect(failures[0].failsDark).toBeFalse();
      const themes = fixture.nativeElement.querySelector('.contrast-warning-themes') as HTMLElement;
      expect(themes.textContent?.trim()).toBe('fails in light theme');
    });

    it('flags a rule that fails AA in the dark theme only', async () => {
      // Near-black text + no bg: dark theme bg = #1e1e1e -> ratio ~ 1.04 (fail).
      // Light theme bg = #fafafa -> ratio ~ 19+ (pass).
      await create(
        ruleSet({
          rules: [
            rule({
              id: 'r-black-text',
              matchValue: 'darkOnDark',
              style: { textColor: '#000000' },
            }),
          ],
        }),
      );
      const failures = fixture.componentInstance.contrastFailures();
      expect(failures.length).toBe(1);
      expect(failures[0].failsLight).toBeFalse();
      expect(failures[0].failsDark).toBeTrue();
      const themes = fixture.nativeElement.querySelector('.contrast-warning-themes') as HTMLElement;
      expect(themes.textContent?.trim()).toBe('fails in dark theme');
    });

    it('flags a rule that fails AA in both themes when fg and bg are both set close together', async () => {
      await create(
        ruleSet({
          rules: [
            rule({
              id: 'r-both',
              matchValue: 'mid',
              style: { textColor: '#888888', backgroundColor: '#999999' },
            }),
          ],
        }),
      );
      const failures = fixture.componentInstance.contrastFailures();
      expect(failures.length).toBe(1);
      expect(failures[0].failsLight).toBeTrue();
      expect(failures[0].failsDark).toBeTrue();
      const themes = fixture.nativeElement.querySelector('.contrast-warning-themes') as HTMLElement;
      expect(themes.textContent?.trim()).toBe('fails in light and dark');
    });

    it('renders a singular summary when exactly one rule fails', async () => {
      await create(
        ruleSet({
          rules: [
            rule({
              id: 'r1',
              matchValue: 'one',
              style: { textColor: '#ffffff' },
            }),
          ],
        }),
      );
      const summary = fixture.nativeElement.querySelector(
        '.contrast-warning-summary .contrast-warning-text',
      ) as HTMLElement;
      expect(summary.textContent?.trim()).toContain('1 rule may be hard to read');
    });

    it('renders a plural summary when multiple rules fail', async () => {
      await create(
        ruleSet({
          rules: [
            rule({
              id: 'r1',
              matchValue: 'a',
              style: { textColor: '#ffffff' },
            }),
            rule({
              id: 'r2',
              matchValue: 'b',
              style: { textColor: '#000000' },
            }),
          ],
        }),
      );
      const summary = fixture.nativeElement.querySelector(
        '.contrast-warning-summary .contrast-warning-text',
      ) as HTMLElement;
      expect(summary.textContent?.trim()).toContain('2 rules may be hard to read');
      const items = fixture.nativeElement.querySelectorAll('.contrast-warning-item');
      expect(items.length).toBe(2);
    });

    it('truncates long match values to 30 chars with ellipsis', async () => {
      const longValue = 'this-is-a-rather-long-match-value-that-should-be-truncated';
      await create(
        ruleSet({
          rules: [
            rule({
              id: 'r1',
              matchValue: longValue,
              style: { textColor: '#ffffff' },
            }),
          ],
        }),
      );
      const failures = fixture.componentInstance.contrastFailures();
      expect(failures.length).toBe(1);
      expect(failures[0].label.length).toBeLessThanOrEqual(30);
      expect(failures[0].label.endsWith('...')).toBeTrue();
      const label = fixture.nativeElement.querySelector('.contrast-warning-label') as HTMLElement;
      expect(label.textContent?.trim()).toBe(failures[0].label);
    });

    it('replaces empty/whitespace match values with "(empty)" in the label', async () => {
      await create(
        ruleSet({
          rules: [
            rule({
              id: 'r1',
              matchValue: '   ',
              style: { textColor: '#ffffff' },
            }),
          ],
        }),
      );
      const failures = fixture.componentInstance.contrastFailures();
      expect(failures[0].label).toBe('(empty)');
    });

    it('skips rules with malformed hex (in-flight typed input) without crashing', async () => {
      // The user might briefly have invalid colors while typing. The
      // preview's contrast banner must stay silent rather than throw.
      await create(
        ruleSet({
          rules: [
            rule({
              id: 'r-typing',
              matchValue: 'wip',
              style: { backgroundColor: '#abc' },
            }),
          ],
        }),
      );
      expect(fixture.componentInstance.contrastFailures()).toEqual([]);
      const banner = fixture.nativeElement.querySelector('[data-testid="contrast-warning"]');
      expect(banner).toBeNull();
    });
  });
});
