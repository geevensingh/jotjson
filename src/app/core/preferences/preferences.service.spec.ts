import { TestBed } from '@angular/core/testing';
import { of, throwError, Subject } from 'rxjs';
import { signal } from '@angular/core';
import { PreferencesService, DEFAULT_PREFERENCES } from './preferences.service';
import { AuthService } from '../auth/auth.service';
import { UserApiService } from '../api/user-api.service';
import { LoggerService } from '../telemetry/logger.service';
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
      preferences: prefs,
    }),
  );
  putPreferences = jasmine
    .createSpy('putPreferences')
    .and.callFake((p: UserPreferences) => of<UserPreferences>(p));
}

function makeUser(overrides: Partial<UserPreferences> = {}): User {
  return {
    id: 'u-1',
    displayName: 'Test',
    email: 'x@y.z',
    createdAt: 't',
    plan: 'free',
    preferences: { ...DEFAULT_PREFERENCES, ...overrides },
  };
}

type PartialTreeHighlightColors = {
  dark?: Partial<UserPreferences['treeHighlightColors']['dark']>;
  light?: Partial<UserPreferences['treeHighlightColors']['light']>;
};

type PartialTreeDateAnnotationUnits = Partial<UserPreferences['treeDateAnnotationUnits']>;

function makeTreeHighlightPatch(
  treeHighlightColors: PartialTreeHighlightColors,
): Partial<UserPreferences> {
  return {
    treeHighlightColors: treeHighlightColors as unknown as UserPreferences['treeHighlightColors'],
  };
}

function makeTreeDateAnnotationUnitsPatch(
  treeDateAnnotationUnits: PartialTreeDateAnnotationUnits,
): Partial<UserPreferences> {
  return {
    treeDateAnnotationUnits:
      treeDateAnnotationUnits as unknown as UserPreferences['treeDateAnnotationUnits'],
  };
}

describe('PreferencesService', () => {
  let auth: AuthServiceStub;
  let api: UserApiServiceStub;
  let logger: jasmine.SpyObj<LoggerService>;

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    TestBed.resetTestingModule();
    auth = new AuthServiceStub();
    api = new UserApiServiceStub();
    logger = jasmine.createSpyObj<LoggerService>('LoggerService', [
      'event',
      'info',
      'warn',
      'error',
    ]);
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: UserApiService, useValue: api },
        { provide: LoggerService, useValue: logger },
      ],
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: 'light', editorFontSize: 18 }));
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

  it('folds legacy defaultRuleSetIds/defaultRuleSetId into activeRuleSetIds when hydrating from localStorage', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        theme: 'dark',
        historyTrackingMode: 'save_only',
        defaultRuleSetIds: ['rs-stale-array'],
        defaultRuleSetId: 'rs-old-singular',
      }),
    );
    const svc = TestBed.inject(PreferencesService);
    const prefs = svc.prefs() as UserPreferences & Record<string, unknown>;
    expect(prefs.theme).toBe('dark');
    expect(prefs['historyTrackingMode']).toBeUndefined();
    expect(prefs['defaultRuleSetIds']).toBeUndefined();
    expect(prefs['defaultRuleSetId']).toBeUndefined();
    // recentlyViewedEnabled defaults to true rather than being coerced
    // from the legacy key (the API normalizes stored docs on read).
    expect(prefs.recentlyViewedEnabled).toBe(DEFAULT_PREFERENCES.recentlyViewedEnabled);
    // The legacy array shape is folded into the canonical key.
    expect(prefs.activeRuleSetIds).toEqual(['rs-stale-array']);
  });

  it('drops unknown keys when hydrating from a remote response and folds legacy defaultRuleSetIds', async () => {
    // Build the user payload directly (bypassing makeUser's
    // ...DEFAULT_PREFERENCES spread) so the canonical
    // `activeRuleSetIds` is genuinely absent from the remote prefs
    // and the migration shim has work to do.
    const remoteRaw: Record<string, unknown> = { ...DEFAULT_PREFERENCES };
    delete remoteRaw['activeRuleSetIds'];
    remoteRaw['theme'] = 'light';
    remoteRaw['historyTrackingMode'] = 'all_actions';
    remoteRaw['defaultRuleSetIds'] = ['rs-stale'];
    const user = {
      id: 'u-1',
      displayName: 'Test',
      email: 'x@y.z',
      createdAt: 't',
      plan: 'free' as const,
      preferences: remoteRaw as unknown as UserPreferences,
    };
    const svc = TestBed.inject(PreferencesService);
    api.getMe.and.returnValue(of(user));
    auth.signInAs('u-1');
    TestBed.flushEffects();
    await svc.__waitForSync();
    const prefs = svc.prefs() as UserPreferences & Record<string, unknown>;
    expect(prefs.theme).toBe('light');
    expect(prefs['historyTrackingMode']).toBeUndefined();
    expect(prefs['defaultRuleSetIds']).toBeUndefined();
    expect(prefs.activeRuleSetIds).toEqual(['rs-stale']);
  });

  it('merges deep treeHighlightColors shape from storage', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        treeHighlightColors: { dark: { selectionColor: '#123456' } },
      }),
    );
    const svc = TestBed.inject(PreferencesService);
    const colors = svc.prefs().treeHighlightColors;
    expect(colors.dark.selectionColor).toBe('#123456');
    // Backfilled dark fields - regression for shallow-merge bug.
    expect(colors.dark.matchingValueColor).toBe(
      DEFAULT_PREFERENCES.treeHighlightColors.dark.matchingValueColor,
    );
    expect(colors.dark.ancestorColor).toBe(
      DEFAULT_PREFERENCES.treeHighlightColors.dark.ancestorColor,
    );
    expect(colors.dark.searchHighlightColor).toBe(
      DEFAULT_PREFERENCES.treeHighlightColors.dark.searchHighlightColor,
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
        light: { ancestorColor: '#fefefe' },
      } as UserPreferences['treeHighlightColors'],
    };
    const svc = TestBed.inject(PreferencesService);
    api.getMe.and.returnValue(of(makeUser(partial)));
    auth.signInAs('u-1');
    TestBed.flushEffects();
    await svc.__waitForSync();
    const colors = svc.prefs().treeHighlightColors;
    expect(colors.dark.selectionColor).toBe('#abcdef');
    expect(colors.dark.matchingValueColor).toBe(
      DEFAULT_PREFERENCES.treeHighlightColors.dark.matchingValueColor,
    );
    expect(colors.light.ancestorColor).toBe('#fefefe');
    expect(colors.light.selectionColor).toBe(
      DEFAULT_PREFERENCES.treeHighlightColors.light.selectionColor,
    );
  });

  it('merges deep treeDateAnnotationUnits shape from storage', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        treeDateAnnotationUnits: { year: false },
      }),
    );
    const svc = TestBed.inject(PreferencesService);

    expect(svc.prefs().treeDateAnnotationUnits).toEqual({
      ...DEFAULT_PREFERENCES.treeDateAnnotationUnits,
      year: false,
    });
  });

  it('backfills partial nested treeDateAnnotationUnits from the server', async () => {
    const partial: UserPreferences = {
      ...DEFAULT_PREFERENCES,
      treeDateAnnotationUnits: {
        year: false,
        minute: false,
      } as UserPreferences['treeDateAnnotationUnits'],
    };
    const svc = TestBed.inject(PreferencesService);
    api.getMe.and.returnValue(of(makeUser(partial)));
    auth.signInAs('u-1');
    TestBed.flushEffects();
    await svc.__waitForSync();

    expect(svc.prefs().treeDateAnnotationUnits).toEqual({
      ...DEFAULT_PREFERENCES.treeDateAnnotationUnits,
      year: false,
      minute: false,
    });
  });

  it('preserves untouched booleans when patching treeDateAnnotationUnits partially', () => {
    const svc = TestBed.inject(PreferencesService);

    svc.update(makeTreeDateAnnotationUnitsPatch({ year: false }));

    expect(svc.prefs().treeDateAnnotationUnits).toEqual({
      ...DEFAULT_PREFERENCES.treeDateAnnotationUnits,
      year: false,
    });
  });

  it('applies full treeDateAnnotationUnits patches', () => {
    const svc = TestBed.inject(PreferencesService);
    const fullUnits: UserPreferences['treeDateAnnotationUnits'] = {
      year: false,
      month: false,
      day: true,
      hour: false,
      minute: true,
      second: false,
    };

    svc.update({ treeDateAnnotationUnits: fullUnits });

    expect(svc.prefs().treeDateAnnotationUnits).toEqual(fullUnits);
  });

  it('applies treeDateAnnotationFriendlyForms boolean patches', () => {
    const svc = TestBed.inject(PreferencesService);

    svc.update({ treeDateAnnotationFriendlyForms: false });
    expect(svc.prefs().treeDateAnnotationFriendlyForms).toBeFalse();

    svc.update({ treeDateAnnotationFriendlyForms: true });
    expect(svc.prefs().treeDateAnnotationFriendlyForms).toBeTrue();
  });

  describe('pref.changed telemetry', () => {
    it('emits a string event for a changed theme', () => {
      const svc = TestBed.inject(PreferencesService);

      svc.update({ theme: 'dark' });

      expect(logger.event).toHaveBeenCalledOnceWith(
        'pref.changed',
        { key: 'theme', source: 'user', kind: 'string', value: 'dark' },
        undefined,
      );
    });

    it('emits a number event with bucket and measurement for editorFontSize', () => {
      const svc = TestBed.inject(PreferencesService);

      svc.update({ editorFontSize: 18 });

      expect(logger.event).toHaveBeenCalledOnceWith(
        'pref.changed',
        { key: 'editorFontSize', source: 'user', kind: 'number', valueBucket: '17-20' },
        { value: 18 },
      );
    });

    it('emits a count event with bucket and measurement for activeRuleSetIds', () => {
      const svc = TestBed.inject(PreferencesService);

      svc.update({ activeRuleSetIds: ['a', 'b'] });

      expect(logger.event).toHaveBeenCalledOnceWith(
        'pref.changed',
        { key: 'activeRuleSetIds', source: 'user', kind: 'count', countBucket: '<100' },
        { count: 2 },
      );
    });

    it('emits a count event with enabled-unit measurement for treeDateAnnotationUnits', () => {
      const svc = TestBed.inject(PreferencesService);

      svc.update(makeTreeDateAnnotationUnitsPatch({ year: false, second: false }));

      expect(logger.event).toHaveBeenCalledOnceWith(
        'pref.changed',
        {
          key: 'treeDateAnnotationUnits',
          source: 'user',
          kind: 'count',
          countBucket: '<100',
        },
        { count: 4 },
      );
    });

    it('emits boolean dimensions as strings', () => {
      const svc = TestBed.inject(PreferencesService);

      svc.update({ treeShowTypeLabels: false });

      expect(logger.event).toHaveBeenCalledOnceWith(
        'pref.changed',
        { key: 'treeShowTypeLabels', source: 'user', kind: 'boolean', value: 'false' },
        undefined,
      );
    });

    it('emits a boolean event for treeDateAnnotationFriendlyForms', () => {
      const svc = TestBed.inject(PreferencesService);

      svc.update({ treeDateAnnotationFriendlyForms: false });

      expect(logger.event).toHaveBeenCalledOnceWith(
        'pref.changed',
        {
          key: 'treeDateAnnotationFriendlyForms',
          source: 'user',
          kind: 'boolean',
          value: 'false',
        },
        undefined,
      );
    });

    it('emits only the changed treeHighlightColors leaf', () => {
      const svc = TestBed.inject(PreferencesService);

      svc.update(makeTreeHighlightPatch({ dark: { selectionColor: '#ff0000' } }));

      expect(logger.event).toHaveBeenCalledOnceWith(
        'pref.changed',
        {
          key: 'treeHighlightColors.dark.selectionColor',
          source: 'user',
          kind: 'color',
          isDefault: 'false',
          bucket: 'red',
        },
        undefined,
      );
    });

    it('reset emits one user-sourced event per key that differs from defaults', () => {
      const svc = TestBed.inject(PreferencesService);
      svc.update({ theme: 'dark', editorFontSize: 18, treeShowTypeLabels: false });
      logger.event.calls.reset();

      svc.reset();

      const calls = logger.event.calls.allArgs();
      expect(calls.length).toBe(3);
      expect(calls.map((callArguments) => callArguments[1]?.['source'])).toEqual([
        'user',
        'user',
        'user',
      ]);
      expect(calls.map((callArguments) => callArguments[1]?.['key'])).toEqual([
        'theme',
        'editorFontSize',
        'treeShowTypeLabels',
      ]);
    });

    it('sign-in hydration emits init-sourced events for remote preference diffs', async () => {
      const svc = TestBed.inject(PreferencesService);
      api.getMe.and.returnValue(of(makeUser({ theme: 'dark', editorFontSize: 18 })));

      auth.signInAs('u-1');
      TestBed.flushEffects();
      await svc.__waitForSync();

      expect(logger.event).toHaveBeenCalledTimes(2);
      expect(logger.event).toHaveBeenCalledWith(
        'pref.changed',
        { key: 'theme', source: 'init', kind: 'string', value: 'dark' },
        undefined,
      );
      expect(logger.event).toHaveBeenCalledWith(
        'pref.changed',
        { key: 'editorFontSize', source: 'init', kind: 'number', valueBucket: '17-20' },
        { value: 18 },
      );
    });

    it('sign-out reset emits init-sourced events for non-default current prefs', async () => {
      const svc = TestBed.inject(PreferencesService);
      api.getMe.and.returnValue(of(makeUser({ theme: 'dark', editorFontSize: 18 })));
      auth.signInAs('u-1');
      TestBed.flushEffects();
      await svc.__waitForSync();
      logger.event.calls.reset();

      auth.signOut();
      TestBed.flushEffects();

      expect(logger.event).toHaveBeenCalledTimes(2);
      expect(logger.event).toHaveBeenCalledWith(
        'pref.changed',
        { key: 'theme', source: 'init', kind: 'string', value: 'system' },
        undefined,
      );
      expect(logger.event).toHaveBeenCalledWith(
        'pref.changed',
        { key: 'editorFontSize', source: 'init', kind: 'number', valueBucket: '13-14' },
        { value: 14 },
      );
    });

    it('emits one event for each changed key in a multi-key patch', () => {
      const svc = TestBed.inject(PreferencesService);

      svc.update({ theme: 'dark', editorFontSize: 18 });

      expect(logger.event).toHaveBeenCalledTimes(2);
      expect(logger.event).toHaveBeenCalledWith(
        'pref.changed',
        { key: 'theme', source: 'user', kind: 'string', value: 'dark' },
        undefined,
      );
      expect(logger.event).toHaveBeenCalledWith(
        'pref.changed',
        { key: 'editorFontSize', source: 'user', kind: 'number', valueBucket: '17-20' },
        { value: 18 },
      );
    });

    it('does not emit when theme is already system', () => {
      const svc = TestBed.inject(PreferencesService);

      svc.update({ theme: 'system' });

      expect(logger.event).not.toHaveBeenCalled();
    });

    it('does not emit for an empty patch', () => {
      const svc = TestBed.inject(PreferencesService);

      svc.update({});

      expect(logger.event).not.toHaveBeenCalled();
    });

    it('does not emit when editorFontSize is unchanged', () => {
      const svc = TestBed.inject(PreferencesService);

      svc.update({ editorFontSize: 14 });

      expect(logger.event).not.toHaveBeenCalled();
    });

    it('does not emit during constructor initial load', () => {
      TestBed.inject(PreferencesService);

      expect(logger.event).not.toHaveBeenCalled();
    });

    it('does not emit when matchMedia recomputes the system theme', () => {
      const systemThemeChangeListeners: Array<() => void> = [];
      spyOn(window, 'matchMedia').and.callFake(
        (query: string): MediaQueryList => ({
          matches: true,
          media: query,
          onchange: null,
          addEventListener: (
            type: string,
            listener: EventListenerOrEventListenerObject | null,
          ): void => {
            if (type !== 'change' || listener === null) {
              return;
            }
            systemThemeChangeListeners.push((): void => {
              const event = new Event('change');
              if (typeof listener === 'function') {
                listener(event);
              } else {
                listener.handleEvent(event);
              }
            });
          },
          removeEventListener: (): void => undefined,
          dispatchEvent: (): boolean => true,
          addListener: (): void => undefined,
          removeListener: (): void => undefined,
        }),
      );
      const svc = TestBed.inject(PreferencesService);
      logger.event.calls.reset();

      for (const fireSystemThemeChange of systemThemeChangeListeners) {
        fireSystemThemeChange();
      }
      TestBed.flushEffects();

      expect(svc.prefs().theme).toBe('system');
      expect(logger.event).not.toHaveBeenCalled();
    });

    it('does not emit when a treeHighlightColors leaf is unchanged', () => {
      const svc = TestBed.inject(PreferencesService);

      svc.update(makeTreeHighlightPatch({ dark: { selectionColor: '#264f78' } }));

      expect(logger.event).not.toHaveBeenCalled();
    });

    it('emits a boolean event for treeAutoFitToWindow', () => {
      const svc = TestBed.inject(PreferencesService);

      svc.update({ treeAutoFitToWindow: false });

      expect(logger.event).toHaveBeenCalledOnceWith(
        'pref.changed',
        { key: 'treeAutoFitToWindow', source: 'user', kind: 'boolean', value: 'false' },
        undefined,
      );
    });
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
        DEFAULT_PREFERENCES.treeHighlightColors.dark.selectionColor,
      );
      svc.update({
        treeHighlightColors: {
          ...svc.prefs().treeHighlightColors,
          dark: {
            ...svc.prefs().treeHighlightColors.dark,
            selectionColor: '#aabbcc',
          },
        },
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
            selectionColor: '#ff0000',
          },
        },
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
            selectionColor: '#deadbe',
          },
        },
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
        DEFAULT_PREFERENCES.treeHighlightColors[effective].selectionColor,
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
            dark: { ...base.dark, selectionColor: '#111111' },
          },
        });
        svc.update({
          treeHighlightColors: {
            ...svc.prefs().treeHighlightColors,
            dark: { ...svc.prefs().treeHighlightColors.dark, selectionColor: '#222222' },
          },
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

  describe('treeAutoFitToWindow one-shot migration', () => {
    it('sets treeAutoFitToWindow=true when depth is 2 (default) and field is absent', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ defaultTreeExpansionDepth: 2 }));
      const svc = TestBed.inject(PreferencesService);
      expect(svc.prefs().treeAutoFitToWindow).toBe(true);
    });

    it('sets treeAutoFitToWindow=false when depth is customized and field is absent', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ defaultTreeExpansionDepth: 5 }));
      const svc = TestBed.inject(PreferencesService);
      expect(svc.prefs().treeAutoFitToWindow).toBe(false);
    });

    it('respects explicit treeAutoFitToWindow=false even when depth is 2', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ defaultTreeExpansionDepth: 2, treeAutoFitToWindow: false }),
      );
      const svc = TestBed.inject(PreferencesService);
      expect(svc.prefs().treeAutoFitToWindow).toBe(false);
    });

    it('sets treeAutoFitToWindow=true when neither depth nor treeAutoFitToWindow is present', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: 'dark' }));
      const svc = TestBed.inject(PreferencesService);
      expect(svc.prefs().treeAutoFitToWindow).toBe(true);
    });

    it('new user (no prefs at all) gets treeAutoFitToWindow=true', () => {
      const svc = TestBed.inject(PreferencesService);
      expect(svc.prefs().treeAutoFitToWindow).toBe(true);
    });
  });
});
