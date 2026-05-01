import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';
import type { ThemeColorSet, TreeHighlightColors, UserPreferences } from '../api/models';
import { UserApiService } from '../api/user-api.service';
import { AuthService } from '../auth/auth.service';
import { bucketCount } from '../telemetry/buckets';
import { LoggerService } from '../telemetry/logger.service';
import {
  bucketColorHex,
  bucketDepth,
  bucketFontSize,
  bucketTabSize
} from './pref-summarize';

const STORAGE_KEY = 'jotjson.preferences.v1';
const FLUSH_DEBOUNCE_MS = 500;

/**
 * Preference sync lifecycle against the server:
 * - `anon`        - no authenticated user; preferences live in localStorage.
 * - `hydrating`   - user just signed in; we are reading `/api/me` to decide
 *                   whether to replace local state (remote wins) or seed
 *                   the server from local (first sign-in ever).
 * - `synced`      - signed in and preferences are being mirrored to the
 *                   server.
 * - `error`       - hydration or write failed. Local state is authoritative
 *                   for now; writes are NOT retried silently.
 */
export type PreferenceSyncState = 'anon' | 'hydrating' | 'synced' | 'error';

export const DEFAULT_PREFERENCES: UserPreferences = {
  theme: 'system',
  editorFontSize: 14,
  editorTabSize: 2,
  defaultTreeExpansionDepth: 2,
  editorWordWrap: true,
  layoutOrientation: 'horizontal',
  treeFontSize: 13,
  treeShowTypeLabels: true,
  treeShowDateAnnotations: true,
  treeDateAnnotationUnits: {
    year: true,
    month: true,
    day: true,
    hour: true,
    minute: true,
    second: true
  },
  treeDateAnnotationFriendlyForms: true,
  treeAssumeUtcForIsoDateTime: true,
  treeAssumeUtcForIsoDateOnly: true,
  activeRuleSetIds: [],
  recentlyViewedEnabled: true,
  treeEditorSelectionSync: true,
  treeAutoFitToWindow: true,
  searchCaseSensitive: false,
  searchRegexMode: false,
  searchScope: 'both',
  searchValueType: 'all',
  blobQuotaStrategy: 'auto_fifo',
  seenBlobQuotaModal: false,
  seenClipboardBanner: false,
  treePathRoot: 'jsonpath',
  treeHighlightColors: {
    dark: {
      selectionColor: '#264f78',
      matchingValueColor: '#3e3d32',
      ancestorColor: '#2a2d2e',
      searchHighlightColor: '#6a4c00'
    },
    light: {
      selectionColor: '#cce4f7',
      matchingValueColor: '#fff4cc',
      ancestorColor: '#ececec',
      searchHighlightColor: '#ffe082'
    }
  }
};

function resolveEffectiveTheme(pref: UserPreferences['theme']): 'dark' | 'light' {
  if (pref === 'dark' || pref === 'light') return pref;
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * Fills in any missing fields on a preferences object read from the server
 * (or hydrated from localStorage) with built-in defaults, and drops any
 * unknown keys. Guards against:
 *  - pre-existing user docs stored before a new field was added (the next
 *    PUT would otherwise fail server validation because
 *    normalizePreferences requires all keys), and
 *  - legacy or stale keys (e.g., `historyTrackingMode`,
 *    `defaultRuleSetIds`, `defaultRuleSetId`) that would otherwise leak
 *    back to the API on the next PUT and get rejected as unknown.
 *
 * Migrates the legacy `defaultRuleSetIds` (array) and ancient
 * `defaultRuleSetId` (single string) into the canonical
 * `activeRuleSetIds`. Canonical wins if both are present, so users who
 * already have the new shape in localStorage are not clobbered.
 */
function mergeWithDefaults(remote: Partial<UserPreferences>): UserPreferences {
  const remoteColors: PartialTreeHighlightColors = remote.treeHighlightColors ?? {};
  const remoteUnits: PartialTreeDateAnnotationUnits = remote.treeDateAnnotationUnits ?? {};
  const allowed = Object.keys(DEFAULT_PREFERENCES) as (keyof UserPreferences)[];
  const remoteRecord = { ...(remote as Record<string, unknown>) };
  if (!Array.isArray(remoteRecord['activeRuleSetIds'])) {
    if (Array.isArray(remoteRecord['defaultRuleSetIds'])) {
      remoteRecord['activeRuleSetIds'] = remoteRecord['defaultRuleSetIds'];
    } else if (typeof remoteRecord['defaultRuleSetId'] === 'string') {
      remoteRecord['activeRuleSetIds'] = [remoteRecord['defaultRuleSetId']];
    }
  }
  const filtered: Partial<UserPreferences> = {};
  for (const key of allowed) {
    if (key === 'treeHighlightColors' || key === 'treeDateAnnotationUnits') continue;
    if (remoteRecord[key] !== undefined) {
      (filtered as Record<string, unknown>)[key] = remoteRecord[key];
    }
  }
  // One-shot migration: if treeAutoFitToWindow was not persisted, derive
  // the value from defaultTreeExpansionDepth. Users who customized the
  // depth slider away from the default of 2 get auto-fit turned off so
  // their existing slider setting is preserved; everyone else (new users
  // or those who kept the default depth) get auto-fit on.
  if (filtered.treeAutoFitToWindow === undefined) {
    const persistedDepth = remoteRecord['defaultTreeExpansionDepth'];
    filtered.treeAutoFitToWindow = persistedDepth === undefined || persistedDepth === 2;
  }
  return {
    ...structuredClone(DEFAULT_PREFERENCES),
    ...filtered,
    treeDateAnnotationUnits: {
      ...DEFAULT_PREFERENCES.treeDateAnnotationUnits,
      ...remoteUnits
    },
    treeHighlightColors: {
      dark: {
        ...DEFAULT_PREFERENCES.treeHighlightColors.dark,
        ...(remoteColors.dark ?? {})
      },
      light: {
        ...DEFAULT_PREFERENCES.treeHighlightColors.light,
        ...(remoteColors.light ?? {})
      }
    }
  };
}

type PreferenceChangeSource = 'user' | 'init' | 'sync';
type TopLevelPreferenceKey = Exclude<keyof UserPreferences, 'treeHighlightColors'>;
type TreeDateAnnotationUnits = UserPreferences['treeDateAnnotationUnits'];
type PartialTreeDateAnnotationUnits = Partial<TreeDateAnnotationUnits>;
type TreeHighlightTheme = keyof TreeHighlightColors;
type TreeHighlightColorSlot = keyof ThemeColorSet;
type PartialTreeHighlightColors = {
  dark?: Partial<ThemeColorSet>;
  light?: Partial<ThemeColorSet>;
};
type NumberPreferenceBucket =
  | ReturnType<typeof bucketFontSize>
  | ReturnType<typeof bucketDepth>
  | ReturnType<typeof bucketTabSize>;

const PREFERENCE_KEYS = [
  'theme',
  'editorFontSize',
  'editorTabSize',
  'defaultTreeExpansionDepth',
  'editorWordWrap',
  'layoutOrientation',
  'treeFontSize',
  'treeShowTypeLabels',
  'treeShowDateAnnotations',
  'treeDateAnnotationUnits',
  'treeDateAnnotationFriendlyForms',
  'treeAssumeUtcForIsoDateTime',
  'treeAssumeUtcForIsoDateOnly',
  'activeRuleSetIds',
  'recentlyViewedEnabled',
  'treeEditorSelectionSync',
  'treeAutoFitToWindow',
  'searchCaseSensitive',
  'searchRegexMode',
  'searchScope',
  'searchValueType',
  'blobQuotaStrategy',
  'seenBlobQuotaModal',
  'seenClipboardBanner',
  'treePathRoot',
  'treeHighlightColors'
] as const satisfies readonly (keyof UserPreferences)[];

const TREE_HIGHLIGHT_THEMES = [
  'dark',
  'light'
] as const satisfies readonly TreeHighlightTheme[];
const TREE_HIGHLIGHT_COLOR_SLOTS = [
  'selectionColor',
  'matchingValueColor',
  'ancestorColor',
  'searchHighlightColor'
] as const satisfies readonly TreeHighlightColorSlot[];

function deepMergeColors(
  previousColors: TreeHighlightColors,
  nextColors: PartialTreeHighlightColors | undefined
): TreeHighlightColors {
  return {
    dark: {
      ...previousColors.dark,
      ...(nextColors?.dark ?? {})
    },
    light: {
      ...previousColors.light,
      ...(nextColors?.light ?? {})
    }
  };
}

function deepMergeUnits(
  previousUnits: TreeDateAnnotationUnits,
  nextUnits: PartialTreeDateAnnotationUnits | undefined
): TreeDateAnnotationUnits {
  return {
    ...previousUnits,
    ...(nextUnits ?? {})
  };
}

function mergePreferencePatch(
  previousPreferences: UserPreferences,
  nextPreferences: Partial<UserPreferences>
): UserPreferences {
  return structuredClone({
    ...previousPreferences,
    ...nextPreferences,
    treeDateAnnotationUnits: deepMergeUnits(
      previousPreferences.treeDateAnnotationUnits,
      nextPreferences.treeDateAnnotationUnits
    ),
    treeHighlightColors: deepMergeColors(
      previousPreferences.treeHighlightColors,
      nextPreferences.treeHighlightColors
    )
  });
}

function deepEqualPreferenceValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function booleanDimension(value: boolean): 'true' | 'false' {
  return value ? 'true' : 'false';
}

function countEnabledDateAnnotationUnits(units: TreeDateAnnotationUnits): number {
  let enabledCount = 0;
  if (units.year) enabledCount += 1;
  if (units.month) enabledCount += 1;
  if (units.day) enabledCount += 1;
  if (units.hour) enabledCount += 1;
  if (units.minute) enabledCount += 1;
  if (units.second) enabledCount += 1;
  return enabledCount;
}

@Injectable({ providedIn: 'root' })
export class PreferencesService {
  private readonly auth = inject(AuthService);
  private readonly api = inject(UserApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly loggerService = inject(LoggerService);

  private readonly _prefs = signal<UserPreferences>(this.loadLocal());
  readonly prefs = this._prefs.asReadonly();

  private readonly _syncState = signal<PreferenceSyncState>('anon');
  readonly syncState = this._syncState.asReadonly();

  readonly effectiveTheme = computed(() => resolveEffectiveTheme(this._prefs().theme));

  /**
   * Monotonically increasing "sync generation" - incremented whenever the
   * authenticated user changes. Pending writes captured against an old
   * generation are dropped rather than sent to the wrong account.
   */
  private syncGen = 0;
  private pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSyncedSnapshot: string | null = null;
  private pendingWrite: Subscription | null = null;
  private lastUserId: string | null = null;

  constructor() {
    effect(() => {
      const current = this._prefs();
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
      } catch {
        /* storage full / unavailable */
      }
    });

    effect(() => {
      const theme = this.effectiveTheme();
      if (typeof document !== 'undefined' && document.body) {
        document.body.classList.remove('theme-dark', 'theme-light', 'theme-system');
        document.body.classList.add(`theme-${theme}`);
      }
    });

    effect(() => {
      const theme = this.effectiveTheme();
      const colors = this._prefs().treeHighlightColors[theme];
      if (typeof document === 'undefined' || !document.body) return;
      const style = document.body.style;
      style.setProperty('--highlight-selection', colors.selectionColor);
      style.setProperty('--highlight-matching', colors.matchingValueColor);
      style.setProperty('--highlight-ancestor', colors.ancestorColor);
      style.setProperty('--highlight-search', colors.searchHighlightColor);
    });

    if (typeof window !== 'undefined' && window.matchMedia) {
      const media = window.matchMedia('(prefers-color-scheme: light)');
      media.addEventListener?.('change', () => {
        if (this._prefs().theme === 'system') {
          this._prefs.set({ ...this._prefs() });
        }
      });
    }

    effect(() => {
      const user = this.auth.user();
      const newUserId = user?.id ?? null;
      if (newUserId === this.lastUserId) return;
      this.lastUserId = newUserId;
      this.handleAuthTransition(newUserId);
    });

    effect(() => {
      // Mirror prefs -> server while signed in + synced. Debounced so rapid
      // user edits coalesce. Skipped while hydrating to avoid clobbering.
      const state = this._syncState();
      const current = this._prefs();
      if (state !== 'synced') return;
      const snapshot = JSON.stringify(current);
      if (snapshot === this.lastSyncedSnapshot) return;
      this.scheduleWrite(current);
    });

    if (typeof window !== 'undefined') {
      const flushOnHide = (): void => {
        // `pagehide` fires when the tab is discarded - flush any pending
        // debounced write synchronously. The HTTP client is still async,
        // but we at least give the request a chance to leave the box.
        this.flushPending();
      };
      window.addEventListener('pagehide', flushOnHide);
      window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushOnHide();
      });
    }
  }

  update(patch: Partial<UserPreferences>): void {
    this.applyPrefs(patch, 'user');
  }

  reset(): void {
    this.applyPrefs(DEFAULT_PREFERENCES, 'user');
  }

  private applyPrefs(next: Partial<UserPreferences>, source: PreferenceChangeSource): void {
    const previousPreferences = this._prefs();
    const mergedPreferences = mergePreferencePatch(previousPreferences, next);
    this.emitPreferenceChanges(previousPreferences, mergedPreferences, source);
    this._prefs.set(mergedPreferences);
  }

  private emitPreferenceChanges(
    previousPreferences: UserPreferences,
    mergedPreferences: UserPreferences,
    source: PreferenceChangeSource
  ): void {
    for (const key of PREFERENCE_KEYS) {
      if (key === 'treeHighlightColors') {
        this.emitTreeHighlightColorChanges(previousPreferences, mergedPreferences, source);
        continue;
      }
      if (deepEqualPreferenceValue(previousPreferences[key], mergedPreferences[key])) {
        continue;
      }
      this.emitTopLevelPreferenceChange(key, mergedPreferences, source);
    }
  }

  private emitTreeHighlightColorChanges(
    previousPreferences: UserPreferences,
    mergedPreferences: UserPreferences,
    source: PreferenceChangeSource
  ): void {
    for (const theme of TREE_HIGHLIGHT_THEMES) {
      for (const slot of TREE_HIGHLIGHT_COLOR_SLOTS) {
        const previousColor = previousPreferences.treeHighlightColors[theme][slot];
        const color = mergedPreferences.treeHighlightColors[theme][slot];
        if (deepEqualPreferenceValue(previousColor, color)) {
          continue;
        }
        const defaultColor = DEFAULT_PREFERENCES.treeHighlightColors[theme][slot];
        this.loggerService.event(
          'pref.changed',
          {
            key: `treeHighlightColors.${theme}.${slot}`,
            source,
            kind: 'color',
            isDefault: booleanDimension(color.toLowerCase() === defaultColor.toLowerCase()),
            bucket: bucketColorHex(color)
          },
          undefined
        );
      }
    }
  }

  private emitTopLevelPreferenceChange(
    key: TopLevelPreferenceKey,
    preferences: UserPreferences,
    source: PreferenceChangeSource
  ): void {
    switch (key) {
      case 'theme':
        this.emitStringPreferenceChange(key, preferences.theme, source);
        return;
      case 'editorFontSize':
        this.emitNumberPreferenceChange(
          key,
          bucketFontSize(preferences.editorFontSize),
          preferences.editorFontSize,
          source
        );
        return;
      case 'editorTabSize':
        this.emitNumberPreferenceChange(
          key,
          bucketTabSize(preferences.editorTabSize),
          preferences.editorTabSize,
          source
        );
        return;
      case 'defaultTreeExpansionDepth':
        this.emitNumberPreferenceChange(
          key,
          bucketDepth(preferences.defaultTreeExpansionDepth),
          preferences.defaultTreeExpansionDepth,
          source
        );
        return;
      case 'activeRuleSetIds':
        this.emitCountPreferenceChange(key, preferences.activeRuleSetIds.length, source);
        return;
      case 'editorWordWrap':
        this.emitBooleanPreferenceChange(key, preferences.editorWordWrap, source);
        return;
      case 'layoutOrientation':
        this.emitStringPreferenceChange(key, preferences.layoutOrientation, source);
        return;
      case 'treeFontSize':
        this.emitNumberPreferenceChange(
          key,
          bucketFontSize(preferences.treeFontSize),
          preferences.treeFontSize,
          source
        );
        return;
      case 'treeShowTypeLabels':
        this.emitBooleanPreferenceChange(key, preferences.treeShowTypeLabels, source);
        return;
      case 'treeShowDateAnnotations':
        this.emitBooleanPreferenceChange(key, preferences.treeShowDateAnnotations, source);
        return;
      case 'treeDateAnnotationUnits':
        this.emitCountPreferenceChange(
          key,
          countEnabledDateAnnotationUnits(preferences.treeDateAnnotationUnits),
          source
        );
        return;
      case 'treeDateAnnotationFriendlyForms':
        this.emitBooleanPreferenceChange(key, preferences.treeDateAnnotationFriendlyForms, source);
        return;
      case 'treeAssumeUtcForIsoDateTime':
        this.emitBooleanPreferenceChange(key, preferences.treeAssumeUtcForIsoDateTime, source);
        return;
      case 'treeAssumeUtcForIsoDateOnly':
        this.emitBooleanPreferenceChange(key, preferences.treeAssumeUtcForIsoDateOnly, source);
        return;
      case 'recentlyViewedEnabled':
        this.emitBooleanPreferenceChange(key, preferences.recentlyViewedEnabled, source);
        return;
      case 'treeEditorSelectionSync':
        this.emitBooleanPreferenceChange(key, preferences.treeEditorSelectionSync, source);
        return;
      case 'treeAutoFitToWindow':
        this.emitBooleanPreferenceChange(key, preferences.treeAutoFitToWindow, source);
        return;
      case 'searchCaseSensitive':
        this.emitBooleanPreferenceChange(key, preferences.searchCaseSensitive, source);
        return;
      case 'searchRegexMode':
        this.emitBooleanPreferenceChange(key, preferences.searchRegexMode, source);
        return;
      case 'seenBlobQuotaModal':
        this.emitBooleanPreferenceChange(key, preferences.seenBlobQuotaModal, source);
        return;
      case 'seenClipboardBanner':
        this.emitBooleanPreferenceChange(key, preferences.seenClipboardBanner, source);
        return;
      case 'searchScope':
        this.emitStringPreferenceChange(key, preferences.searchScope, source);
        return;
      case 'searchValueType':
        this.emitStringPreferenceChange(key, preferences.searchValueType, source);
        return;
      case 'blobQuotaStrategy':
        this.emitStringPreferenceChange(key, preferences.blobQuotaStrategy, source);
        return;
      case 'treePathRoot':
        this.emitStringPreferenceChange(key, preferences.treePathRoot, source);
        return;
    }
    const unhandledKey: never = key;
    throw new Error(`Unhandled preference key: ${unhandledKey}`);
  }

  private emitStringPreferenceChange(
    key: TopLevelPreferenceKey,
    value: string,
    source: PreferenceChangeSource
  ): void {
    this.loggerService.event('pref.changed', { key, source, kind: 'string', value }, undefined);
  }

  private emitBooleanPreferenceChange(
    key: TopLevelPreferenceKey,
    value: boolean,
    source: PreferenceChangeSource
  ): void {
    this.loggerService.event(
      'pref.changed',
      { key, source, kind: 'boolean', value: booleanDimension(value) },
      undefined
    );
  }

  private emitNumberPreferenceChange(
    key: TopLevelPreferenceKey,
    valueBucket: NumberPreferenceBucket,
    value: number,
    source: PreferenceChangeSource
  ): void {
    this.loggerService.event(
      'pref.changed',
      { key, source, kind: 'number', valueBucket },
      { value }
    );
  }

  private emitCountPreferenceChange(
    key: TopLevelPreferenceKey,
    count: number,
    source: PreferenceChangeSource
  ): void {
    this.loggerService.event(
      'pref.changed',
      { key, source, kind: 'count', countBucket: bucketCount(count) },
      { count }
    );
  }

  private loadLocal(): UserPreferences {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(DEFAULT_PREFERENCES);
      const parsed = JSON.parse(raw) as Partial<UserPreferences>;
      return mergeWithDefaults(parsed);
    } catch {
      return structuredClone(DEFAULT_PREFERENCES);
    }
  }

  private handleAuthTransition(newUserId: string | null): void {
    this.cancelPending();
    this.syncGen += 1;
    const gen = this.syncGen;
    if (newUserId === null) {
      // Signed out: clear locally-cached prefs so a subsequent user on the
      // same device doesn't see the previous user's colors/layout.
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      this.applyPrefs(DEFAULT_PREFERENCES, 'init');
      this._syncState.set('anon');
      this.lastSyncedSnapshot = null;
      return;
    }
    this._syncState.set('hydrating');
    this.lastSyncedSnapshot = null;
    const localAtSignIn = structuredClone(this._prefs());
    this.api
      .getMe()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (user) => {
          if (gen !== this.syncGen) return;
          if (user) {
            // Remote wins: replace local state with server copy (merged with
            // defaults so pre-existing docs missing newer fields still
            // normalize round-trip on the next write).
            const merged = mergeWithDefaults(user.preferences);
            this.applyPrefs(merged, 'init');
            this.lastSyncedSnapshot = JSON.stringify(merged);
            this._syncState.set('synced');
          } else {
            // First ever sign-in: seed the server with the anon user's
            // customizations so they are not lost.
            this.api
              .seed(localAtSignIn)
              .pipe(takeUntilDestroyed(this.destroyRef))
              .subscribe({
                next: (seeded) => {
                  if (gen !== this.syncGen) return;
                  const merged = mergeWithDefaults(seeded.preferences);
                  this.applyPrefs(merged, 'init');
                  this.lastSyncedSnapshot = JSON.stringify(merged);
                  this._syncState.set('synced');
                },
                error: () => {
                  if (gen !== this.syncGen) return;
                  this._syncState.set('error');
                }
              });
          }
        },
        error: () => {
          if (gen !== this.syncGen) return;
          this._syncState.set('error');
        }
      });
  }

  private scheduleWrite(value: UserPreferences): void {
    if (this.pendingFlushTimer !== null) {
      clearTimeout(this.pendingFlushTimer);
    }
    const snapshot = JSON.stringify(value);
    const gen = this.syncGen;
    this.pendingFlushTimer = setTimeout(() => {
      this.pendingFlushTimer = null;
      this.sendWrite(value, snapshot, gen);
    }, FLUSH_DEBOUNCE_MS);
  }

  private flushPending(): void {
    if (this.pendingFlushTimer === null) return;
    clearTimeout(this.pendingFlushTimer);
    this.pendingFlushTimer = null;
    const value = this._prefs();
    this.sendWrite(value, JSON.stringify(value), this.syncGen);
  }

  private sendWrite(value: UserPreferences, snapshot: string, gen: number): void {
    if (gen !== this.syncGen) return;
    this.pendingWrite?.unsubscribe();
    this.pendingWrite = this.api
      .putPreferences(value)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          if (gen !== this.syncGen) return;
          this.lastSyncedSnapshot = snapshot;
        },
        error: () => {
          if (gen !== this.syncGen) return;
          this._syncState.set('error');
        }
      });
  }

  private cancelPending(): void {
    if (this.pendingFlushTimer !== null) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }
    this.pendingWrite?.unsubscribe();
    this.pendingWrite = null;
  }

  /** Test-only: awaits any in-flight hydration. */
  async __waitForSync(): Promise<PreferenceSyncState> {
    const state = this._syncState();
    if (state !== 'hydrating') return state;
    // Poll until hydration leaves the state.
    return new Promise((resolve) => {
      const tick = (): void => {
        const current = this._syncState();
        if (current !== 'hydrating') {
          resolve(current);
        } else {
          setTimeout(tick, 10);
        }
      };
      tick();
    });
  }
}
