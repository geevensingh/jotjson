import { computed, effect, Injectable, signal } from '@angular/core';
import { UserPreferences } from '../api/models';

const STORAGE_KEY = 'jotjson.preferences.v1';

export const DEFAULT_PREFERENCES: UserPreferences = {
  theme: 'system',
  editorFontSize: 14,
  editorTabSize: 2,
  defaultTreeExpansionDepth: 2,
  editorWordWrap: true,
  layoutOrientation: 'horizontal',
  treeShowTypeLabels: true,
  treeShowDateAnnotations: true,
  historyTrackingMode: 'save_only',
  searchCaseSensitive: false,
  searchRegexMode: false,
  searchScope: 'both',
  blobQuotaStrategy: 'auto_fifo',
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

@Injectable({ providedIn: 'root' })
export class PreferencesService {
  private readonly _prefs = signal<UserPreferences>(this.load());
  readonly prefs = this._prefs.asReadonly();

  readonly effectiveTheme = computed(() => resolveEffectiveTheme(this._prefs().theme));

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

    if (typeof window !== 'undefined' && window.matchMedia) {
      const media = window.matchMedia('(prefers-color-scheme: light)');
      media.addEventListener?.('change', () => {
        if (this._prefs().theme === 'system') {
          this._prefs.set({ ...this._prefs() });
        }
      });
    }
  }

  update(patch: Partial<UserPreferences>): void {
    this._prefs.set({ ...this._prefs(), ...patch });
  }

  reset(): void {
    this._prefs.set(structuredClone(DEFAULT_PREFERENCES));
  }

  private load(): UserPreferences {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(DEFAULT_PREFERENCES);
      const parsed = JSON.parse(raw) as Partial<UserPreferences>;
      return {
        ...structuredClone(DEFAULT_PREFERENCES),
        ...parsed,
        treeHighlightColors: {
          ...DEFAULT_PREFERENCES.treeHighlightColors,
          ...(parsed.treeHighlightColors ?? {})
        }
      };
    } catch {
      return structuredClone(DEFAULT_PREFERENCES);
    }
  }
}
