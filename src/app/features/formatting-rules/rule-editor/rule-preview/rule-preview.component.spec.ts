import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';

import { RulePreviewComponent } from './rule-preview.component';
import { JsonTreeComponent } from '../../../../shared/components/json-tree/json-tree.component';
import type {
  FormattingRule,
  FormattingRuleSet
} from '../../../../core/api/models';
import { provideFakeAuth } from '../../../../../testing/auth.testing';

function rule(overrides: Partial<FormattingRule> = {}): FormattingRule {
  return {
    id: 'r1',
    target: 'value',
    matchType: 'contains',
    matchValue: 'TypeError',
    caseSensitive: false,
    style: { backgroundColor: '#ffcdd2' },
    ...overrides
  };
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
    ...overrides
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
        { provide: MatSnackBar, useValue: { open: jasmine.createSpy('open') } }
      ]
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
      (el) => el.componentInstance instanceof JsonTreeComponent
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
      (el) => el.componentInstance instanceof JsonTreeComponent
    ).componentInstance as JsonTreeComponent;
    const override = tree.overrideRuleSets();
    expect(override).not.toBeNull();
    expect(override!.length).toBe(1);
    expect(override![0].name).toBe('Initial');
  });

  it('updates the override when the draft Input changes', async () => {
    await create(ruleSet({ name: 'Before' }));
    const tree = fixture.debugElement.query(
      (el) => el.componentInstance instanceof JsonTreeComponent
    ).componentInstance as JsonTreeComponent;
    expect(tree.overrideRuleSets()![0].name).toBe('Before');

    const updated = ruleSet({
      name: 'After',
      rules: [rule({ matchValue: 'message' })]
    });
    fixture.componentRef.setInput('draft', updated);
    fixture.detectChanges();

    const next = tree.overrideRuleSets();
    expect(next![0].name).toBe('After');
    expect(next![0].rules[0].matchValue).toBe('message');
  });

  it('binds embeddedMode=true on the inner JsonTreeComponent (M6d-3-fu2)', async () => {
    await create(ruleSet());
    const tree = fixture.debugElement.query(
      (el) => el.componentInstance instanceof JsonTreeComponent
    ).componentInstance as JsonTreeComponent;
    expect(tree.embeddedMode()).toBeTrue();
  });
});
