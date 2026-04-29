import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';
import { UserPreferences } from '../api/models';
import { UserApiService } from '../api/user-api.service';
import { AuthService } from '../auth/auth.service';

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
  treeAssumeUtcForIsoDateTime: true,
  treeAssumeUtcForIsoDateOnly: true,
  defaultRuleSetIds: [],
  recentlyViewedEnabled: true,
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
 *    `activeRuleSetIds`, `defaultRuleSetId`) that would otherwise leak
 *    back to the API on the next PUT and get rejected as unknown.
 */
function mergeWithDefaults(remote: Partial<UserPreferences>): UserPreferences {
  const remoteColors: Partial<UserPreferences['treeHighlightColors']> =
    remote.treeHighlightColors ?? {};
  const allowed = Object.keys(DEFAULT_PREFERENCES) as (keyof UserPreferences)[];
  const remoteRecord = remote as Record<string, unknown>;
  const filtered: Partial<UserPreferences> = {};
  for (const key of allowed) {
    if (key === 'treeHighlightColors') continue;
    if (remoteRecord[key] !== undefined) {
      (filtered as Record<string, unknown>)[key] = remoteRecord[key];
    }
  }
  return {
    ...structuredClone(DEFAULT_PREFERENCES),
    ...filtered,
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

@Injectable({ providedIn: 'root' })
export class PreferencesService {
  private readonly auth = inject(AuthService);
  private readonly api = inject(UserApiService);
  private readonly destroyRef = inject(DestroyRef);

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
    this._prefs.set({ ...this._prefs(), ...patch });
  }

  reset(): void {
    this._prefs.set(structuredClone(DEFAULT_PREFERENCES));
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
      this._prefs.set(structuredClone(DEFAULT_PREFERENCES));
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
            this._prefs.set(merged);
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
                  this._prefs.set(merged);
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
