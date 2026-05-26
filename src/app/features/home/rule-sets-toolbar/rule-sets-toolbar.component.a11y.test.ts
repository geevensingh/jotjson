import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { of } from 'rxjs';

import {
  attachFixtureToBody,
  expectNoStrictA11yViolations,
  getOverlayContainerElement,
} from '../../../../testing/a11y';
import { provideFakeAuth, signInFakeUser } from '../../../../testing/auth.testing';
import type { FormattingRuleSet, RuleSetPreset } from '../../../core/api/models';
import { RuleSetsService } from '../../../core/api/rule-sets.service';
import { AuthService } from '../../../core/auth/auth.service';
import { RuleSetsToolbarComponent } from './rule-sets-toolbar.component';

function ruleSet(overrides: Partial<FormattingRuleSet> = {}): FormattingRuleSet {
  return {
    id: 'rule-set-1',
    userId: 'user-1',
    name: 'Errors',
    rules: [],
    version: 1,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function preset(overrides: Partial<RuleSetPreset> = {}): RuleSetPreset {
  return {
    id: 'preset-1',
    name: 'Error detection',
    rules: [],
    ...overrides,
  };
}

describe('RuleSetsToolbarComponent (a11y overlays)', () => {
  let teardown: (() => void) | undefined;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    const cache = signal<FormattingRuleSet[] | null>([ruleSet()]);
    const activeIds = signal<string[]>([]);
    const ruleSets = {
      ruleSets: cache.asReadonly(),
      activeRuleSetIds: activeIds.asReadonly(),
      list: vi.fn().mockReturnValue(of(cache() ?? [])),
      toggleActive: vi.fn(),
      setActives: vi.fn().mockImplementation((next: string[]) => activeIds.set(next)),
      listPresets: vi.fn().mockReturnValue(of([preset()])),
      clonePreset: vi.fn().mockReturnValue(of(ruleSet({ id: 'cloned-1' }))),
    };

    await TestBed.configureTestingModule({
      imports: [RuleSetsToolbarComponent, MatDialogModule],
      providers: [
        ...provideFakeAuth(),
        provideNoopAnimations(),
        { provide: RuleSetsService, useValue: ruleSets },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
      ],
    }).compileComponents();
    signInFakeUser(TestBed.inject(AuthService));
  });

  afterEach(() => {
    TestBed.inject(MatDialog).closeAll();
    teardown?.();
    teardown = undefined;
  });

  it('has no critical or serious violations with the clone-preset dialog open', async () => {
    const fixture = TestBed.createComponent(RuleSetsToolbarComponent);
    teardown = attachFixtureToBody(fixture);
    fixture.detectChanges();
    await fixture.whenStable();

    const trigger = fixture.nativeElement.querySelector(
      '[data-testid="clone-preset-trigger"]',
    ) as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();
    await fixture.whenStable();

    await expectNoStrictA11yViolations(fixture, {
      target: getOverlayContainerElement(),
    });
  });
});
