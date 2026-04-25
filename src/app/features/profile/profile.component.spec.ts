import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ProfileComponent } from './profile.component';
import { AuthService } from '../../core/auth/auth.service';
import { AuthUser } from '../../core/auth/auth-user';
import { PreferencesService } from '../../core/preferences/preferences.service';
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
    expect(text).toContain('History & storage');
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
});
