import { HttpErrorResponse } from '@angular/common/http';
import { PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import type { User, UserPreferences } from '../api/models';
import {
  UserApiService,
  type PreferencesWithEtag,
  type UserWithEtag,
} from '../api/user-api.service';
import { AuthService } from '../auth/auth.service';
import { LoggerService } from '../telemetry/logger.service';
import { DEFAULT_PREFERENCES, PreferencesService } from './preferences.service';

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
  getMe = jasmine.createSpy('getMe').and.returnValue(of<UserWithEtag | null>(null));
  seed = jasmine.createSpy('seed').and.callFake((prefs: UserPreferences) =>
    of<UserWithEtag>({
      user: {
        id: 'u-1',
        displayName: 'Test',
        email: 'x@y.z',
        createdAt: 't',
        plan: 'free',
        preferences: prefs,
      },
      etag: '"1"',
    }),
  );
  putPreferences = jasmine
    .createSpy('putPreferences')
    .and.callFake((p: UserPreferences, _ifMatch: string) =>
      of<PreferencesWithEtag>({ preferences: p, etag: '"2"' }),
    );
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

function makeUserResponse(
  overrides: Partial<UserPreferences> = {},
  etag: string | null = '"1"',
): UserWithEtag {
  return { user: makeUser(overrides), etag };
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
    // recentlyViewedEnabled defaults to true; the API strips
    // `historyTrackingMode` on read but does not synthesize a value
    // from it - the boolean default comes from DEFAULT_PREFERENCES.
    expect(prefs.recentlyViewedEnabled).toBe(DEFAULT_PREFERENCES.recentlyViewedEnabled);
    // The legacy array shape is folded by the frontend
    // `mergeWithDefaults` (defense-in-depth for stale localStorage);
    // the API itself no longer folds rule-set IDs - it strips legacy
    // keys and defaults `activeRuleSetIds` to [].
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
    api.getMe.and.returnValue(of({ user, etag: '"1"' }));
    auth.signInAs('u-1');
    TestBed.flushEffects();
    await svc.__waitForSync();
    const prefs = svc.prefs() as UserPreferences & Record<string, unknown>;
    expect(prefs.theme).toBe('light');
    expect(prefs['historyTrackingMode']).toBeUndefined();
    expect(prefs['defaultRuleSetIds']).toBeUndefined();
    expect(prefs.activeRuleSetIds).toEqual(['rs-stale']);
  });

  describe('searchRegexMode -> searchMatchMode fold (mergeWithDefaults)', () => {
    // Schema evolution rename: the legacy boolean `searchRegexMode`
    // folds into the new string enum `searchMatchMode` in
    // `mergeWithDefaults`. The 6 cases below pin precedence.
    it('legacy true alone -> regex', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ searchRegexMode: true }));
      const svc = TestBed.inject(PreferencesService);
      const prefs = svc.prefs() as UserPreferences & Record<string, unknown>;
      expect(prefs.searchMatchMode).toBe('regex');
      expect(prefs['searchRegexMode']).toBeUndefined();
    });

    it('legacy false alone -> contains', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ searchRegexMode: false }));
      const svc = TestBed.inject(PreferencesService);
      const prefs = svc.prefs() as UserPreferences & Record<string, unknown>;
      expect(prefs.searchMatchMode).toBe('contains');
      expect(prefs['searchRegexMode']).toBeUndefined();
    });

    it('legacy absent -> default contains', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: 'dark' }));
      const svc = TestBed.inject(PreferencesService);
      expect(svc.prefs().searchMatchMode).toBe('contains');
    });

    it('new field valid + legacy present -> new wins, legacy stripped', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ searchMatchMode: 'starts_with', searchRegexMode: true }),
      );
      const svc = TestBed.inject(PreferencesService);
      const prefs = svc.prefs() as UserPreferences & Record<string, unknown>;
      expect(prefs.searchMatchMode).toBe('starts_with');
      expect(prefs['searchRegexMode']).toBeUndefined();
    });

    it('new field invalid + legacy true -> fold to regex', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ searchMatchMode: 'bogus', searchRegexMode: true }),
      );
      const svc = TestBed.inject(PreferencesService);
      const prefs = svc.prefs() as UserPreferences & Record<string, unknown>;
      expect(prefs.searchMatchMode).toBe('regex');
      expect(prefs['searchRegexMode']).toBeUndefined();
    });

    it('legacy non-boolean (string "true") -> strict bool check -> contains', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ searchRegexMode: 'true' }));
      const svc = TestBed.inject(PreferencesService);
      const prefs = svc.prefs() as UserPreferences & Record<string, unknown>;
      expect(prefs.searchMatchMode).toBe('contains');
      expect(prefs['searchRegexMode']).toBeUndefined();
    });
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
    expect(colors.dark.manualHighlightColor).toBe(
      DEFAULT_PREFERENCES.treeHighlightColors.dark.manualHighlightColor,
    );
    expect(colors.light).toEqual(DEFAULT_PREFERENCES.treeHighlightColors.light);
  });

  it('backfills missing manualHighlightColor when hydrating legacy stored colors', () => {
    const legacyColors = structuredClone(
      DEFAULT_PREFERENCES.treeHighlightColors,
    ) as unknown as Record<string, Record<string, unknown>>;
    delete legacyColors['dark']?.['manualHighlightColor'];
    delete legacyColors['light']?.['manualHighlightColor'];
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ treeHighlightColors: legacyColors }));
    const svc = TestBed.inject(PreferencesService);
    const colors = svc.prefs().treeHighlightColors;
    expect(colors.dark.manualHighlightColor).toBe(
      DEFAULT_PREFERENCES.treeHighlightColors.dark.manualHighlightColor,
    );
    expect(colors.light.manualHighlightColor).toBe(
      DEFAULT_PREFERENCES.treeHighlightColors.light.manualHighlightColor,
    );
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
    api.getMe.and.returnValue(of(makeUserResponse(partial)));
    auth.signInAs('u-1');
    TestBed.flushEffects();
    await svc.__waitForSync();
    const colors = svc.prefs().treeHighlightColors;
    expect(colors.dark.selectionColor).toBe('#abcdef');
    expect(colors.dark.matchingValueColor).toBe(
      DEFAULT_PREFERENCES.treeHighlightColors.dark.matchingValueColor,
    );
    expect(colors.dark.manualHighlightColor).toBe(
      DEFAULT_PREFERENCES.treeHighlightColors.dark.manualHighlightColor,
    );
    expect(colors.light.ancestorColor).toBe('#fefefe');
    expect(colors.light.selectionColor).toBe(
      DEFAULT_PREFERENCES.treeHighlightColors.light.selectionColor,
    );
    expect(colors.light.manualHighlightColor).toBe(
      DEFAULT_PREFERENCES.treeHighlightColors.light.manualHighlightColor,
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
    api.getMe.and.returnValue(of(makeUserResponse(partial)));
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
    // The PreferencesService constructor emits a `theme.applied`
    // event with `source: 'boot'` (see `theme.applied telemetry`
    // describe below). Tests in this block focus on `pref.changed`
    // and reset the spy after construction so existing assertions
    // about the call count / shape of `pref.changed` are not
    // affected by the boot emit.
    function injectPrefs(): PreferencesService {
      const svc = TestBed.inject(PreferencesService);
      logger.event.calls.reset();
      return svc;
    }

    it('emits a string event for a changed theme', () => {
      const svc = injectPrefs();

      svc.update({ theme: 'dark' });

      // `update({ theme: 'dark' })` also triggers `theme.applied` when
      // the effective theme moves, so the global spy can see more than
      // one call. Still assert exactly one `pref.changed` so a
      // regression that duplicates the pref-change emit would fail.
      const prefChangedCalls = logger.event.calls
        .allArgs()
        .filter((args) => args[0] === 'pref.changed');
      expect(prefChangedCalls.length).toBe(1);
      expect(logger.event).toHaveBeenCalledWith(
        'pref.changed',
        { key: 'theme', source: 'user', kind: 'string', value: 'dark' },
        undefined,
      );
    });

    it('emits a string event for a changed coldBootClipboardAutoPaste', () => {
      const svc = injectPrefs();

      svc.update({ coldBootClipboardAutoPaste: 'always' });

      expect(logger.event).toHaveBeenCalledOnceWith(
        'pref.changed',
        {
          key: 'coldBootClipboardAutoPaste',
          source: 'user',
          kind: 'string',
          value: 'always',
        },
        undefined,
      );
    });

    it('emits a string event for a changed searchMatchMode', () => {
      const svc = injectPrefs();

      svc.update({ searchMatchMode: 'starts_with' });

      expect(logger.event).toHaveBeenCalledOnceWith(
        'pref.changed',
        { key: 'searchMatchMode', source: 'user', kind: 'string', value: 'starts_with' },
        undefined,
      );
    });

    it('emits a number event with bucket and measurement for editorFontSize', () => {
      const svc = injectPrefs();

      svc.update({ editorFontSize: 18 });

      expect(logger.event).toHaveBeenCalledOnceWith(
        'pref.changed',
        { key: 'editorFontSize', source: 'user', kind: 'number', valueBucket: '17-20' },
        { value: 18 },
      );
    });

    it('emits a count event with bucket and measurement for activeRuleSetIds', () => {
      const svc = injectPrefs();

      svc.update({ activeRuleSetIds: ['a', 'b'] });

      expect(logger.event).toHaveBeenCalledOnceWith(
        'pref.changed',
        { key: 'activeRuleSetIds', source: 'user', kind: 'count', countBucket: '<100' },
        { count: 2 },
      );
    });

    it('emits a count event with enabled-unit measurement for treeDateAnnotationUnits', () => {
      const svc = injectPrefs();

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
      const svc = injectPrefs();

      svc.update({ treeShowTypeLabels: false });

      expect(logger.event).toHaveBeenCalledOnceWith(
        'pref.changed',
        { key: 'treeShowTypeLabels', source: 'user', kind: 'boolean', value: 'false' },
        undefined,
      );
    });

    it('emits a boolean event for treeDateAnnotationFriendlyForms', () => {
      const svc = injectPrefs();

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
      const svc = injectPrefs();

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

    it('emits a color event when dark manualHighlightColor changes', () => {
      const svc = injectPrefs();

      svc.update(makeTreeHighlightPatch({ dark: { manualHighlightColor: '#ff0000' } }));

      expect(logger.event).toHaveBeenCalledOnceWith(
        'pref.changed',
        {
          key: 'treeHighlightColors.dark.manualHighlightColor',
          source: 'user',
          kind: 'color',
          isDefault: 'false',
          bucket: 'red',
        },
        undefined,
      );
    });

    it('emits a color event when light manualHighlightColor changes', () => {
      const svc = injectPrefs();

      svc.update(makeTreeHighlightPatch({ light: { manualHighlightColor: '#00ff00' } }));

      expect(logger.event).toHaveBeenCalledOnceWith(
        'pref.changed',
        {
          key: 'treeHighlightColors.light.manualHighlightColor',
          source: 'user',
          kind: 'color',
          isDefault: 'false',
          bucket: 'green',
        },
        undefined,
      );
    });

    it('reset emits one user-sourced event per key that differs from defaults', () => {
      const svc = injectPrefs();
      svc.update({ theme: 'dark', editorFontSize: 18, treeShowTypeLabels: false });
      logger.event.calls.reset();

      svc.reset();

      const prefChangedCalls = logger.event.calls
        .allArgs()
        .filter((args) => args[0] === 'pref.changed');
      expect(prefChangedCalls.length).toBe(3);
      expect(prefChangedCalls.map((callArguments) => callArguments[1]?.['source'])).toEqual([
        'user',
        'user',
        'user',
      ]);
      expect(prefChangedCalls.map((callArguments) => callArguments[1]?.['key'])).toEqual([
        'theme',
        'editorFontSize',
        'treeShowTypeLabels',
      ]);
    });

    it('sign-in hydration emits init-sourced events for remote preference diffs', async () => {
      const svc = injectPrefs();
      api.getMe.and.returnValue(of(makeUserResponse({ theme: 'dark', editorFontSize: 18 })));

      auth.signInAs('u-1');
      TestBed.flushEffects();
      await svc.__waitForSync();

      const prefChangedCalls = logger.event.calls
        .allArgs()
        .filter((args) => args[0] === 'pref.changed');
      expect(prefChangedCalls.length).toBe(2);
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
      const svc = injectPrefs();
      api.getMe.and.returnValue(of(makeUserResponse({ theme: 'dark', editorFontSize: 18 })));
      auth.signInAs('u-1');
      TestBed.flushEffects();
      await svc.__waitForSync();
      logger.event.calls.reset();

      auth.signOut();
      TestBed.flushEffects();

      const prefChangedCalls = logger.event.calls
        .allArgs()
        .filter((args) => args[0] === 'pref.changed');
      expect(prefChangedCalls.length).toBe(2);
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
      const svc = injectPrefs();

      svc.update({ theme: 'dark', editorFontSize: 18 });

      const prefChangedCalls = logger.event.calls
        .allArgs()
        .filter((args) => args[0] === 'pref.changed');
      expect(prefChangedCalls.length).toBe(2);
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
      const svc = injectPrefs();

      svc.update({ theme: 'system' });

      expect(logger.event).not.toHaveBeenCalled();
    });

    it('does not emit for an empty patch', () => {
      const svc = injectPrefs();

      svc.update({});

      expect(logger.event).not.toHaveBeenCalled();
    });

    it('does not emit when editorFontSize is unchanged', () => {
      const svc = injectPrefs();

      svc.update({ editorFontSize: 14 });

      expect(logger.event).not.toHaveBeenCalled();
    });

    it('does not emit pref.changed during constructor initial load', () => {
      TestBed.inject(PreferencesService);

      // The constructor emits exactly one `theme.applied` boot event;
      // it must NOT emit any `pref.changed` events because no
      // preference actually changed (only resolution happened).
      const prefChangedCalls = logger.event.calls
        .allArgs()
        .filter((args) => args[0] === 'pref.changed');
      expect(prefChangedCalls.length).toBe(0);
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
      // matchMedia.matches stays true across the synthetic change, so
      // effective theme stays 'light' and `theme.applied` dedupes
      // away. `pref.changed` never fires either because the stored
      // pref didn't change.
      expect(logger.event).not.toHaveBeenCalled();
    });

    it('does not emit when a treeHighlightColors leaf is unchanged', () => {
      const svc = injectPrefs();

      svc.update(makeTreeHighlightPatch({ dark: { selectionColor: '#264f78' } }));

      expect(logger.event).not.toHaveBeenCalled();
    });

    it('emits a boolean event for treeAutoFitToWindow', () => {
      const svc = injectPrefs();

      svc.update({ treeAutoFitToWindow: false });

      expect(logger.event).toHaveBeenCalledOnceWith(
        'pref.changed',
        { key: 'treeAutoFitToWindow', source: 'user', kind: 'boolean', value: 'false' },
        undefined,
      );
    });
  });

  describe('theme.applied telemetry', () => {
    /**
     * Stubs `window.matchMedia` deterministically so dedupe behavior
     * across boot / osChange / pref-change emits is observable. The
     * returned `fireChange()` invokes every registered `'change'`
     * listener once.
     */
    function stubMatchMedia(initialPrefersLight: boolean): { fireChange: () => void } {
      let prefersLight = initialPrefersLight;
      const changeListeners: Array<EventListenerOrEventListenerObject> = [];
      spyOn(window, 'matchMedia').and.callFake(
        (query: string): MediaQueryList => ({
          get matches(): boolean {
            // Only the `(prefers-color-scheme: light)` query is
            // meaningful for this test; default everything else to false.
            return query.includes('light') ? prefersLight : false;
          },
          media: query,
          onchange: null,
          addEventListener: (
            type: string,
            listener: EventListenerOrEventListenerObject | null,
          ): void => {
            if (type === 'change' && listener !== null) {
              changeListeners.push(listener);
            }
          },
          removeEventListener: (): void => undefined,
          dispatchEvent: (): boolean => true,
          addListener: (): void => undefined,
          removeListener: (): void => undefined,
        }),
      );
      return {
        fireChange: (): void => {
          prefersLight = !prefersLight;
          const event = new Event('change');
          for (const listener of changeListeners) {
            if (typeof listener === 'function') listener(event);
            else listener.handleEvent(event);
          }
        },
      };
    }

    function themeAppliedCalls(): Array<{
      effective: 'dark' | 'light';
      pref: UserPreferences['theme'];
      source: string;
    }> {
      return logger.event.calls.allArgs().reduce<
        Array<{
          effective: 'dark' | 'light';
          pref: UserPreferences['theme'];
          source: string;
        }>
      >((acc, args) => {
        if (args[0] !== 'theme.applied') return acc;
        const props = args[1] as {
          effective: 'dark' | 'light';
          pref: UserPreferences['theme'];
          source: string;
        };
        acc.push({ effective: props.effective, pref: props.pref, source: props.source });
        return acc;
      }, []);
    }

    it('boot emit on explicit dark pref', () => {
      stubMatchMedia(true);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: 'dark' }));

      TestBed.inject(PreferencesService);

      expect(themeAppliedCalls()).toEqual([{ effective: 'dark', pref: 'dark', source: 'boot' }]);
    });

    it('boot emit on system pref reads matchMedia', () => {
      stubMatchMedia(true);

      TestBed.inject(PreferencesService);

      expect(themeAppliedCalls()).toEqual([{ effective: 'light', pref: 'system', source: 'boot' }]);
    });

    it('boot emit falls back to dark when matchMedia is absent', () => {
      // Older browsers / non-DOM contexts. The fallback at
      // resolveEffectiveTheme line 124 returns 'dark'.
      const originalMatchMedia = window.matchMedia;
      (window as { matchMedia?: typeof window.matchMedia }).matchMedia =
        undefined as unknown as typeof window.matchMedia;
      try {
        TestBed.inject(PreferencesService);

        expect(themeAppliedCalls()).toEqual([
          { effective: 'dark', pref: 'system', source: 'boot' },
        ]);
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    });

    it('boot emit still fires when localStorage is corrupt (defaults apply)', () => {
      stubMatchMedia(false);
      localStorage.setItem(STORAGE_KEY, '{not json');

      TestBed.inject(PreferencesService);

      // mergeWithDefaults wraps in try/catch and yields DEFAULTS
      // (`theme: 'system'`); matchMedia stub returns dark.
      expect(themeAppliedCalls()).toEqual([{ effective: 'dark', pref: 'system', source: 'boot' }]);
    });

    it('osChange emit on matchMedia flip while pref is system', () => {
      const { fireChange } = stubMatchMedia(false);

      TestBed.inject(PreferencesService);
      logger.event.calls.reset();

      fireChange();
      TestBed.flushEffects();

      expect(themeAppliedCalls()).toEqual([
        { effective: 'light', pref: 'system', source: 'osChange' },
      ]);
    });

    it('osChange dedupes when effective theme does not change', () => {
      // matchMedia change fires but `matches` stays the same:
      // effective is still dark, dedupe skips the emit.
      let prefersLight = false;
      const changeListeners: Array<EventListenerOrEventListenerObject> = [];
      spyOn(window, 'matchMedia').and.callFake(
        (query: string): MediaQueryList => ({
          get matches(): boolean {
            return query.includes('light') ? prefersLight : false;
          },
          media: query,
          onchange: null,
          addEventListener: (
            type: string,
            listener: EventListenerOrEventListenerObject | null,
          ): void => {
            if (type === 'change' && listener !== null) changeListeners.push(listener);
          },
          removeEventListener: (): void => undefined,
          dispatchEvent: (): boolean => true,
          addListener: (): void => undefined,
          removeListener: (): void => undefined,
        }),
      );
      TestBed.inject(PreferencesService);
      logger.event.calls.reset();

      // Fire the synthetic change WITHOUT toggling prefersLight: the
      // listener resignals but `effectiveTheme()` is still 'dark'.
      void prefersLight;
      for (const listener of changeListeners) {
        const event = new Event('change');
        if (typeof listener === 'function') listener(event);
        else listener.handleEvent(event);
      }
      TestBed.flushEffects();

      expect(themeAppliedCalls()).toEqual([]);
    });

    it('user-source emit when pref change moves effective theme', () => {
      stubMatchMedia(false);
      const svc = TestBed.inject(PreferencesService);
      logger.event.calls.reset();

      svc.update({ theme: 'light' });

      expect(themeAppliedCalls()).toEqual([{ effective: 'light', pref: 'light', source: 'user' }]);
    });

    it('dedupes when pref change does not move effective theme', () => {
      // matchMedia returns dark; boot emits dark. User flips
      // pref to 'system' -- effective resolves to dark again, so
      // the dedupe drops the emit.
      stubMatchMedia(false);
      const svc = TestBed.inject(PreferencesService);
      logger.event.calls.reset();

      svc.update({ theme: 'system' });

      expect(themeAppliedCalls()).toEqual([]);
    });

    it('init-source emit on sign-in hydration that moves effective theme', async () => {
      stubMatchMedia(true); // boot resolves to 'light'
      const svc = TestBed.inject(PreferencesService);
      api.getMe.and.returnValue(of(makeUserResponse({ theme: 'dark' })));
      logger.event.calls.reset();

      auth.signInAs('u-1');
      TestBed.flushEffects();
      await svc.__waitForSync();

      expect(themeAppliedCalls()).toEqual([{ effective: 'dark', pref: 'dark', source: 'init' }]);
    });

    it('init-source emit on sign-out reset that moves effective theme', async () => {
      stubMatchMedia(true); // anon resolves to 'light' on system pref
      const svc = TestBed.inject(PreferencesService);
      api.getMe.and.returnValue(of(makeUserResponse({ theme: 'dark' })));
      auth.signInAs('u-1');
      TestBed.flushEffects();
      await svc.__waitForSync();
      logger.event.calls.reset();

      auth.signOut();
      TestBed.flushEffects();

      // Defaults reapply (theme: 'system'); matchMedia stub returns
      // 'light', so effective swings dark -> light.
      expect(themeAppliedCalls()).toEqual([{ effective: 'light', pref: 'system', source: 'init' }]);
    });

    it('does not emit on the server platform', () => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          { provide: AuthService, useValue: auth },
          { provide: UserApiService, useValue: api },
          { provide: LoggerService, useValue: logger },
          { provide: PLATFORM_ID, useValue: 'server' },
        ],
      });

      TestBed.inject(PreferencesService);

      expect(themeAppliedCalls()).toEqual([]);
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
      api.getMe.and.returnValue(of(makeUserResponse(customized)));
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
        api.getMe.and.returnValue(of(makeUserResponse()));
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

  describe('theme-color meta tags', () => {
    function installThemeColorMetas(): {
      darkMeta: HTMLMetaElement;
      lightMeta: HTMLMetaElement;
    } {
      const darkMeta = document.createElement('meta');
      darkMeta.id = 'meta-theme-color-dark';
      darkMeta.name = 'theme-color';
      darkMeta.content = '#1e1e1e';
      darkMeta.setAttribute('media', '(prefers-color-scheme: dark)');
      document.head.appendChild(darkMeta);

      const lightMeta = document.createElement('meta');
      lightMeta.id = 'meta-theme-color-light';
      lightMeta.name = 'theme-color';
      lightMeta.content = '#fafafa';
      lightMeta.setAttribute('media', '(prefers-color-scheme: light)');
      document.head.appendChild(lightMeta);

      return { darkMeta, lightMeta };
    }

    function removeThemeColorMetas(): void {
      document.getElementById('meta-theme-color-dark')?.remove();
      document.getElementById('meta-theme-color-light')?.remove();
    }

    afterEach(() => {
      removeThemeColorMetas();
    });

    it('keeps both tags media-scoped when theme is "system"', () => {
      const { darkMeta, lightMeta } = installThemeColorMetas();
      const svc = TestBed.inject(PreferencesService);
      svc.update({ theme: 'system' });
      TestBed.flushEffects();
      expect(darkMeta.getAttribute('media')).toBe('(prefers-color-scheme: dark)');
      expect(darkMeta.content).toBe('#1e1e1e');
      expect(lightMeta.getAttribute('media')).toBe('(prefers-color-scheme: light)');
      expect(lightMeta.content).toBe('#fafafa');
    });

    it('strips media and forces dark color on both tags when theme is "dark"', () => {
      const { darkMeta, lightMeta } = installThemeColorMetas();
      const svc = TestBed.inject(PreferencesService);
      svc.update({ theme: 'dark' });
      TestBed.flushEffects();
      expect(darkMeta.hasAttribute('media')).toBe(false);
      expect(darkMeta.content).toBe('#1e1e1e');
      expect(lightMeta.hasAttribute('media')).toBe(false);
      expect(lightMeta.content).toBe('#1e1e1e');
    });

    it('strips media and forces light color on both tags when theme is "light"', () => {
      const { darkMeta, lightMeta } = installThemeColorMetas();
      const svc = TestBed.inject(PreferencesService);
      svc.update({ theme: 'light' });
      TestBed.flushEffects();
      expect(darkMeta.hasAttribute('media')).toBe(false);
      expect(darkMeta.content).toBe('#fafafa');
      expect(lightMeta.hasAttribute('media')).toBe(false);
      expect(lightMeta.content).toBe('#fafafa');
    });

    it('restores both media-scoped tags on transition from explicit to system', () => {
      const { darkMeta, lightMeta } = installThemeColorMetas();
      const svc = TestBed.inject(PreferencesService);
      svc.update({ theme: 'dark' });
      TestBed.flushEffects();
      expect(darkMeta.hasAttribute('media')).toBe(false);
      svc.update({ theme: 'system' });
      TestBed.flushEffects();
      expect(darkMeta.getAttribute('media')).toBe('(prefers-color-scheme: dark)');
      expect(darkMeta.content).toBe('#1e1e1e');
      expect(lightMeta.getAttribute('media')).toBe('(prefers-color-scheme: light)');
      expect(lightMeta.content).toBe('#fafafa');
    });

    it('is a no-op when the meta tags are absent (defensive)', () => {
      const svc = TestBed.inject(PreferencesService);
      expect(() => {
        svc.update({ theme: 'dark' });
        TestBed.flushEffects();
      }).not.toThrow();
    });
  });

  describe('sync lifecycle', () => {
    it('replaces local prefs with the server copy when the user doc exists (remote wins)', async () => {
      const svc = TestBed.inject(PreferencesService);
      svc.update({ theme: 'dark', editorFontSize: 20 });
      TestBed.flushEffects();
      api.getMe.and.returnValue(of(makeUserResponse({ theme: 'light', editorFontSize: 16 })));
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
      api.getMe.and.returnValue(of(makeUserResponse({ theme: 'light', editorFontSize: 22 })));
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
        api.getMe.and.returnValue(of(makeUserResponse()));
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
      const slow = new Subject<UserWithEtag | null>();
      api.getMe.and.returnValue(slow.asObservable());
      auth.signInAs('u-1');
      TestBed.flushEffects();
      // User changes before the first hydration completes.
      auth.signOut();
      TestBed.flushEffects();
      // Late response for user u-1 must be ignored.
      slow.next(makeUserResponse({ theme: 'light' }));
      slow.complete();
      expect(svc.syncState()).toBe('anon');
      expect(svc.prefs()).toEqual(DEFAULT_PREFERENCES);
    });

    it('threads the latest etag from getMe -> putPreferences', async () => {
      jasmine.clock().install();
      try {
        const svc = TestBed.inject(PreferencesService);
        api.getMe.and.returnValue(of(makeUserResponse({}, '"7"')));
        auth.signInAs('u-1');
        TestBed.flushEffects();
        await svc.__waitForSync();
        svc.update({ theme: 'dark' });
        TestBed.flushEffects();
        jasmine.clock().tick(600);
        expect(api.putPreferences).toHaveBeenCalledTimes(1);
        const ifMatch = api.putPreferences.calls.mostRecent().args[1];
        expect(ifMatch).toBe('"7"');
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('threads the latest etag from a successful PUT into the next PUT', async () => {
      jasmine.clock().install();
      try {
        const svc = TestBed.inject(PreferencesService);
        api.getMe.and.returnValue(of(makeUserResponse({}, '"1"')));
        // Each successive PUT returns an incrementing etag.
        let nextEtag = 2;
        api.putPreferences.and.callFake((p: UserPreferences) =>
          of<PreferencesWithEtag>({ preferences: p, etag: `"${nextEtag++}"` }),
        );
        auth.signInAs('u-1');
        TestBed.flushEffects();
        await svc.__waitForSync();
        svc.update({ theme: 'dark' });
        TestBed.flushEffects();
        jasmine.clock().tick(600);
        expect(api.putPreferences.calls.count()).toBe(1);
        expect(api.putPreferences.calls.argsFor(0)[1]).toBe('"1"');
        // After the response handler ran synchronously, lastKnownEtag
        // should be '"2"'. The next user edit should send "2".
        svc.update({ editorFontSize: 18 });
        TestBed.flushEffects();
        jasmine.clock().tick(600);
        expect(api.putPreferences.calls.count()).toBe(2);
        expect(api.putPreferences.calls.argsFor(1)[1]).toBe('"2"');
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('serializes in-flight writes (no second PUT until first completes)', async () => {
      jasmine.clock().install();
      try {
        const svc = TestBed.inject(PreferencesService);
        api.getMe.and.returnValue(of(makeUserResponse({}, '"1"')));
        // First PUT is held open via a Subject; second update arrives
        // while the first is still in flight.
        const firstPut = new Subject<PreferencesWithEtag>();
        api.putPreferences.and.returnValue(firstPut.asObservable());
        auth.signInAs('u-1');
        TestBed.flushEffects();
        await svc.__waitForSync();
        svc.update({ theme: 'dark' });
        TestBed.flushEffects();
        jasmine.clock().tick(600);
        expect(api.putPreferences.calls.count()).toBe(1);
        // While the first PUT is still pending, the user makes another
        // change. We must NOT fire a second PUT yet (would be stale
        // IfMatch).
        svc.update({ editorFontSize: 18 });
        TestBed.flushEffects();
        jasmine.clock().tick(600);
        expect(api.putPreferences.calls.count()).toBe(1);
        // Now the first PUT resolves with a fresh etag. The pending
        // dirty flag should re-fire the debounce; switch the spy back
        // to the default success behavior so the follow-up PUT can
        // complete.
        api.putPreferences.and.callFake((p: UserPreferences) =>
          of<PreferencesWithEtag>({ preferences: p, etag: '"3"' }),
        );
        firstPut.next({ preferences: svc.prefs(), etag: '"2"' });
        firstPut.complete();
        await Promise.resolve();
        TestBed.flushEffects();
        jasmine.clock().tick(600);
        expect(api.putPreferences.calls.count()).toBe(2);
        // The second PUT must use the FRESH etag from the first
        // response, not the original "1".
        expect(api.putPreferences.calls.argsFor(1)[1]).toBe('"2"');
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('on 412 conflict refetches, replaces local, and emits a conflict event', async () => {
      jasmine.clock().install();
      try {
        const svc = TestBed.inject(PreferencesService);
        api.getMe.and.returnValue(of(makeUserResponse({ theme: 'system' }, '"1"')));
        auth.signInAs('u-1');
        TestBed.flushEffects();
        await svc.__waitForSync();
        // Subscribe to events$ before we trigger the conflict.
        const events: Array<{ kind: string }> = [];
        svc.events$.subscribe((event) => events.push(event));
        // The user changes prefs; the server returns 412.
        api.putPreferences.and.returnValue(
          throwError(() => new HttpErrorResponse({ status: 412, statusText: 'PF' })),
        );
        // Next getMe (post-conflict refetch) returns server prefs that
        // differ from the user's local copy.
        api.getMe.and.returnValue(of(makeUserResponse({ theme: 'light' }, '"5"')));
        svc.update({ theme: 'dark' });
        TestBed.flushEffects();
        jasmine.clock().tick(600);
        await Promise.resolve();
        await Promise.resolve();
        expect(api.putPreferences.calls.count()).toBe(1);
        // Local prefs replaced with server's "light".
        expect(svc.prefs().theme).toBe('light');
        expect(events.length).toBe(1);
        expect(events[0]?.kind).toBe('conflict');
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('on seed 409 silently refetches via getMe and adopts server state', async () => {
      const svc = TestBed.inject(PreferencesService);
      // First getMe says no doc; seed races and gets 409; the recovery
      // getMe returns the winning tab's user state.
      api.getMe.and.returnValues(
        of(null),
        of(makeUserResponse({ theme: 'light', editorFontSize: 22 }, '"1"')),
      );
      api.seed.and.returnValue(
        throwError(() => new HttpErrorResponse({ status: 409, statusText: 'C' })),
      );
      const events: Array<{ kind: string }> = [];
      svc.events$.subscribe((event) => events.push(event));
      auth.signInAs('u-1');
      TestBed.flushEffects();
      const end = await svc.__waitForSync();
      expect(end).toBe('synced');
      expect(svc.prefs().theme).toBe('light');
      expect(svc.prefs().editorFontSize).toBe(22);
      // Per plan, this recovery is silent (no toast / event).
      expect(events.length).toBe(0);
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
