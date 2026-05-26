import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatCheckboxHarness } from '@angular/material/checkbox/testing';
import { MatSlideToggleHarness } from '@angular/material/slide-toggle/testing';
import { provideRouter } from '@angular/router';
import { provideFakeAuth } from '../../../testing/auth.testing';
import { FormattingRuleSet, SearchMatchMode, UserPreferences } from '../../core/api/models';
import { RuleSetsService } from '../../core/api/rule-sets.service';
import { AuthUser } from '../../core/auth/auth-user';
import { AuthService } from '../../core/auth/auth.service';
import {
  DEFAULT_PREFERENCES,
  PreferencesService,
} from '../../core/preferences/preferences.service';
import { ProfileComponent } from './profile.component';

type DateAnnotationUnitKey = keyof UserPreferences['treeDateAnnotationUnits'];

interface DateAnnotationUnitCase {
  readonly key: DateAnnotationUnitKey;
  readonly selector: string;
}

const DATE_ANNOTATION_UNIT_CASES: readonly DateAnnotationUnitCase[] = [
  { key: 'year', selector: '[data-date-annotation-unit="year"]' },
  { key: 'month', selector: '[data-date-annotation-unit="month"]' },
  { key: 'day', selector: '[data-date-annotation-unit="day"]' },
  { key: 'hour', selector: '[data-date-annotation-unit="hour"]' },
  { key: 'minute', selector: '[data-date-annotation-unit="minute"]' },
  { key: 'second', selector: '[data-date-annotation-unit="second"]' },
];
const DATE_ANNOTATION_FRIENDLY_FORMS_SELECTOR = '[data-date-annotation-friendly-forms]';

describe('ProfileComponent', () => {
  async function create(overrides?: { user?: AuthUser | null; isConfigured?: boolean }) {
    const userSignal = signal<AuthUser | null>(overrides?.user ?? null);
    const authStub = {
      user: userSignal.asReadonly(),
      isSignedIn: (() => userSignal() !== null) as unknown as AuthService['isSignedIn'],
      isConfigured: overrides?.isConfigured ?? false,
      signIn: vi.fn(),
      signOut: vi.fn(),
    } as unknown as AuthService;

    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ProfileComponent],
      providers: [
        provideRouter([]),
        ...provideFakeAuth(),
        { provide: AuthService, useValue: authStub },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ProfileComponent);
    fixture.detectChanges();
    const prefs = TestBed.inject(PreferencesService);
    return { fixture, authStub, prefs };
  }

  function resetDateAnnotationPrefs(
    fixture: ComponentFixture<ProfileComponent>,
    prefs: PreferencesService,
    treeShowDateAnnotations = true,
  ): void {
    prefs.update({
      treeShowDateAnnotations,
      treeDateAnnotationUnits: { ...DEFAULT_PREFERENCES.treeDateAnnotationUnits },
      treeDateAnnotationFriendlyForms: true,
    });
    fixture.detectChanges();
  }

  async function getSlideToggle(
    fixture: ComponentFixture<ProfileComponent>,
    selector: string,
  ): Promise<MatSlideToggleHarness> {
    const loader = TestbedHarnessEnvironment.loader(fixture);
    return loader.getHarness(MatSlideToggleHarness.with({ selector }));
  }

  async function getUnitCheckbox(
    fixture: ComponentFixture<ProfileComponent>,
    selector: string,
  ): Promise<MatCheckboxHarness> {
    const loader = TestbedHarnessEnvironment.loader(fixture);
    return loader.getHarness(MatCheckboxHarness.with({ selector }));
  }

  async function getDateAnnotationSubControls(
    fixture: ComponentFixture<ProfileComponent>,
  ): Promise<{ isDisabled(): Promise<boolean> }[]> {
    const controls: { isDisabled(): Promise<boolean> }[] = [];
    for (const unitCase of DATE_ANNOTATION_UNIT_CASES) {
      controls.push(await getUnitCheckbox(fixture, unitCase.selector));
    }
    controls.push(await getSlideToggle(fixture, DATE_ANNOTATION_FRIENDLY_FORMS_SELECTOR));
    return controls;
  }

  it('renders the signed-out card when user is anonymous', async () => {
    const { fixture } = await create({ user: null, isConfigured: true });
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('You are signed out');
    expect(text).toContain('Sign in');
  });

  it('disables the sign-in button when auth is not configured', async () => {
    const { fixture } = await create({ user: null, isConfigured: false });
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Sign in (not configured)');
    const button = (fixture.nativeElement as HTMLElement).querySelector('button');
    expect(button?.hasAttribute('disabled')).toBe(true);
  });

  it('renders display name and email when signed in', async () => {
    const { fixture } = await create({
      user: { id: 'oid-1', displayName: 'Ada Lovelace', email: 'ada@example.com' },
      isConfigured: true,
    });
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Ada Lovelace');
    expect(text).toContain('ada@example.com');
    expect(text).toContain('Sign out');
  });

  it('shows "Not provided" fallback when email claim is missing', async () => {
    const { fixture } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: undefined },
      isConfigured: true,
    });
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Not provided');
  });

  it('calls signIn on the sign-in button click', async () => {
    const { fixture, authStub } = await create({ user: null, isConfigured: true });
    fixture.componentInstance.onSignIn();
    expect(authStub.signIn).toHaveBeenCalled();
  });

  it('calls signOut on the sign-out button click', async () => {
    const { fixture, authStub } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    fixture.componentInstance.onSignOut();
    expect(authStub.signOut).toHaveBeenCalled();
  });

  it('renders the preferences card with all group headings when signed in', async () => {
    const { fixture } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Preferences');
    expect(text).toContain('Editor');
    expect(text).toContain('Tree');
    expect(text).toContain('Search');
    expect(text).toContain('Storage');
    expect(text).toContain('Appearance');
  });

  it('does not render the preferences card when signed out', async () => {
    const { fixture } = await create({ user: null, isConfigured: true });
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toContain('Preferences');
  });

  it('writes editor font size through PreferencesService when changed', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    fixture.componentInstance.onEditorFontSizeChange(20);
    expect(prefs.prefs().editorFontSize).toBe(20);
  });

  it('clamps editor font size to the supported range', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    fixture.componentInstance.onEditorFontSizeChange(2);
    expect(prefs.prefs().editorFontSize).toBe(8);
    fixture.componentInstance.onEditorFontSizeChange(99);
    expect(prefs.prefs().editorFontSize).toBe(32);
  });

  it('rejects non-numeric editor font size and keeps the prior value', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    const before = prefs.prefs().editorFontSize;
    fixture.componentInstance.onEditorFontSizeChange('not-a-number');
    expect(prefs.prefs().editorFontSize).toBe(before);
    fixture.componentInstance.onEditorFontSizeChange(null);
    expect(prefs.prefs().editorFontSize).toBe(before);
  });

  it('writes editor tab size through PreferencesService when toggled', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    fixture.componentInstance.onEditorTabSizeChange(4);
    expect(prefs.prefs().editorTabSize).toBe(4);
    fixture.componentInstance.onEditorTabSizeChange(2);
    expect(prefs.prefs().editorTabSize).toBe(2);
  });

  it('writes editor word wrap through PreferencesService when toggled', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    fixture.componentInstance.onEditorWordWrapChange(false);
    expect(prefs.prefs().editorWordWrap).toBe(false);
    fixture.componentInstance.onEditorWordWrapChange(true);
    expect(prefs.prefs().editorWordWrap).toBe(true);
  });

  it('writes default tree expansion depth and clamps to range', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    fixture.componentInstance.onDefaultTreeExpansionDepthChange(5);
    expect(prefs.prefs().defaultTreeExpansionDepth).toBe(5);
    fixture.componentInstance.onDefaultTreeExpansionDepthChange(0);
    expect(prefs.prefs().defaultTreeExpansionDepth).toBe(1);
    fixture.componentInstance.onDefaultTreeExpansionDepthChange(99);
    expect(prefs.prefs().defaultTreeExpansionDepth).toBe(10);
  });

  it('renders the Fit tree to window checkbox', async () => {
    const { fixture } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    const loader = TestbedHarnessEnvironment.loader(fixture);
    const checkbox = await loader.getHarness(
      MatCheckboxHarness.with({ selector: '[data-tree-auto-fit]' }),
    );
    expect(await checkbox.getLabelText()).toContain('Fit tree to window');
  });

  it('checks the Fit tree to window checkbox when treeAutoFitToWindow is true', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    prefs.update({ treeAutoFitToWindow: true });
    fixture.detectChanges();
    const loader = TestbedHarnessEnvironment.loader(fixture);
    const checkbox = await loader.getHarness(
      MatCheckboxHarness.with({ selector: '[data-tree-auto-fit]' }),
    );
    expect(await checkbox.isChecked()).toBe(true);
  });

  it('unchecks the Fit tree to window checkbox when treeAutoFitToWindow is false', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    prefs.update({ treeAutoFitToWindow: false });
    fixture.detectChanges();
    const loader = TestbedHarnessEnvironment.loader(fixture);
    const checkbox = await loader.getHarness(
      MatCheckboxHarness.with({ selector: '[data-tree-auto-fit]' }),
    );
    expect(await checkbox.isChecked()).toBe(false);
  });

  it('writes treeAutoFitToWindow through PreferencesService when toggled', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    fixture.componentInstance.onTreeAutoFitToWindowChange(false);
    expect(prefs.prefs().treeAutoFitToWindow).toBe(false);
    fixture.componentInstance.onTreeAutoFitToWindowChange(true);
    expect(prefs.prefs().treeAutoFitToWindow).toBe(true);
  });

  it('disables the expansion depth slider when treeAutoFitToWindow is true', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    prefs.update({ treeAutoFitToWindow: true });
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector('#pref-expansion-depth') as HTMLInputElement | null;
    expect(input?.disabled).toBe(true);
  });

  it('enables the expansion depth slider when treeAutoFitToWindow is false', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    prefs.update({ treeAutoFitToWindow: false });
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector('#pref-expansion-depth') as HTMLInputElement | null;
    expect(input?.disabled).toBe(false);
  });

  it('writes treeShowTypeLabels through PreferencesService when toggled', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    fixture.componentInstance.onTreeShowTypeLabelsChange(false);
    expect(prefs.prefs().treeShowTypeLabels).toBe(false);
    fixture.componentInstance.onTreeShowTypeLabelsChange(true);
    expect(prefs.prefs().treeShowTypeLabels).toBe(true);
  });

  it('writes treeShowDateAnnotations through PreferencesService when toggled', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    fixture.componentInstance.onTreeShowDateAnnotationsChange(false);
    expect(prefs.prefs().treeShowDateAnnotations).toBe(false);
    fixture.componentInstance.onTreeShowDateAnnotationsChange(true);
    expect(prefs.prefs().treeShowDateAnnotations).toBe(true);
  });

  it('writes treeShowComments through PreferencesService when toggled', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    fixture.componentInstance.onTreeShowCommentsChange(false);
    expect(prefs.prefs().treeShowComments).toBe(false);
    expect(fixture.componentInstance.treeShowComments()).toBe(false);
    fixture.componentInstance.onTreeShowCommentsChange(true);
    expect(prefs.prefs().treeShowComments).toBe(true);
    expect(fixture.componentInstance.treeShowComments()).toBe(true);
  });

  for (const unitCase of DATE_ANNOTATION_UNIT_CASES) {
    it(`writes ${unitCase.key} relative-time unit as a partial patch when clicked`, async () => {
      const { fixture, prefs } = await create({
        user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
        isConfigured: true,
      });
      resetDateAnnotationPrefs(fixture, prefs);
      const updateSpy = vi.spyOn(prefs, 'update');
      const beforeUnits = prefs.prefs().treeDateAnnotationUnits;

      const checkbox = await getUnitCheckbox(fixture, unitCase.selector);
      await checkbox.toggle();

      expect(updateSpy.mock.calls.length).toBe(1);
      const actualPatch: unknown = updateSpy.mock.lastCall![0];
      expect(actualPatch).toEqual({
        treeDateAnnotationUnits: { [unitCase.key]: false },
      });
      expect(prefs.prefs().treeDateAnnotationUnits).toEqual({
        ...beforeUnits,
        [unitCase.key]: false,
      });
    });
  }

  it('writes friendly relative-time forms when clicked', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    resetDateAnnotationPrefs(fixture, prefs);
    const updateSpy = vi.spyOn(prefs, 'update');

    const toggle = await getSlideToggle(fixture, DATE_ANNOTATION_FRIENDLY_FORMS_SELECTOR);
    await toggle.toggle();

    expect(updateSpy.mock.calls.length).toBe(1);
    expect(updateSpy.mock.lastCall![0]).toEqual({
      treeDateAnnotationFriendlyForms: false,
    });
    expect(prefs.prefs().treeDateAnnotationFriendlyForms).toBe(false);
  });

  it('disables all date annotation sub-controls when annotations are off', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    resetDateAnnotationPrefs(fixture, prefs, false);

    const controls = await getDateAnnotationSubControls(fixture);

    for (const control of controls) {
      expect(await control.isDisabled()).toBe(true);
    }
  });

  it('enables all date annotation sub-controls when annotations are on', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    resetDateAnnotationPrefs(fixture, prefs, true);

    const controls = await getDateAnnotationSubControls(fixture);

    for (const control of controls) {
      expect(await control.isDisabled()).toBe(false);
    }
  });

  it('keeps date annotations enabled when all relative-time units are off', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    resetDateAnnotationPrefs(fixture, prefs, true);

    for (const unitCase of DATE_ANNOTATION_UNIT_CASES) {
      const checkbox = await getUnitCheckbox(fixture, unitCase.selector);
      await checkbox.toggle();
    }

    expect(prefs.prefs().treeDateAnnotationUnits).toEqual({
      year: false,
      month: false,
      day: false,
      hour: false,
      minute: false,
      second: false,
    });
    expect(prefs.prefs().treeShowDateAnnotations).toBe(true);
    expect(fixture.componentInstance.treeShowDateAnnotations()).toBe(true);
  });

  it('writes treeAssumeUtcForIsoDateTime/Only through PreferencesService when toggled', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    fixture.componentInstance.onTreeAssumeUtcForIsoDateTimeChange(false);
    expect(prefs.prefs().treeAssumeUtcForIsoDateTime).toBe(false);
    fixture.componentInstance.onTreeAssumeUtcForIsoDateTimeChange(true);
    expect(prefs.prefs().treeAssumeUtcForIsoDateTime).toBe(true);

    fixture.componentInstance.onTreeAssumeUtcForIsoDateOnlyChange(false);
    expect(prefs.prefs().treeAssumeUtcForIsoDateOnly).toBe(false);
    fixture.componentInstance.onTreeAssumeUtcForIsoDateOnlyChange(true);
    expect(prefs.prefs().treeAssumeUtcForIsoDateOnly).toBe(true);
  });

  it('writes tree font size and clamps to the supported range', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    fixture.componentInstance.onTreeFontSizeChange(18);
    expect(prefs.prefs().treeFontSize).toBe(18);
    fixture.componentInstance.onTreeFontSizeChange(2);
    expect(prefs.prefs().treeFontSize).toBe(8);
    fixture.componentInstance.onTreeFontSizeChange(99);
    expect(prefs.prefs().treeFontSize).toBe(32);
    const before = prefs.prefs().treeFontSize;
    fixture.componentInstance.onTreeFontSizeChange(null);
    expect(prefs.prefs().treeFontSize).toBe(before);
    fixture.componentInstance.onTreeFontSizeChange('not-a-number');
    expect(prefs.prefs().treeFontSize).toBe(before);
  });

  it('writes searchCaseSensitive when toggled', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    fixture.componentInstance.onSearchCaseSensitiveChange(true);
    expect(prefs.prefs().searchCaseSensitive).toBe(true);
    fixture.componentInstance.onSearchCaseSensitiveChange(false);
    expect(prefs.prefs().searchCaseSensitive).toBe(false);
  });

  it('writes searchMatchMode when changed via mat-select (all 5 modes round-trip)', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    // Loop every valid mode so a typo in the validator's literal set
    // (e.g., `'ends-with'` with a hyphen) would fail at least one of
    // the five round-trips. Pre-fix the validator was 5 hardcoded
    // `value === '...'` checks; post-fix it derives the accepted set
    // from `searchMatchModes`. Either way, all 5 must round-trip.
    const allModes: readonly SearchMatchMode[] = [
      'contains',
      'starts_with',
      'ends_with',
      'exact',
      'regex',
    ];
    for (const mode of allModes) {
      fixture.componentInstance.onSearchMatchModeChange(mode);
      expect(prefs.prefs().searchMatchMode, `mode=${mode}`).toBe(mode);
    }
  });

  it('ignores invalid searchMatchMode values', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    const before = prefs.prefs().searchMatchMode;
    fixture.componentInstance.onSearchMatchModeChange('bogus');
    expect(prefs.prefs().searchMatchMode).toBe(before);
  });

  it('writes searchScope for valid values and ignores invalid ones', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    fixture.componentInstance.onSearchScopeChange('keys');
    expect(prefs.prefs().searchScope).toBe('keys');
    fixture.componentInstance.onSearchScopeChange('values');
    expect(prefs.prefs().searchScope).toBe('values');
    fixture.componentInstance.onSearchScopeChange('both');
    expect(prefs.prefs().searchScope).toBe('both');
    fixture.componentInstance.onSearchScopeChange('garbage');
    expect(prefs.prefs().searchScope).toBe('both');
  });

  it('writes treePathRoot for valid values and ignores invalid ones', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    expect(prefs.prefs().treePathRoot).toBe('jsonpath');
    fixture.componentInstance.onTreePathRootChange('none');
    expect(prefs.prefs().treePathRoot).toBe('none');
    fixture.componentInstance.onTreePathRootChange('root');
    expect(prefs.prefs().treePathRoot).toBe('root');
    fixture.componentInstance.onTreePathRootChange('data');
    expect(prefs.prefs().treePathRoot).toBe('data');
    fixture.componentInstance.onTreePathRootChange('jsonpath');
    expect(prefs.prefs().treePathRoot).toBe('jsonpath');
    fixture.componentInstance.onTreePathRootChange('garbage');
    expect(prefs.prefs().treePathRoot).toBe('jsonpath');
  });

  it('writes recentlyViewedEnabled when toggled', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    expect(prefs.prefs().recentlyViewedEnabled).toBe(true);
    fixture.componentInstance.onRecentlyViewedEnabledChange(false);
    expect(prefs.prefs().recentlyViewedEnabled).toBe(false);
    fixture.componentInstance.onRecentlyViewedEnabledChange(true);
    expect(prefs.prefs().recentlyViewedEnabled).toBe(true);
  });

  it('writes treeEditorSelectionSync when toggled (issue #42)', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    expect(prefs.prefs().treeEditorSelectionSync).toBe(true);
    expect(fixture.componentInstance.treeEditorSelectionSync()).toBe(true);
    fixture.componentInstance.onTreeEditorSelectionSyncChange(false);
    expect(prefs.prefs().treeEditorSelectionSync).toBe(false);
    expect(fixture.componentInstance.treeEditorSelectionSync()).toBe(false);
    fixture.componentInstance.onTreeEditorSelectionSyncChange(true);
    expect(prefs.prefs().treeEditorSelectionSync).toBe(true);
  });

  it('writes blobQuotaStrategy for valid values', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    fixture.componentInstance.onBlobQuotaStrategyChange('manual');
    expect(prefs.prefs().blobQuotaStrategy).toBe('manual');
    fixture.componentInstance.onBlobQuotaStrategyChange('auto_fifo');
    expect(prefs.prefs().blobQuotaStrategy).toBe('auto_fifo');
    fixture.componentInstance.onBlobQuotaStrategyChange('garbage');
    expect(prefs.prefs().blobQuotaStrategy).toBe('auto_fifo');
  });

  it('writes theme for valid values', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    fixture.componentInstance.onThemeChange('light');
    expect(prefs.prefs().theme).toBe('light');
    fixture.componentInstance.onThemeChange('dark');
    expect(prefs.prefs().theme).toBe('dark');
    fixture.componentInstance.onThemeChange('system');
    expect(prefs.prefs().theme).toBe('system');
    fixture.componentInstance.onThemeChange('garbage');
    expect(prefs.prefs().theme).toBe('system');
  });

  it('writes layoutOrientation for valid values', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    });
    fixture.componentInstance.onLayoutOrientationChange('vertical');
    expect(prefs.prefs().layoutOrientation).toBe('vertical');
    fixture.componentInstance.onLayoutOrientationChange('horizontal');
    expect(prefs.prefs().layoutOrientation).toBe('horizontal');
    fixture.componentInstance.onLayoutOrientationChange('garbage');
    expect(prefs.prefs().layoutOrientation).toBe('horizontal');
  });

  describe('tree highlight colors', () => {
    async function createSignedIn() {
      return create({
        user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
        isConfigured: true,
      });
    }

    it('renders 10 color inputs (5 per theme)', async () => {
      const { fixture } = await createSignedIn();
      const inputs = (fixture.nativeElement as HTMLElement).querySelectorAll('input[type="color"]');
      expect(inputs.length).toBe(10);
    });

    it('changes only the targeted field and preserves the other dark/light fields', async () => {
      const { fixture, prefs } = await createSignedIn();
      const before = prefs.prefs().treeHighlightColors;
      fixture.componentInstance.onHighlightColorChange('dark', 'selectionColor', '#abcdef');
      const after = prefs.prefs().treeHighlightColors;
      expect(after.dark.selectionColor).toBe('#abcdef');
      expect(after.dark.matchingValueColor).toBe(before.dark.matchingValueColor);
      expect(after.dark.ancestorColor).toBe(before.dark.ancestorColor);
      expect(after.dark.searchHighlightColor).toBe(before.dark.searchHighlightColor);
      expect(after.dark.manualHighlightColor).toBe(before.dark.manualHighlightColor);
      expect(after.light).toEqual(before.light);
    });

    it('updates manualHighlightColor through the preferences signal', async () => {
      const { fixture, prefs } = await createSignedIn();
      const before = prefs.prefs().treeHighlightColors;
      fixture.componentInstance.onHighlightColorChange('light', 'manualHighlightColor', '#fedcba');
      const after = prefs.prefs().treeHighlightColors;
      expect(after.light.manualHighlightColor).toBe('#fedcba');
      expect(after.light.selectionColor).toBe(before.light.selectionColor);
      expect(after.dark).toEqual(before.dark);
    });

    it('rejects malformed hex values without changing prefs', async () => {
      const { fixture, prefs } = await createSignedIn();
      const before = prefs.prefs().treeHighlightColors;
      fixture.componentInstance.onHighlightColorChange('dark', 'selectionColor', 'red');
      fixture.componentInstance.onHighlightColorChange('dark', 'selectionColor', '#zzzzzz');
      fixture.componentInstance.onHighlightColorChange('dark', 'selectionColor', '');
      expect(prefs.prefs().treeHighlightColors).toEqual(before);
    });

    it('isActiveTheme follows effectiveTheme on explicit theme change', async () => {
      const { fixture, prefs } = await createSignedIn();
      prefs.update({ theme: 'dark' });
      fixture.detectChanges();
      expect(fixture.componentInstance.isActiveTheme('dark')).toBe(true);
      expect(fixture.componentInstance.isActiveTheme('light')).toBe(false);
      prefs.update({ theme: 'light' });
      fixture.detectChanges();
      expect(fixture.componentInstance.isActiveTheme('dark')).toBe(false);
      expect(fixture.componentInstance.isActiveTheme('light')).toBe(true);
    });

    it('reset restores only the active theme to defaults; inactive theme overrides are preserved', async () => {
      const { fixture, prefs } = await createSignedIn();
      prefs.update({ theme: 'dark' });
      fixture.componentInstance.onHighlightColorChange('dark', 'selectionColor', '#111111');
      fixture.componentInstance.onHighlightColorChange('light', 'selectionColor', '#222222');
      fixture.componentInstance.onResetActiveThemeColors();
      const colors = prefs.prefs().treeHighlightColors;
      // Dark restored
      expect(colors.dark.selectionColor).toBe(
        DEFAULT_PREFERENCES.treeHighlightColors.dark.selectionColor,
      );
      // Light override preserved
      expect(colors.light.selectionColor).toBe('#222222');
    });

    it('reset restores manualHighlightColor for both themes when each theme is active', async () => {
      const { fixture, prefs } = await createSignedIn();
      prefs.update({ theme: 'dark' });
      fixture.componentInstance.onHighlightColorChange('dark', 'manualHighlightColor', '#111111');
      fixture.componentInstance.onResetActiveThemeColors();
      expect(prefs.prefs().treeHighlightColors.dark.manualHighlightColor).toBe(
        DEFAULT_PREFERENCES.treeHighlightColors.dark.manualHighlightColor,
      );

      prefs.update({ theme: 'light' });
      fixture.componentInstance.onHighlightColorChange('light', 'manualHighlightColor', '#222222');
      fixture.componentInstance.onResetActiveThemeColors();
      expect(prefs.prefs().treeHighlightColors.light.manualHighlightColor).toBe(
        DEFAULT_PREFERENCES.treeHighlightColors.light.manualHighlightColor,
      );
    });
  });

  describe('default rule sets section', () => {
    function setRuleSetCache(sets: FormattingRuleSet[] | null): void {
      const ruleSets = TestBed.inject(RuleSetsService);
      (
        ruleSets as unknown as {
          _serverSnapshot: { set(v: FormattingRuleSet[] | null): void };
        }
      )._serverSnapshot.set(sets);
    }

    it('does not render the section when signed out', async () => {
      const { fixture } = await create({ user: null, isConfigured: true });
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).not.toContain('Default rule sets');
    });

    it('renders the section heading when signed in', async () => {
      const { fixture } = await create({
        user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
        isConfigured: true,
      });
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Default rule sets');
    });

    it('shows the empty-state hint when the user owns no rule sets', async () => {
      const { fixture } = await create({
        user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
        isConfigured: true,
      });
      setRuleSetCache([]);
      fixture.detectChanges();
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Clone preset');
    });

    it('renders one checkbox per cached rule set sorted by name', async () => {
      const { fixture } = await create({
        user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
        isConfigured: true,
      });
      setRuleSetCache([
        makeRuleSet({ id: 'rs-z', name: 'Zebra' }),
        makeRuleSet({ id: 'rs-a', name: 'Alpha' }),
        makeRuleSet({ id: 'rs-m', name: 'Mike' }),
      ]);
      fixture.detectChanges();
      const labels = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('.pref-checkbox-list mat-checkbox'),
      ).map((el) => (el.textContent ?? '').trim());
      expect(labels).toEqual(['Alpha', 'Mike', 'Zebra']);
    });

    it('reflects the current activeRuleSetIds via the checkbox checked state', async () => {
      const { fixture, prefs } = await create({
        user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
        isConfigured: true,
      });
      setRuleSetCache([
        makeRuleSet({ id: 'rs-1', name: 'One' }),
        makeRuleSet({ id: 'rs-2', name: 'Two' }),
      ]);
      prefs.update({ activeRuleSetIds: ['rs-2'] });
      fixture.detectChanges();
      expect(fixture.componentInstance.isActiveRuleSet('rs-1')).toBe(false);
      expect(fixture.componentInstance.isActiveRuleSet('rs-2')).toBe(true);
    });

    it('appends an ID when toggled on', async () => {
      const { fixture, prefs } = await create({
        user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
        isConfigured: true,
      });
      setRuleSetCache([
        makeRuleSet({ id: 'rs-1', name: 'One' }),
        makeRuleSet({ id: 'rs-2', name: 'Two' }),
      ]);
      prefs.update({ activeRuleSetIds: ['rs-1'] });
      fixture.componentInstance.onActiveRuleSetToggle('rs-2', true);
      expect(prefs.prefs().activeRuleSetIds).toEqual(['rs-1', 'rs-2']);
    });

    it('removes an ID when toggled off', async () => {
      const { fixture, prefs } = await create({
        user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
        isConfigured: true,
      });
      setRuleSetCache([
        makeRuleSet({ id: 'rs-1', name: 'One' }),
        makeRuleSet({ id: 'rs-2', name: 'Two' }),
      ]);
      prefs.update({ activeRuleSetIds: ['rs-1', 'rs-2'] });
      fixture.componentInstance.onActiveRuleSetToggle('rs-1', false);
      expect(prefs.prefs().activeRuleSetIds).toEqual(['rs-2']);
    });

    it('is a no-op when toggling on an ID already present', async () => {
      const { fixture, prefs } = await create({
        user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
        isConfigured: true,
      });
      prefs.update({ activeRuleSetIds: ['rs-1'] });
      const before = prefs.prefs().activeRuleSetIds;
      fixture.componentInstance.onActiveRuleSetToggle('rs-1', true);
      expect(prefs.prefs().activeRuleSetIds).toBe(before);
    });
  });

  describe('flush-right layout', () => {
    const signedIn = {
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true,
    };

    it('externalizes every settings slide-toggle label into a sibling pref-label', async () => {
      const { fixture } = await create(signedIn);
      const root = fixture.nativeElement as HTMLElement;
      const toggles = Array.from(root.querySelectorAll<HTMLElement>('.pref-row mat-slide-toggle'));
      for (const toggle of toggles) {
        expect(toggle.getAttribute('labelPosition')).not.toBe('before');
        const previousSibling = toggle.previousElementSibling;
        expect(previousSibling, `expected a sibling label preceding ${toggle.id}`).toBeTruthy();
        expect(
          previousSibling?.classList.contains('pref-label'),
          `previous sibling of ${toggle.id} should be .pref-label`,
        ).toBe(true);
        expect(
          previousSibling?.id,
          `pref-label preceding ${toggle.id} must have an id`,
        ).toBeTruthy();
        const innerButton = toggle.querySelector<HTMLButtonElement>('button');
        expect(
          innerButton?.getAttribute('aria-labelledby'),
          `button inside ${toggle.id} should reference the label id`,
        ).toBe(previousSibling?.id ?? null);
      }
      expect(toggles.length).toBeGreaterThan(0);
    });

    it('wraps font-size inputs in a mat-form-field with a px suffix', async () => {
      const { fixture } = await create(signedIn);
      const root = fixture.nativeElement as HTMLElement;

      const fontSize = root.querySelector('#pref-font-size');
      const fontSizeWrap = fontSize?.closest('mat-form-field');
      expect(fontSizeWrap).toBeTruthy();
      expect(fontSizeWrap?.textContent).toContain('px');

      const treeFontSize = root.querySelector('#pref-tree-font-size');
      const treeFontSizeWrap = treeFontSize?.closest('mat-form-field');
      expect(treeFontSizeWrap).toBeTruthy();
      expect(treeFontSizeWrap?.textContent).toContain('px');
    });

    it('groups slider with its value suffix', async () => {
      const { fixture } = await create(signedIn);
      const root = fixture.nativeElement as HTMLElement;
      const slider = root.querySelector('mat-slider');
      const wrap = slider?.closest('.pref-control-group');
      expect(wrap).toBeTruthy();
      expect(wrap?.querySelector('.pref-suffix')).toBeTruthy();
    });

    it('does not pin the date-annotation unit checkboxes to label-before', async () => {
      const { fixture } = await create(signedIn);
      const root = fixture.nativeElement as HTMLElement;
      const unitCheckboxes = Array.from(
        root.querySelectorAll('.date-annotation-unit-grid mat-checkbox'),
      );
      expect(unitCheckboxes.length).toBe(6);
      for (const checkbox of unitCheckboxes) {
        expect(checkbox.getAttribute('labelPosition')).not.toBe('before');
      }
    });
  });
});

function makeRuleSet(partial: { id: string; name: string }): FormattingRuleSet {
  const now = new Date().toISOString();
  return {
    id: partial.id,
    userId: 'u1',
    name: partial.name,
    rules: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}
