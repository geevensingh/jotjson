import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSliderModule } from '@angular/material/slider';
import { AuthService } from '../../core/auth/auth.service';
import {
  DEFAULT_PREFERENCES,
  PreferencesService
} from '../../core/preferences/preferences.service';
import { FormattingRuleSet, ThemeColorSet, UserPreferences } from '../../core/api/models';
import { RuleSetsService } from '../../core/api/rule-sets.service';
import { AppHeaderComponent } from '../../shared/components/app-header/app-header.component';
import { IconComponent } from '../../shared/components/icon/icon.component';

const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 32;
const EXPANSION_DEPTH_MIN = 1;
const EXPANSION_DEPTH_MAX = 10;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

type ThemeName = 'dark' | 'light';
type ColorKey = keyof ThemeColorSet;

interface HighlightFieldDescriptor {
  readonly key: ColorKey;
  readonly inputId: (theme: ThemeName) => string;
  readonly i18nId: string;
}

const HIGHLIGHT_FIELDS: readonly HighlightFieldDescriptor[] = [
  {
    key: 'selectionColor',
    inputId: (t) => `pref-highlight-${t}-selection`,
    i18nId: '@@profile.prefs.highlightColors.selection'
  },
  {
    key: 'matchingValueColor',
    inputId: (t) => `pref-highlight-${t}-matching`,
    i18nId: '@@profile.prefs.highlightColors.matching'
  },
  {
    key: 'ancestorColor',
    inputId: (t) => `pref-highlight-${t}-ancestor`,
    i18nId: '@@profile.prefs.highlightColors.ancestor'
  },
  {
    key: 'searchHighlightColor',
    inputId: (t) => `pref-highlight-${t}-search`,
    i18nId: '@@profile.prefs.highlightColors.search'
  }
];

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [
    AppHeaderComponent,
    FormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatCheckboxModule,
    MatSlideToggleModule,
    MatSliderModule,
    IconComponent
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './profile.component.html',
  styleUrl: './profile.component.scss'
})
export class ProfileComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly prefsService = inject(PreferencesService);
  private readonly ruleSetsService = inject(RuleSetsService);
  private readonly destroyRef = inject(DestroyRef);

  readonly user = this.auth.user;
  readonly isSignedIn = this.auth.isSignedIn;
  readonly isConfigured = this.auth.isConfigured;

  readonly prefs = this.prefsService.prefs;

  readonly editorFontSize = computed(() => this.prefs().editorFontSize);
  readonly editorTabSize = computed(() => this.prefs().editorTabSize);
  readonly editorWordWrap = computed(() => this.prefs().editorWordWrap);
  readonly defaultTreeExpansionDepth = computed(() => this.prefs().defaultTreeExpansionDepth);
  readonly treeShowTypeLabels = computed(() => this.prefs().treeShowTypeLabels);
  readonly treeShowDateAnnotations = computed(
    () => this.prefs().treeShowDateAnnotations
  );
  readonly treeAssumeUtcForIsoDateTime = computed(
    () => this.prefs().treeAssumeUtcForIsoDateTime
  );
  readonly treeAssumeUtcForIsoDateOnly = computed(
    () => this.prefs().treeAssumeUtcForIsoDateOnly
  );
  readonly treeFontSize = computed(() => this.prefs().treeFontSize);
  readonly treePathRoot = computed(() => this.prefs().treePathRoot);

  readonly searchCaseSensitive = computed(() => this.prefs().searchCaseSensitive);
  readonly searchRegexMode = computed(() => this.prefs().searchRegexMode);
  readonly searchScope = computed(() => this.prefs().searchScope);

  readonly recentlyViewedEnabled = computed(() => this.prefs().recentlyViewedEnabled);
  readonly treeEditorSelectionSync = computed(
    () => this.prefs().treeEditorSelectionSync
  );
  readonly blobQuotaStrategy = computed(() => this.prefs().blobQuotaStrategy);
  readonly theme = computed(() => this.prefs().theme);
  readonly layoutOrientation = computed(() => this.prefs().layoutOrientation);

  readonly effectiveTheme = this.prefsService.effectiveTheme;
  readonly treeHighlightColors = computed(() => this.prefs().treeHighlightColors);
  readonly highlightFields = HIGHLIGHT_FIELDS;
  readonly highlightThemes: readonly ThemeName[] = ['dark', 'light'];

  /**
   * IDs the user has selected as default rule sets. Same value the
   * home-page toolbar drives - this section is just a different view
   * of the same setting.
   */
  readonly defaultRuleSetIds = computed(() => this.prefs().defaultRuleSetIds);

  /**
   * Cached rule sets sorted by name for the checkbox list. `null`
   * before the first list() resolves; the template renders an empty
   * state until the cache populates.
   */
  readonly ruleSetOptions = computed<readonly FormattingRuleSet[] | null>(() => {
    const cache = this.ruleSetsService.ruleSets();
    if (cache === null) return null;
    return [...cache].sort((a, b) => a.name.localeCompare(b.name));
  });

  /** True when the cache has loaded and the user owns no rule sets. */
  readonly ruleSetsEmpty = computed(() => {
    const sets = this.ruleSetOptions();
    return sets !== null && sets.length === 0;
  });

  readonly fontSizeMin = FONT_SIZE_MIN;
  readonly fontSizeMax = FONT_SIZE_MAX;
  readonly expansionDepthMin = EXPANSION_DEPTH_MIN;
  readonly expansionDepthMax = EXPANSION_DEPTH_MAX;

  ngOnInit(): void {
    // Warm the rule-sets cache on first render of the signed-in profile
    // so the "Default rule sets" section can populate without waiting
    // for the user to visit the home page first. No-op if another route
    // already populated the cache.
    if (!this.isSignedIn()) return;
    if (this.ruleSetsService.ruleSets() !== null) return;
    this.ruleSetsService
      .list()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () => {
          /* surfaced once the service grows a sync-state signal */
        }
      });
  }

  onSignIn(): void {
    this.auth.signIn();
  }

  onSignOut(): void {
    this.auth.signOut();
  }

  onEditorFontSizeChange(value: number | string | null): void {
    const clamped = this.clampNumber(value, FONT_SIZE_MIN, FONT_SIZE_MAX, this.editorFontSize());
    this.prefsService.update({ editorFontSize: clamped });
  }

  onEditorTabSizeChange(value: 2 | 4): void {
    this.prefsService.update({ editorTabSize: value });
  }

  onEditorWordWrapChange(value: boolean): void {
    this.prefsService.update({ editorWordWrap: value });
  }

  onDefaultTreeExpansionDepthChange(value: number | string | null): void {
    const clamped = this.clampNumber(
      value,
      EXPANSION_DEPTH_MIN,
      EXPANSION_DEPTH_MAX,
      this.defaultTreeExpansionDepth()
    );
    this.prefsService.update({ defaultTreeExpansionDepth: clamped });
  }

  onTreeFontSizeChange(value: number | string | null): void {
    const clamped = this.clampNumber(value, FONT_SIZE_MIN, FONT_SIZE_MAX, this.treeFontSize());
    this.prefsService.update({ treeFontSize: clamped });
  }

  onTreeShowTypeLabelsChange(value: boolean): void {
    this.prefsService.update({ treeShowTypeLabels: value });
  }

  onTreeShowDateAnnotationsChange(value: boolean): void {
    this.prefsService.update({ treeShowDateAnnotations: value });
  }

  onTreeAssumeUtcForIsoDateTimeChange(value: boolean): void {
    this.prefsService.update({ treeAssumeUtcForIsoDateTime: value });
  }

  onTreeAssumeUtcForIsoDateOnlyChange(value: boolean): void {
    this.prefsService.update({ treeAssumeUtcForIsoDateOnly: value });
  }

  onTreePathRootChange(value: string): void {
    if (value === 'jsonpath' || value === 'none' || value === 'root' || value === 'data') {
      this.prefsService.update({ treePathRoot: value });
    }
  }

  onSearchCaseSensitiveChange(value: boolean): void {
    this.prefsService.update({ searchCaseSensitive: value });
  }

  onSearchRegexModeChange(value: boolean): void {
    this.prefsService.update({ searchRegexMode: value });
  }

  onSearchScopeChange(value: string): void {
    if (value === 'keys' || value === 'values' || value === 'both') {
      this.prefsService.update({ searchScope: value });
    }
  }

  onRecentlyViewedEnabledChange(value: boolean): void {
    this.prefsService.update({ recentlyViewedEnabled: value });
  }

  onTreeEditorSelectionSyncChange(value: boolean): void {
    this.prefsService.update({ treeEditorSelectionSync: value });
  }

  onBlobQuotaStrategyChange(value: string): void {
    if (value === 'auto_fifo' || value === 'manual') {
      this.prefsService.update({ blobQuotaStrategy: value });
    }
  }

  onThemeChange(value: string): void {
    if (value === 'dark' || value === 'light' || value === 'system') {
      this.prefsService.update({ theme: value });
    }
  }

  onLayoutOrientationChange(value: string): void {
    if (value === 'horizontal' || value === 'vertical') {
      this.prefsService.update({ layoutOrientation: value });
    }
  }

  onHighlightColorChange(theme: ThemeName, key: ColorKey, value: string): void {
    const normalized = (value ?? '').toLowerCase();
    if (!HEX_COLOR_RE.test(normalized)) return;
    const current = this.prefs().treeHighlightColors;
    this.prefsService.update({
      treeHighlightColors: {
        ...current,
        [theme]: {
          ...current[theme],
          [key]: normalized
        }
      }
    });
  }

  onResetActiveThemeColors(): void {
    const active = this.effectiveTheme();
    const current = this.prefs().treeHighlightColors;
    this.prefsService.update({
      treeHighlightColors: {
        ...current,
        [active]: { ...DEFAULT_PREFERENCES.treeHighlightColors[active] }
      }
    });
  }

  isActiveTheme(theme: ThemeName): boolean {
    return this.effectiveTheme() === theme;
  }

  isDefaultRuleSet(id: string): boolean {
    return this.defaultRuleSetIds().includes(id);
  }

  /**
   * Checkbox toggle handler. Keeps the existing array order when adding
   * (append to end) so the engine and toolbar see the same priority
   * ordering the user has been working with; filters out the ID when
   * removing.
   */
  onDefaultRuleSetToggle(id: string, checked: boolean): void {
    const current = this.defaultRuleSetIds();
    const next = checked
      ? current.includes(id)
        ? current
        : [...current, id]
      : current.filter((x) => x !== id);
    if (next === current) return;
    this.prefsService.update({ defaultRuleSetIds: next });
  }

  private clampNumber(
    value: number | string | null,
    min: number,
    max: number,
    fallback: number
  ): number {
    if (value === null || value === '') return fallback;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    const rounded = Math.round(parsed);
    if (rounded < min) return min;
    if (rounded > max) return max;
    return rounded;
  }

  /** Test hook: expose preferences patches without needing the DOM. */
  __updateForTesting(patch: Partial<UserPreferences>): void {
    this.prefsService.update(patch);
  }
}
