import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import {
  attachFixtureToBody,
  expectNoStrictA11yViolations,
  getOverlayContainerElement,
} from '../../../testing/a11y';
import { provideFakeAuth } from '../../../testing/auth.testing';
import type { FormattingRuleSet, RuleSetPreset } from '../../core/api/models';
import { RuleSetsService } from '../../core/api/rule-sets.service';
import { PreferencesService } from '../../core/preferences/preferences.service';
import { FormattingRulesComponent } from './formatting-rules.component';

/**
 * Wave 3a shell-landmark coverage plus Wave 3e strict overlay scans for
 * the /formatting-rules route. Full route-level axe coverage remains scoped
 * to the contrast / forms remediation waves.
 */
describe('FormattingRulesComponent (a11y shell landmarks)', () => {
  let teardown: (() => void) | undefined;

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

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

  function configure(listResult: FormattingRuleSet[] | Error): void {
    const cache = signal<FormattingRuleSet[] | null>(
      listResult instanceof Error ? null : listResult,
    );
    const defaults = signal<string[]>([]);
    const stub = {
      ruleSets: cache.asReadonly(),
      activeRuleSetIds: defaults.asReadonly(),
      list: jasmine
        .createSpy('list')
        .mockImplementation(() =>
          listResult instanceof Error ? throwError(() => listResult) : of(listResult),
        ),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      refresh: vi.fn(),
      toggleActive: vi.fn(),
    };
    const prefsSig = signal<{ activeRuleSetIds: string[] }>({ activeRuleSetIds: [] });
    const syncStateSig = signal<'synced'>('synced');
    const preferences = {
      prefs: prefsSig.asReadonly(),
      syncState: syncStateSig.asReadonly(),
      update: vi.fn(),
    };
    const dialog = {
      open: vi.fn().mockReturnValue({ afterClosed: () => of(undefined) }),
    };
    const snack = { open: vi.fn() };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [FormattingRulesComponent],
      providers: [
        ...provideFakeAuth(),
        provideRouter([]),
        provideNoopAnimations(),
        { provide: RuleSetsService, useValue: stub },
        { provide: PreferencesService, useValue: preferences },
        { provide: MatDialog, useValue: dialog },
        { provide: MatSnackBar, useValue: snack },
      ],
    });
  }

  function configureOverlay(listResult: FormattingRuleSet[]): void {
    const cache = signal<FormattingRuleSet[] | null>(listResult);
    const defaults = signal<string[]>([]);
    const stub = {
      ruleSets: cache.asReadonly(),
      activeRuleSetIds: defaults.asReadonly(),
      list: vi.fn().mockReturnValue(of(listResult)),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockReturnValue(of(undefined)),
      get: vi.fn(),
      refresh: vi.fn(),
      toggleActive: vi.fn(),
      listPresets: vi.fn().mockReturnValue(of([preset()])),
      clonePreset: jasmine
        .createSpy('clonePreset')
        .mockReturnValue(of(ruleSet({ id: 'cloned-1' }))),
    };
    const prefsSig = signal<{ activeRuleSetIds: string[] }>({ activeRuleSetIds: [] });
    const syncStateSig = signal<'synced'>('synced');
    const preferences = {
      prefs: prefsSig.asReadonly(),
      syncState: syncStateSig.asReadonly(),
      update: vi.fn(),
    };
    const snack = { open: vi.fn() };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [FormattingRulesComponent, MatDialogModule],
      providers: [
        ...provideFakeAuth(),
        provideRouter([]),
        provideNoopAnimations(),
        { provide: RuleSetsService, useValue: stub },
        { provide: PreferencesService, useValue: preferences },
        { provide: MatSnackBar, useValue: snack },
      ],
    });
  }

  async function settle(fixture: {
    detectChanges: () => void;
    whenStable: () => Promise<unknown>;
  }) {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('renders <main id="main-content"> with tabindex="-1" so the skip-link can focus it', () => {
    configure([]);
    const fixture = TestBed.createComponent(FormattingRulesComponent);
    fixture.detectChanges();
    const main = fixture.nativeElement.querySelector('main#main-content') as HTMLElement | null;
    expect(
      main,
      'every route must expose <main id="main-content"> for the app-header skip-link',
    ).not.toBeNull();
    expect(
      main?.getAttribute('tabindex'),
      'non-interactive <main> needs tabindex="-1" so RouteFocusService can focus it',
    ).toBe('-1');
  });

  it('renders an <h1> inside <main> for screen-reader page identification', () => {
    configure([]);
    const fixture = TestBed.createComponent(FormattingRulesComponent);
    fixture.detectChanges();
    const heading = fixture.nativeElement.querySelector(
      'main#main-content h1',
    ) as HTMLElement | null;
    expect(
      heading,
      'every route should expose a top-level <h1> for SR page identification',
    ).not.toBeNull();
    expect(
      heading?.textContent?.trim().length,
      'the <h1> must have non-empty content',
    ).toBeGreaterThan(0);
  });

  it('has no critical or serious violations with the delete confirmation open', async () => {
    const sets = [ruleSet({ name: 'Errors' })];
    configureOverlay(sets);
    const fixture = TestBed.createComponent(FormattingRulesComponent);
    teardown = attachFixtureToBody(fixture);
    await settle(fixture);

    void fixture.componentInstance.deleteSet(sets[0]);
    fixture.detectChanges();
    await fixture.whenStable();

    await expectNoStrictA11yViolations(fixture, {
      target: getOverlayContainerElement(),
    });

    TestBed.inject(MatDialog).closeAll();
  });

  it('has no critical or serious violations with the clone-preset dialog open', async () => {
    configureOverlay([]);
    const fixture = TestBed.createComponent(FormattingRulesComponent);
    teardown = attachFixtureToBody(fixture);
    await settle(fixture);

    void fixture.componentInstance.openClonePresetDialog();
    fixture.detectChanges();
    await fixture.whenStable();

    await expectNoStrictA11yViolations(fixture, {
      target: getOverlayContainerElement(),
    });

    TestBed.inject(MatDialog).closeAll();
  });
});
