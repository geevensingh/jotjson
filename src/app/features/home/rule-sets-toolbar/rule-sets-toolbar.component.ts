import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';
import type { FormattingRuleSet } from '../../../core/api/models';
import { RuleSetsService } from '../../../core/api/rule-sets.service';
import { AuthService } from '../../../core/auth/auth.service';
import {
  ClonePresetDialogComponent,
  ClonePresetDialogResult,
} from './clone-preset-dialog.component';

/**
 * Toolbar pinned to the top of the tree pane that lets a signed-in user
 * (a) toggle which of their formatting rule sets are applied by default
 * to the tree, and (b) clone one of the built-in presets into their
 * account.
 *
 * Hidden entirely for anonymous users (per design decision 2026-04-27): the
 * presets / rule-sets endpoints are auth-gated, so an anon-visible toolbar
 * would either be empty or constantly bouncing through 401s.
 *
 * Active-set state lives in `UserPreferences.activeRuleSetIds`; toggling a
 * chip delegates to `RuleSetsService.toggleActive` which writes through
 * `PreferencesService.update`. `JsonTreeComponent` reads the same signal,
 * so the tree repaints synchronously when the user toggles.
 *
 * Clone flow opens `ClonePresetDialogComponent`. On success the returned set
 * is auto-added to the user's actives so the tree paints immediately -
 * users almost always want to *use* a freshly cloned set, and the chip
 * toggle is one extra click for the rare case where they don't.
 */
@Component({
  selector: 'jj-rule-sets-toolbar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rule-sets-toolbar.component.html',
  styleUrl: './rule-sets-toolbar.component.scss',
})
export class RuleSetsToolbarComponent implements OnInit {
  private readonly ruleSets = inject(RuleSetsService);
  private readonly auth = inject(AuthService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * Hidden when auth is unconfigured or the user is signed out. We mirror
   * the `*jjSignedIn` directive's logic instead of using it because we want
   * to gate the entire toolbar plus the OnInit list() call, not just
   * template rendering.
   */
  readonly visible = computed(() => this.auth.isConfigured && this.auth.isSignedIn());

  /**
   * Cached rule sets, name-sorted for stable display. `null` while the first
   * list() is in flight or while signed out (cache resets on sign-out).
   */
  readonly sortedSets = computed<readonly FormattingRuleSet[] | null>(() => {
    const cache = this.ruleSets.ruleSets();
    if (cache === null) return null;
    return [...cache].sort((a, b) => a.name.localeCompare(b.name));
  });

  readonly activeIds = this.ruleSets.activeRuleSetIds;

  /** True after the first successful list() resolves with no items. */
  readonly empty = computed(() => {
    const sets = this.sortedSets();
    return sets !== null && sets.length === 0;
  });

  ngOnInit(): void {
    if (!this.visible()) return;
    if (this.ruleSets.ruleSets() !== null) return;
    this.ruleSets
      .list()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () => {
          /* surfaced once we add a sync-state signal to the service */
        },
      });
  }

  isActive(id: string): boolean {
    return this.activeIds().includes(id);
  }

  onToggle(id: string): void {
    this.ruleSets.toggleActive(id);
  }

  async onClonePresetClick(): Promise<void> {
    const ref = this.dialog.open<ClonePresetDialogComponent, void, ClonePresetDialogResult>(
      ClonePresetDialogComponent,
      {
        width: '480px',
        autoFocus: 'first-tabbable',
        restoreFocus: true,
      },
    );

    const result = await firstValueFrom(ref.afterClosed());
    if (!result) return;

    const next = [...this.activeIds(), result.cloned.id];
    this.ruleSets.setActives(next);

    const message = $localize`:@@formattingRules.toolbar.cloneSuccess:Cloned ${result.preset.name}:name:.`;
    this.snack.open(message, $localize`:@@common.dismiss:Dismiss`, {
      duration: 4000,
    });
  }

  /** Track-by for the chip @for loop. */
  trackById(_index: number, set: FormattingRuleSet): string {
    return set.id;
  }
}
