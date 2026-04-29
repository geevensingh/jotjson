import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ProfileComponent } from './profile.component';
import { AuthService } from '../../core/auth/auth.service';
import { AuthUser } from '../../core/auth/auth-user';
import { PreferencesService } from '../../core/preferences/preferences.service';
import { RuleSetsService } from '../../core/api/rule-sets.service';
import { FormattingRuleSet } from '../../core/api/models';
import { provideFakeAuth } from '../../../testing/auth.testing';
import { signal } from '@angular/core';

describe('ProfileComponent', () => {
  async function create(overrides?: {
    user?: AuthUser | null;
    isConfigured?: boolean;
  }) {
    const userSignal = signal<AuthUser | null>(overrides?.user ?? null);
    const authStub = {
      user: userSignal.asReadonly(),
      isSignedIn: (() => userSignal() !== null) as unknown as AuthService['isSignedIn'],
      isConfigured: overrides?.isConfigured ?? false,
      signIn: jasmine.createSpy('signIn'),
      signOut: jasmine.createSpy('signOut')
    } as unknown as AuthService;

    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ProfileComponent],
      providers: [
        provideRouter([]),
        ...provideFakeAuth(),
        { provide: AuthService, useValue: authStub }
      ]
    }).compileComponents();
    const fixture = TestBed.createComponent(ProfileComponent);
    fixture.detectChanges();
    const prefs = TestBed.inject(PreferencesService);
    return { fixture, authStub, prefs };
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
      isConfigured: true
    });
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Ada Lovelace');
    expect(text).toContain('ada@example.com');
    expect(text).toContain('Sign out');
  });

  it('shows "Not provided" fallback when email claim is missing', async () => {
    const { fixture } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: undefined },
      isConfigured: true
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
      isConfigured: true
    });
    fixture.componentInstance.onSignOut();
    expect(authStub.signOut).toHaveBeenCalled();
  });

  it('renders the preferences card with all group headings when signed in', async () => {
    const { fixture } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true
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
      isConfigured: true
    });
    fixture.componentInstance.onEditorFontSizeChange(20);
    expect(prefs.prefs().editorFontSize).toBe(20);
  });

  it('clamps editor font size to the supported range', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true
    });
    fixture.componentInstance.onEditorFontSizeChange(2);
    expect(prefs.prefs().editorFontSize).toBe(8);
    fixture.componentInstance.onEditorFontSizeChange(99);
    expect(prefs.prefs().editorFontSize).toBe(32);
  });

  it('rejects non-numeric editor font size and keeps the prior value', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true
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
      isConfigured: true
    });
    fixture.componentInstance.onEditorTabSizeChange(4);
    expect(prefs.prefs().editorTabSize).toBe(4);
    fixture.componentInstance.onEditorTabSizeChange(2);
    expect(prefs.prefs().editorTabSize).toBe(2);
  });

  it('writes editor word wrap through PreferencesService when toggled', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true
    });
    fixture.componentInstance.onEditorWordWrapChange(false);
    expect(prefs.prefs().editorWordWrap).toBe(false);
    fixture.componentInstance.onEditorWordWrapChange(true);
    expect(prefs.prefs().editorWordWrap).toBe(true);
  });

  it('writes default tree expansion depth and clamps to range', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true
    });
    fixture.componentInstance.onDefaultTreeExpansionDepthChange(5);
    expect(prefs.prefs().defaultTreeExpansionDepth).toBe(5);
    fixture.componentInstance.onDefaultTreeExpansionDepthChange(0);
    expect(prefs.prefs().defaultTreeExpansionDepth).toBe(1);
    fixture.componentInstance.onDefaultTreeExpansionDepthChange(99);
    expect(prefs.prefs().defaultTreeExpansionDepth).toBe(10);
  });

  it('writes treeShowTypeLabels through PreferencesService when toggled', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true
    });
    fixture.componentInstance.onTreeShowTypeLabelsChange(false);
    expect(prefs.prefs().treeShowTypeLabels).toBe(false);
    fixture.componentInstance.onTreeShowTypeLabelsChange(true);
    expect(prefs.prefs().treeShowTypeLabels).toBe(true);
  });

  it('writes treeShowDateAnnotations through PreferencesService when toggled', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true
    });
    fixture.componentInstance.onTreeShowDateAnnotationsChange(false);
    expect(prefs.prefs().treeShowDateAnnotations).toBe(false);
    fixture.componentInstance.onTreeShowDateAnnotationsChange(true);
    expect(prefs.prefs().treeShowDateAnnotations).toBe(true);
  });

  it('writes treeAssumeUtcForIsoDateTime/Only through PreferencesService when toggled', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true
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
      isConfigured: true
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
      isConfigured: true
    });
    fixture.componentInstance.onSearchCaseSensitiveChange(true);
    expect(prefs.prefs().searchCaseSensitive).toBe(true);
    fixture.componentInstance.onSearchCaseSensitiveChange(false);
    expect(prefs.prefs().searchCaseSensitive).toBe(false);
  });

  it('writes searchRegexMode when toggled', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true
    });
    fixture.componentInstance.onSearchRegexModeChange(true);
    expect(prefs.prefs().searchRegexMode).toBe(true);
    fixture.componentInstance.onSearchRegexModeChange(false);
    expect(prefs.prefs().searchRegexMode).toBe(false);
  });

  it('writes searchScope for valid values and ignores invalid ones', async () => {
    const { fixture, prefs } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true
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
      isConfigured: true
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
      isConfigured: true
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
      isConfigured: true
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
      isConfigured: true
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
      isConfigured: true
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
      isConfigured: true
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
        isConfigured: true
      });
    }

    it('renders 8 color inputs (4 per theme)', async () => {
      const { fixture } = await createSignedIn();
      const inputs = (fixture.nativeElement as HTMLElement).querySelectorAll(
        'input[type="color"]'
      );
      expect(inputs.length).toBe(8);
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
      expect(after.light).toEqual(before.light);
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
      expect(colors.dark.selectionColor).not.toBe('#111111');
      // Light override preserved
      expect(colors.light.selectionColor).toBe('#222222');
    });
  });

  describe('default rule sets section', () => {
    function setRuleSetCache(sets: FormattingRuleSet[] | null): void {
      const ruleSets = TestBed.inject(RuleSetsService);
      (ruleSets as unknown as {
        _serverSnapshot: { set(v: FormattingRuleSet[] | null): void };
      })._serverSnapshot.set(sets);
    }

    it('does not render the section when signed out', async () => {
      const { fixture } = await create({ user: null, isConfigured: true });
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).not.toContain('Default rule sets');
    });

    it('renders the section heading when signed in', async () => {
      const { fixture } = await create({
        user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
        isConfigured: true
      });
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Default rule sets');
    });

    it('shows the empty-state hint when the user owns no rule sets', async () => {
      const { fixture } = await create({
        user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
        isConfigured: true
      });
      setRuleSetCache([]);
      fixture.detectChanges();
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Clone preset');
    });

    it('renders one checkbox per cached rule set sorted by name', async () => {
      const { fixture } = await create({
        user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
        isConfigured: true
      });
      setRuleSetCache([
        makeRuleSet({ id: 'rs-z', name: 'Zebra' }),
        makeRuleSet({ id: 'rs-a', name: 'Alpha' }),
        makeRuleSet({ id: 'rs-m', name: 'Mike' })
      ]);
      fixture.detectChanges();
      const labels = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('mat-checkbox')
      ).map((el) => (el.textContent ?? '').trim());
      expect(labels).toEqual(['Alpha', 'Mike', 'Zebra']);
    });

    it('reflects the current defaultRuleSetIds via the checkbox checked state', async () => {
      const { fixture, prefs } = await create({
        user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
        isConfigured: true
      });
      setRuleSetCache([
        makeRuleSet({ id: 'rs-1', name: 'One' }),
        makeRuleSet({ id: 'rs-2', name: 'Two' })
      ]);
      prefs.update({ defaultRuleSetIds: ['rs-2'] });
      fixture.detectChanges();
      expect(fixture.componentInstance.isDefaultRuleSet('rs-1')).toBe(false);
      expect(fixture.componentInstance.isDefaultRuleSet('rs-2')).toBe(true);
    });

    it('appends an ID when toggled on', async () => {
      const { fixture, prefs } = await create({
        user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
        isConfigured: true
      });
      setRuleSetCache([
        makeRuleSet({ id: 'rs-1', name: 'One' }),
        makeRuleSet({ id: 'rs-2', name: 'Two' })
      ]);
      prefs.update({ defaultRuleSetIds: ['rs-1'] });
      fixture.componentInstance.onDefaultRuleSetToggle('rs-2', true);
      expect(prefs.prefs().defaultRuleSetIds).toEqual(['rs-1', 'rs-2']);
    });

    it('removes an ID when toggled off', async () => {
      const { fixture, prefs } = await create({
        user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
        isConfigured: true
      });
      setRuleSetCache([
        makeRuleSet({ id: 'rs-1', name: 'One' }),
        makeRuleSet({ id: 'rs-2', name: 'Two' })
      ]);
      prefs.update({ defaultRuleSetIds: ['rs-1', 'rs-2'] });
      fixture.componentInstance.onDefaultRuleSetToggle('rs-1', false);
      expect(prefs.prefs().defaultRuleSetIds).toEqual(['rs-2']);
    });

    it('is a no-op when toggling on an ID already present', async () => {
      const { fixture, prefs } = await create({
        user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
        isConfigured: true
      });
      prefs.update({ defaultRuleSetIds: ['rs-1'] });
      const before = prefs.prefs().defaultRuleSetIds;
      fixture.componentInstance.onDefaultRuleSetToggle('rs-1', true);
      expect(prefs.prefs().defaultRuleSetIds).toBe(before);
    });
  });

  describe('flush-right layout', () => {
    const signedIn = {
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true
    };

    it('places every settings slide-toggle with its label before the thumb', async () => {
      const { fixture } = await create(signedIn);
      const root = fixture.nativeElement as HTMLElement;
      const toggles = Array.from(
        root.querySelectorAll('.pref-row mat-slide-toggle')
      );
      for (const toggle of toggles) {
        const hasLabelPositionBefore = toggle.getAttribute('labelPosition') === 'before';
        const prevSibling = toggle.previousElementSibling;
        const hasExternalLabel = prevSibling?.tagName === 'LABEL';
        expect(hasLabelPositionBefore || hasExternalLabel).toBe(true);
      }
      expect(toggles.length).toBeGreaterThan(0);
    });

    it('wraps multi-piece controls in a pref-control-group', async () => {
      const { fixture } = await create(signedIn);
      const root = fixture.nativeElement as HTMLElement;

      const fontSize = root.querySelector('#pref-font-size');
      const fontSizeWrap = fontSize?.closest('.pref-control-group');
      expect(fontSizeWrap).toBeTruthy();
      expect(fontSizeWrap?.querySelector('.pref-suffix')?.textContent).toContain('px');

      const treeFontSize = root.querySelector('#pref-tree-font-size');
      expect(treeFontSize?.closest('.pref-control-group')).toBeTruthy();
    });

    it('groups slider with its value suffix', async () => {
      const { fixture } = await create(signedIn);
      const root = fixture.nativeElement as HTMLElement;
      const slider = root.querySelector('mat-slider');
      const wrap = slider?.closest('.pref-control-group');
      expect(wrap).toBeTruthy();
      expect(wrap?.querySelector('.pref-suffix')).toBeTruthy();
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
    updatedAt: now
  };
}
