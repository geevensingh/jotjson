import { TestBed } from '@angular/core/testing';
import { of, throwError, Subject } from 'rxjs';
import { signal } from '@angular/core';
import {
  PreferencesService,
  DEFAULT_PREFERENCES
} from './preferences.service';
import { AuthService } from '../auth/auth.service';
import { UserApiService } from '../api/user-api.service';
import type { User, UserPreferences } from '../api/models';

const STORAGE_KEY = 'jotjson.preferences.v1';

class AuthServiceStub {
  private readonly userSignal = signal<{ id: string; displayName: string } | null>(null);
  readonly user = this.userSignal.asReadonly();
  signInAs(id: string): void {
    this.userSignal.set({ id, displayName: 'Test' });
  }
  signOut(): void {
    this.userSignal.set(null);
  }
}

class UserApiServiceStub {
  getMe = jasmine.createSpy('getMe').and.returnValue(of<User | null>(null));
  seed = jasmine.createSpy('seed').and.callFake((prefs: UserPreferences) =>
    of<User>({
      id: 'u-1',
      displayName: 'Test',
      email: 'x@y.z',
      createdAt: 't',
      plan: 'free',
      preferences: prefs
    })
  );
  putPreferences = jasmine.createSpy('putPreferences').and.callFake((p: UserPreferences) =>
    of<UserPreferences>(p)
  );
}

function makeUser(overrides: Partial<UserPreferences> = {}): User {
  return {
    id: 'u-1',
    displayName: 'Test',
    email: 'x@y.z',
    createdAt: 't',
    plan: 'free',
    preferences: { ...DEFAULT_PREFERENCES, ...overrides }
  };
}

describe('PreferencesService', () => {
  let auth: AuthServiceStub;
  let api: UserApiServiceStub;

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    TestBed.resetTestingModule();
    auth = new AuthServiceStub();
    api = new UserApiServiceStub();
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: UserApiService, useValue: api }
      ]
    });
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  it('uses DEFAULT_PREFERENCES when localStorage is empty', () => {
    const svc = TestBed.inject(PreferencesService);
    expect(svc.prefs()).toEqual(DEFAULT_PREFERENCES);
    expect(svc.syncState()).toBe('anon');
  });

  it('persists updates to localStorage', () => {
    const svc = TestBed.inject(PreferencesService);
    svc.update({ theme: 'dark' });
    TestBed.flushEffects();
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).theme).toBe('dark');
  });

  it('hydrates from localStorage on construction', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ theme: 'light', editorFontSize: 18 })
    );
    const svc = TestBed.inject(PreferencesService);
    expect(svc.prefs().theme).toBe('light');
    expect(svc.prefs().editorFontSize).toBe(18);
    expect(svc.prefs().editorTabSize).toBe(DEFAULT_PREFERENCES.editorTabSize);
  });

  it('falls back to defaults when stored value is corrupt', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    const svc = TestBed.inject(PreferencesService);
    expect(svc.prefs()).toEqual(DEFAULT_PREFERENCES);
  });

  it('reset() restores DEFAULT_PREFERENCES', () => {
    const svc = TestBed.inject(PreferencesService);
    svc.update({ theme: 'dark', editorFontSize: 22 });
    svc.reset();
    expect(svc.prefs()).toEqual(DEFAULT_PREFERENCES);
  });

  it('effectiveTheme resolves explicit dark/light preference', () => {
    const svc = TestBed.inject(PreferencesService);
    svc.update({ theme: 'dark' });
    expect(svc.effectiveTheme()).toBe('dark');
    svc.update({ theme: 'light' });
    expect(svc.effectiveTheme()).toBe('light');
  });

  it('effectiveTheme resolves "system" via matchMedia', () => {
    const svc = TestBed.inject(PreferencesService);
    svc.update({ theme: 'system' });
    const mm = window.matchMedia?.('(prefers-color-scheme: light)');
    const expected = mm?.matches ? 'light' : 'dark';
    expect(svc.effectiveTheme()).toBe(expected);
  });

  it('merges deep treeHighlightColors shape from storage', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        treeHighlightColors: { dark: { selectionColor: '#123456' } }
      })
    );
    const svc = TestBed.inject(PreferencesService);
    const colors = svc.prefs().treeHighlightColors;
    expect(colors.dark.selectionColor).toBe('#123456');
    // Backfilled dark fields - regression for shallow-merge bug.
    expect(colors.dark.matchingValueColor).toBe(
      DEFAULT_PREFERENCES.treeHighlightColors.dark.matchingValueColor
    );
    expect(colors.dark.ancestorColor).toBe(
      DEFAULT_PREFERENCES.treeHighlightColors.dark.ancestorColor
    );
    expect(colors.dark.searchHighlightColor).toBe(
      DEFAULT_PREFERENCES.treeHighlightColors.dark.searchHighlightColor
    );
    expect(colors.light).toEqual(DEFAULT_PREFERENCES.treeHighlightColors.light);
  });

  it('backfills partial nested treeHighlightColors from the server', async () => {
    const partial: UserPreferences = {
      ...DEFAULT_PREFERENCES,
      treeHighlightColors: {
        // Cast through unknown - the server may legitimately return a
        // partial object for older user docs that predate a new field.
        dark: { selectionColor: '#abcdef' },
        light: { ancestorColor: '#fefefe' }
      } as UserPreferences['treeHighlightColors']
    };
    const svc = TestBed.inject(PreferencesService);
    api.getMe.and.returnValue(of(makeUser(partial)));
    auth.signInAs('u-1');
    TestBed.flushEffects();
    await svc.__waitForSync();
    const colors = svc.prefs().treeHighlightColors;
    expect(colors.dark.selectionColor).toBe('#abcdef');
    expect(colors.dark.matchingValueColor).toBe(
      DEFAULT_PREFERENCES.treeHighlightColors.dark.matchingValueColor
    );
    expect(colors.light.ancestorColor).toBe('#fefefe');
    expect(colors.light.selectionColor).toBe(
      DEFAULT_PREFERENCES.treeHighlightColors.light.selectionColor
    );
  });

  describe('runtime --highlight-* projection on document.body', () => {
    function readBodyVar(name: string): string {
      return document.body.style.getPropertyValue(name).trim();
    }

    it('writes the active theme colors to body inline CSS variables', () => {
      const svc = TestBed.inject(PreferencesService);
      svc.update({ theme: 'dark' });
      TestBed.flushEffects();
      expect(readBodyVar('--highlight-selection')).toBe(
        DEFAULT_PREFERENCES.treeHighlightColors.dark.selectionColor
      );
      svc.update({
        treeHighlightColors: {
          ...svc.prefs().treeHighlightColors,
          dark: {
            ...svc.prefs().treeHighlightColors.dark,
            selectionColor: '#aabbcc'
          }
        }
      });
      TestBed.flushEffects();
      expect(readBodyVar('--highlight-selection')).toBe('#aabbcc');
    });

    it('editing the inactive theme does not change the body variables', () => {
      const svc = TestBed.inject(PreferencesService);
      svc.update({ theme: 'dark' });
      TestBed.flushEffects();
      const before = readBodyVar('--highlight-selection');
      svc.update({
        treeHighlightColors: {
          ...svc.prefs().treeHighlightColors,
          light: {
            ...svc.prefs().treeHighlightColors.light,
            selectionColor: '#ff0000'
          }
        }
      });
      TestBed.flushEffects();
      expect(readBodyVar('--highlight-selection')).toBe(before);
    });

    it('switching the active theme rewrites all four body variables', () => {
      const svc = TestBed.inject(PreferencesService);
      svc.update({ theme: 'dark' });
      TestBed.flushEffects();
      svc.update({ theme: 'light' });
      TestBed.flushEffects();
      const light = DEFAULT_PREFERENCES.treeHighlightColors.light;
      expect(readBodyVar('--highlight-selection')).toBe(light.selectionColor);
      expect(readBodyVar('--highlight-matching')).toBe(light.matchingValueColor);
      expect(readBodyVar('--highlight-ancestor')).toBe(light.ancestorColor);
      expect(readBodyVar('--highlight-search')).toBe(light.searchHighlightColor);
    });

    it('sign-out projects default colors back onto body', async () => {
      const svc = TestBed.inject(PreferencesService);
      const customized: UserPreferences = {
        ...DEFAULT_PREFERENCES,
        theme: 'dark',
        treeHighlightColors: {
          ...DEFAULT_PREFERENCES.treeHighlightColors,
          dark: {
            ...DEFAULT_PREFERENCES.treeHighlightColors.dark,
            selectionColor: '#deadbe'
          }
        }
      };
      api.getMe.and.returnValue(of(makeUser(customized)));
      auth.signInAs('u-1');
      TestBed.flushEffects();
      await svc.__waitForSync();
      TestBed.flushEffects();
      expect(readBodyVar('--highlight-selection')).toBe('#deadbe');
      auth.signOut();
      TestBed.flushEffects();
      // After sign-out the prefs reset to DEFAULT_PREFERENCES (theme 'system').
      const effective = svc.effectiveTheme();
      expect(readBodyVar('--highlight-selection')).toBe(
        DEFAULT_PREFERENCES.treeHighlightColors[effective].selectionColor
      );
    });

    it('coalesces rapid highlight-color updates into a single PUT', async () => {
      jasmine.clock().install();
      try {
        const svc = TestBed.inject(PreferencesService);
        api.getMe.and.returnValue(of(makeUser()));
        auth.signInAs('u-1');
        TestBed.flushEffects();
        await svc.__waitForSync();
        api.putPreferences.calls.reset();
        const base = svc.prefs().treeHighlightColors;
        svc.update({
          treeHighlightColors: {
            ...base,
            dark: { ...base.dark, selectionColor: '#111111' }
          }
        });
        svc.update({
          treeHighlightColors: {
            ...svc.prefs().treeHighlightColors,
            dark: { ...svc.prefs().treeHighlightColors.dark, selectionColor: '#222222' }
          }
        });
        TestBed.flushEffects();
        expect(api.putPreferences).not.toHaveBeenCalled();
        jasmine.clock().tick(600);
        expect(api.putPreferences).toHaveBeenCalledTimes(1);
        const sent = api.putPreferences.calls.mostRecent().args[0] as UserPreferences;
        expect(sent.treeHighlightColors.dark.selectionColor).toBe('#222222');
      } finally {
        jasmine.clock().uninstall();
      }
    });
  });

  describe('sync lifecycle', () => {
    it('replaces local prefs with the server copy when the user doc exists (remote wins)', async () => {
      const svc = TestBed.inject(PreferencesService);
      svc.update({ theme: 'dark', editorFontSize: 20 });
      TestBed.flushEffects();
      api.getMe.and.returnValue(of(makeUser({ theme: 'light', editorFontSize: 16 })));
      auth.signInAs('u-1');
      TestBed.flushEffects();
      const end = await svc.__waitForSync();
      expect(end).toBe('synced');
      expect(svc.prefs().theme).toBe('light');
      expect(svc.prefs().editorFontSize).toBe(16);
      expect(api.seed).not.toHaveBeenCalled();
    });

    it('seeds the server from local prefs on first-ever sign-in (404)', async () => {
      const svc = TestBed.inject(PreferencesService);
      svc.update({ theme: 'dark' });
      TestBed.flushEffects();
      api.getMe.and.returnValue(of(null));
      auth.signInAs('u-1');
      TestBed.flushEffects();
      const end = await svc.__waitForSync();
      expect(end).toBe('synced');
      expect(api.seed).toHaveBeenCalledTimes(1);
      const seeded = api.seed.calls.mostRecent().args[0] as UserPreferences;
      expect(seeded.theme).toBe('dark');
    });

    it('marks syncState=error when GET /api/me fails', async () => {
      const svc = TestBed.inject(PreferencesService);
      api.getMe.and.returnValue(throwError(() => new Error('network')));
      auth.signInAs('u-1');
      TestBed.flushEffects();
      const end = await svc.__waitForSync();
      expect(end).toBe('error');
    });

    it('clears previous user prefs from localStorage and resets on sign-out', async () => {
      const svc = TestBed.inject(PreferencesService);
      api.getMe.and.returnValue(of(makeUser({ theme: 'light', editorFontSize: 22 })));
      auth.signInAs('u-1');
      TestBed.flushEffects();
      await svc.__waitForSync();
      expect(svc.prefs().theme).toBe('light');

      auth.signOut();
      TestBed.flushEffects();
      expect(svc.syncState()).toBe('anon');
      expect(svc.prefs()).toEqual(DEFAULT_PREFERENCES);
      // localStorage is wiped at sign-out; the subsequent anon write-through
      // effect repopulates it with DEFAULT_PREFERENCES, so the previous
      // user's customizations must not leak through.
      const raw = localStorage.getItem(STORAGE_KEY);
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw!)).toEqual(DEFAULT_PREFERENCES);
    });

    it('PUTs preferences after sync on subsequent updates (debounced)', async () => {
      jasmine.clock().install();
      try {
        const svc = TestBed.inject(PreferencesService);
        api.getMe.and.returnValue(of(makeUser()));
        auth.signInAs('u-1');
        TestBed.flushEffects();
        await svc.__waitForSync();
        svc.update({ theme: 'dark' });
        TestBed.flushEffects();
        expect(api.putPreferences).not.toHaveBeenCalled();
        jasmine.clock().tick(600);
        expect(api.putPreferences).toHaveBeenCalledTimes(1);
        const sent = api.putPreferences.calls.mostRecent().args[0] as UserPreferences;
        expect(sent.theme).toBe('dark');
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('ignores in-flight hydration results when the user changes', async () => {
      const svc = TestBed.inject(PreferencesService);
      const slow = new Subject<User | null>();
      api.getMe.and.returnValue(slow.asObservable());
      auth.signInAs('u-1');
      TestBed.flushEffects();
      // User changes before the first hydration completes.
      auth.signOut();
      TestBed.flushEffects();
      // Late response for user u-1 must be ignored.
      slow.next(makeUser({ theme: 'light' }));
      slow.complete();
      expect(svc.syncState()).toBe('anon');
      expect(svc.prefs()).toEqual(DEFAULT_PREFERENCES);
    });
  });
});
