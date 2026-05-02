import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  OnInit,
  ViewChild,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';

import { RuleSetsService } from '../../core/api/rule-sets.service';
import type { FormattingRuleSet } from '../../core/api/models';
import { NAME_MAX } from '../../core/api/models.constants';
import {
  PreferencesService,
  PreferenceSyncState,
} from '../../core/preferences/preferences.service';
import { AppHeaderComponent } from '../../shared/components/app-header/app-header.component';
import { IconComponent } from '../../shared/components/icon/icon.component';
import {
  ConfirmDialogComponent,
  ConfirmDialogData,
} from '../../shared/dialogs/confirm-dialog/confirm-dialog.component';
import {
  ClonePresetDialogComponent,
  ClonePresetDialogResult,
} from '../home/rule-sets-toolbar/clone-preset-dialog.component';

type LoadState = 'loading' | 'ready' | 'error';
type RenameError = 'empty' | 'tooLong' | 'conflict' | null;

const DUP_SUFFIX = ' (copy)';

/**
 * Full lifecycle list page for the user's rule sets (M6e). Cards expose
 * default toggle, inline rename, duplicate, delete, and an Edit link into
 * the M6d editor. Page-level "Clone preset" reuses the home-toolbar dialog.
 */
@Component({
  selector: 'app-formatting-rules',
  standalone: true,
  imports: [AppHeaderComponent, IconComponent, MatButtonModule, MatMenuModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './formatting-rules.component.html',
  styleUrl: './formatting-rules.component.scss',
})
export class FormattingRulesComponent implements OnInit {
  private readonly service = inject(RuleSetsService);
  private readonly preferences = inject(PreferencesService);
  private readonly router = inject(Router);
  private readonly snack = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);
  private readonly injector = inject(Injector);

  readonly loadState = signal<LoadState>('loading');
  readonly creating = signal(false);
  readonly cloning = signal(false);

  readonly editingId = signal<string | null>(null);
  readonly editingName = signal('');
  readonly editingError = signal<RenameError>(null);
  readonly pendingActionId = signal<string | null>(null);

  readonly NAME_MAX_FIELD = NAME_MAX;

  readonly setActiveLabel = $localize`:@@formattingRules.default.aria.set:Apply rule set`;
  readonly removeActiveLabel = $localize`:@@formattingRules.default.aria.unset:Stop applying rule set`;

  readonly ruleSets = computed<readonly FormattingRuleSet[]>(() => {
    const cache = this.service.ruleSets();
    if (!cache) return [];
    return [...cache].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  });

  readonly activeRuleSetIds = computed(() => this.service.activeRuleSetIds());

  readonly isEmpty = computed(() => this.loadState() === 'ready' && this.ruleSets().length === 0);

  @ViewChild('renameInput') renameInputRef?: ElementRef<HTMLInputElement>;

  // Suppress the apply-toggle error snack while we are renaming or
  // duplicating: those flows snack their own messages, and the prefs
  // service might transition to error for an unrelated background reason.
  // We only fire on a transition INTO 'error' from a non-error state.
  private prevSyncState: PreferenceSyncState | undefined;

  constructor() {
    effect(() => {
      const next = this.preferences.syncState();
      const prev = this.prevSyncState;
      this.prevSyncState = next;
      if (prev === undefined) return;
      if (next === 'error' && prev !== 'error') {
        this.snack.open(
          $localize`:@@formattingRules.default.failed:Could not save which rule sets are applied - check your connection.`,
          $localize`:@@common.dismiss:Dismiss`,
          { duration: 4000 },
        );
      }
    });
  }

  ngOnInit(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    this.loadState.set('loading');
    try {
      await firstValueFrom(this.service.list());
      this.loadState.set('ready');
    } catch {
      this.loadState.set('error');
    }
  }

  isActive(id: string): boolean {
    return this.activeRuleSetIds().includes(id);
  }

  isBusy(id: string): boolean {
    return this.pendingActionId() === id;
  }

  relativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '';
    const diff = Date.now() - then;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return $localize`:@@formattingRules.justNow:just now`;
    if (minutes < 60) return $localize`:@@formattingRules.minutesAgo:${minutes}:count: min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return $localize`:@@formattingRules.hoursAgo:${hours}:count: h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return $localize`:@@formattingRules.daysAgo:${days}:count: d ago`;
    return new Date(iso).toLocaleDateString();
  }

  startRename(set: FormattingRuleSet): void {
    if (this.pendingActionId() !== null) return;
    this.editingId.set(set.id);
    this.editingName.set(set.name);
    this.editingError.set(null);
    afterNextRender(
      () => {
        const el = this.renameInputRef?.nativeElement;
        if (el) {
          el.focus();
          el.select();
        }
      },
      { injector: this.injector },
    );
  }

  onRenameInput(value: string): void {
    this.editingName.set(value);
    if (this.editingError() !== null) {
      this.editingError.set(null);
    }
  }

  commitRename(set: FormattingRuleSet): void {
    if (this.editingId() !== set.id) return;
    const trimmed = this.editingName().trim();
    if (trimmed.length === 0) {
      this.editingError.set('empty');
      return;
    }
    if (trimmed.length > NAME_MAX) {
      this.editingError.set('tooLong');
      return;
    }
    if (trimmed === set.name) {
      this.cancelRename();
      return;
    }
    this.pendingActionId.set(set.id);
    this.service.update(set.id, { name: trimmed, rules: set.rules }, set.version).subscribe({
      next: () => {
        this.snack.open(
          $localize`:@@formattingRules.rename.success:Rule set renamed.`,
          $localize`:@@common.dismiss:Dismiss`,
          { duration: 3000 },
        );
        this.editingId.set(null);
        this.editingName.set('');
        this.editingError.set(null);
        this.pendingActionId.set(null);
      },
      error: (err: unknown) => {
        const status = err instanceof HttpErrorResponse ? err.status : 0;
        if (status === 412) {
          this.service.get(set.id).subscribe({
            next: (fresh) => {
              this.editingName.set(fresh.name);
              this.editingError.set('conflict');
              this.pendingActionId.set(null);
            },
            error: () => {
              this.snack.open(
                $localize`:@@formattingRules.rename.deletedDuringRename:This rule set was deleted.`,
                $localize`:@@common.dismiss:Dismiss`,
                { duration: 4000 },
              );
              this.service.refresh();
              this.editingId.set(null);
              this.editingName.set('');
              this.editingError.set(null);
              this.pendingActionId.set(null);
            },
          });
          return;
        }
        if (status === 404) {
          this.snack.open(
            $localize`:@@formattingRules.rename.deletedDuringRename:This rule set was deleted.`,
            $localize`:@@common.dismiss:Dismiss`,
            { duration: 4000 },
          );
          this.service.refresh();
        } else {
          this.snack.open(
            $localize`:@@formattingRules.rename.failed:Could not rename rule set. Please try again.`,
            $localize`:@@common.dismiss:Dismiss`,
            { duration: 4000 },
          );
        }
        this.editingId.set(null);
        this.editingName.set('');
        this.editingError.set(null);
        this.pendingActionId.set(null);
      },
    });
  }

  cancelRename(): void {
    this.editingId.set(null);
    this.editingName.set('');
    this.editingError.set(null);
  }

  duplicateSet(set: FormattingRuleSet): void {
    if (this.pendingActionId() !== null) return;
    const name = this.dupName(set.name);
    this.pendingActionId.set(set.id);
    this.service.create({ name, rules: structuredClone(set.rules) }).subscribe({
      next: () => {
        this.snack.open(
          $localize`:@@formattingRules.duplicate.success:Rule set duplicated.`,
          $localize`:@@common.dismiss:Dismiss`,
          { duration: 3000 },
        );
        this.pendingActionId.set(null);
      },
      error: (err: unknown) => {
        const status = err instanceof HttpErrorResponse ? err.status : 0;
        if (status === 409) {
          this.snack.open(
            $localize`:@@formattingRules.duplicate.quotaExceeded:You have reached the rule set limit (20).`,
            $localize`:@@common.dismiss:Dismiss`,
            { duration: 5000 },
          );
        } else {
          this.snack.open(
            $localize`:@@formattingRules.duplicate.failed:Could not duplicate rule set.`,
            $localize`:@@common.dismiss:Dismiss`,
            { duration: 4000 },
          );
        }
        this.pendingActionId.set(null);
      },
    });
  }

  async deleteSet(set: FormattingRuleSet): Promise<void> {
    if (this.pendingActionId() !== null) return;
    const data: ConfirmDialogData = {
      title: $localize`:@@formattingRules.delete.title:Delete this rule set?`,
      message: $localize`:@@formattingRules.delete.message:"${set.name}:name:" will be permanently deleted. This cannot be undone.`,
      confirmLabel: $localize`:@@share.delete.confirm:Delete`,
      cancelLabel: $localize`:@@common.cancel:Cancel`,
      destructive: true,
    };
    const ref = this.dialog.open<ConfirmDialogComponent, ConfirmDialogData, boolean>(
      ConfirmDialogComponent,
      { data, width: '420px', autoFocus: 'dialog' },
    );
    const confirmed = await firstValueFrom(ref.afterClosed());
    if (!confirmed) return;
    this.pendingActionId.set(set.id);
    this.service.delete(set.id).subscribe({
      next: () => {
        this.snack.open(
          $localize`:@@formattingRules.delete.success:Rule set deleted.`,
          $localize`:@@common.dismiss:Dismiss`,
          { duration: 3000 },
        );
        this.pendingActionId.set(null);
      },
      error: (err: unknown) => {
        const status = err instanceof HttpErrorResponse ? err.status : 0;
        if (status === 404) {
          // Service skips cache + activeRuleSetIds cleanup on 404; mirror
          // it manually so the toolbar and profile reconcile.
          const currentActives = this.preferences.prefs().activeRuleSetIds;
          if (currentActives.includes(set.id)) {
            this.preferences.update({
              activeRuleSetIds: currentActives.filter((x) => x !== set.id),
            });
          }
          this.service.refresh();
          this.snack.open(
            $localize`:@@formattingRules.delete.alreadyDeleted:This rule set was already deleted.`,
            $localize`:@@common.dismiss:Dismiss`,
            { duration: 4000 },
          );
        } else {
          this.snack.open(
            $localize`:@@formattingRules.delete.failed:Could not delete rule set.`,
            $localize`:@@common.dismiss:Dismiss`,
            { duration: 4000 },
          );
        }
        this.pendingActionId.set(null);
      },
    });
  }

  toggleActive(set: FormattingRuleSet): void {
    if (this.pendingActionId() === set.id) return;
    this.service.toggleActive(set.id);
  }

  async openClonePresetDialog(): Promise<void> {
    if (this.cloning()) return;
    this.cloning.set(true);
    try {
      const ref = this.dialog.open<ClonePresetDialogComponent, void, ClonePresetDialogResult>(
        ClonePresetDialogComponent,
        {
          width: '480px',
          autoFocus: 'first-tabbable',
          restoreFocus: true,
        },
      );
      const result = await firstValueFrom(ref.afterClosed());
      if (result?.cloned) {
        await this.router.navigate(['/formatting-rules', result.cloned.id]);
      }
    } finally {
      this.cloning.set(false);
    }
  }

  async onCreate(): Promise<void> {
    if (this.creating()) return;
    this.creating.set(true);
    try {
      const created = await firstValueFrom(
        this.service.create({
          name: $localize`:@@formattingRules.newRuleSet.defaultName:New rule set`,
          rules: [],
        }),
      );
      void this.router.navigate(['/formatting-rules', created.id]);
    } catch (err) {
      const status = err instanceof HttpErrorResponse ? err.status : 0;
      if (status === 409) {
        this.snack.open(
          $localize`:@@formattingRules.create.quotaExceeded:You have reached the rule set limit (20).`,
          $localize`:@@common.dismiss:Dismiss`,
          { duration: 5000 },
        );
      } else {
        this.snack.open(
          $localize`:@@formattingRules.create.failed:Could not create rule set. Please try again.`,
          $localize`:@@common.dismiss:Dismiss`,
          { duration: 5000 },
        );
      }
    } finally {
      this.creating.set(false);
    }
  }

  trackById(_: number, set: FormattingRuleSet): string {
    return set.id;
  }

  private dupName(original: string): string {
    const trimmed = original.trim();
    const candidate = trimmed + DUP_SUFFIX;
    if (candidate.length <= NAME_MAX) return candidate;
    return trimmed.slice(0, NAME_MAX - DUP_SUFFIX.length).trim() + DUP_SUFFIX;
  }
}
