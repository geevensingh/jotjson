import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { AuthService } from '../../core/auth/auth.service';
import { PreferencesService } from '../../core/preferences/preferences.service';
import { UserPreferences } from '../../core/api/models';
import { AppHeaderComponent } from '../../shared/components/app-header/app-header.component';
import { IconComponent } from '../../shared/components/icon/icon.component';

const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 32;
const EXPANSION_DEPTH_MIN = 1;
const EXPANSION_DEPTH_MAX = 10;

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [
    AppHeaderComponent,
    FormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatSlideToggleModule,
    IconComponent
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './profile.component.html',
  styleUrl: './profile.component.scss'
})
export class ProfileComponent {
  private readonly auth = inject(AuthService);
  private readonly prefsService = inject(PreferencesService);

  readonly user = this.auth.user;
  readonly isSignedIn = this.auth.isSignedIn;
  readonly isConfigured = this.auth.isConfigured;

  readonly prefs = this.prefsService.prefs;

  readonly editorFontSize = computed(() => this.prefs().editorFontSize);
  readonly editorTabSize = computed(() => this.prefs().editorTabSize);
  readonly editorWordWrap = computed(() => this.prefs().editorWordWrap);
  readonly defaultTreeExpansionDepth = computed(() => this.prefs().defaultTreeExpansionDepth);
  readonly treeShowTypeLabels = computed(() => this.prefs().treeShowTypeLabels);
  readonly treeFontSize = computed(() => this.prefs().treeFontSize);

  readonly searchCaseSensitive = computed(() => this.prefs().searchCaseSensitive);
  readonly searchRegexMode = computed(() => this.prefs().searchRegexMode);
  readonly searchScope = computed(() => this.prefs().searchScope);

  readonly historyTrackingMode = computed(() => this.prefs().historyTrackingMode);
  readonly blobQuotaStrategy = computed(() => this.prefs().blobQuotaStrategy);
  readonly theme = computed(() => this.prefs().theme);
  readonly layoutOrientation = computed(() => this.prefs().layoutOrientation);

  readonly fontSizeMin = FONT_SIZE_MIN;
  readonly fontSizeMax = FONT_SIZE_MAX;
  readonly expansionDepthMin = EXPANSION_DEPTH_MIN;
  readonly expansionDepthMax = EXPANSION_DEPTH_MAX;

  onSignIn(): void {
    this.auth.signIn();
  }

  onSignOut(): void {
    this.auth.signOut();
  }

  onEditorFontSizeChange(value: number | string | null): void {
    const n = this.clampNumber(value, FONT_SIZE_MIN, FONT_SIZE_MAX, this.editorFontSize());
    this.prefsService.update({ editorFontSize: n });
  }

  onEditorTabSizeChange(value: 2 | 4): void {
    this.prefsService.update({ editorTabSize: value });
  }

  onEditorWordWrapChange(value: boolean): void {
    this.prefsService.update({ editorWordWrap: value });
  }

  onDefaultTreeExpansionDepthChange(value: number | string | null): void {
    const n = this.clampNumber(
      value,
      EXPANSION_DEPTH_MIN,
      EXPANSION_DEPTH_MAX,
      this.defaultTreeExpansionDepth()
    );
    this.prefsService.update({ defaultTreeExpansionDepth: n });
  }

  onTreeFontSizeChange(value: number | string | null): void {
    const n = this.clampNumber(value, FONT_SIZE_MIN, FONT_SIZE_MAX, this.treeFontSize());
    this.prefsService.update({ treeFontSize: n });
  }

  onTreeShowTypeLabelsChange(value: boolean): void {
    this.prefsService.update({ treeShowTypeLabels: value });
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

  onHistoryTrackingModeChange(value: string): void {
    if (value === 'save_only' || value === 'all_actions') {
      this.prefsService.update({ historyTrackingMode: value });
    }
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
