import { ChangeDetectionStrategy, Component, Injectable, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';
import type { AutoDeletedBlobInfo } from '../api/models';
import { PreferencesService } from '../preferences/preferences.service';

/**
 * Orchestrates the toast + modal UX for the 100-blob quota:
 *
 * - `notifyAutoDeleted`: the server already removed the caller's oldest blob
 *   under the `auto_fifo` strategy. We always show a snackbar. The first
 *   time this happens per account we also open an explainer modal so the
 *   user can switch to the `manual` strategy if they prefer.
 *
 * - `notifyQuotaExceededManual`: the server rejected the save (`manual`
 *   strategy, 409 `quota_exceeded`). We open a modal pointing the user at
 *   `/blobs` to delete old blobs, or let them opt back into auto-FIFO.
 */
@Injectable({ providedIn: 'root' })
export class QuotaNotificationService {
  private readonly snack = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);
  private readonly prefs = inject(PreferencesService);

  async notifyAutoDeleted(info: AutoDeletedBlobInfo): Promise<void> {
    const name = info.title?.trim() || info.slug;
    const message = $localize`:@@quota.autoDeleted.toast:Deleted oldest blob "${name}:name:" to stay within your 100-blob limit.`;
    this.snack.open(message, $localize`:@@common.dismiss:Dismiss`, { duration: 6000 });

    if (this.prefs.prefs().seenBlobQuotaModal) return;

    // Mark as seen up front so we never double-prompt even if the user
    // dismisses without clicking a button.
    this.prefs.update({ seenBlobQuotaModal: true });

    const ref = this.dialog.open<QuotaFirstTimeDialogComponent, void, QuotaFirstTimeChoice>(
      QuotaFirstTimeDialogComponent,
      { autoFocus: 'dialog', width: '420px' },
    );
    const choice = await firstValueFrom(ref.afterClosed());
    if (choice === 'switch_to_manual') {
      this.prefs.update({ blobQuotaStrategy: 'manual' });
    }
  }

  async notifyQuotaExceededManual(): Promise<void> {
    const ref = this.dialog.open<QuotaManualFullDialogComponent, void, QuotaManualFullChoice>(
      QuotaManualFullDialogComponent,
      { autoFocus: 'dialog', width: '420px' },
    );
    const choice = await firstValueFrom(ref.afterClosed());
    if (choice === 'switch_to_auto') {
      this.prefs.update({ blobQuotaStrategy: 'auto_fifo', seenBlobQuotaModal: true });
    }
  }
}

type QuotaFirstTimeChoice = 'keep_auto' | 'switch_to_manual';

@Component({
  selector: 'app-quota-first-time-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatDialogModule],
  template: `
    <h2 mat-dialog-title i18n="@@quota.firstTime.title">You've hit the 100-blob limit</h2>
    <mat-dialog-content>
      <p i18n="@@quota.firstTime.body1">
        JotJSON free accounts keep up to 100 saved blobs. To make room, we automatically deleted
        your oldest saved blob and will keep doing that each time you hit the limit.
      </p>
      <p i18n="@@quota.firstTime.body2">
        Prefer to manage the list yourself? Switch to manual mode - saves past the limit will fail
        until you delete something from your saved blobs. You can change this later in Settings.
      </p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="close('switch_to_manual')" i18n="@@quota.firstTime.manual"
        >Let me manage manually</button
      >
      <button
        mat-flat-button
        color="primary"
        cdkFocusInitial
        (click)="close('keep_auto')"
        i18n="@@quota.firstTime.ok"
        >OK, got it</button
      >
    </mat-dialog-actions>
  `,
})
export class QuotaFirstTimeDialogComponent {
  private readonly ref =
    inject<MatDialogRef<QuotaFirstTimeDialogComponent, QuotaFirstTimeChoice>>(MatDialogRef);

  close(choice: QuotaFirstTimeChoice): void {
    this.ref.close(choice);
  }
}

type QuotaManualFullChoice = 'dismiss' | 'switch_to_auto';

@Component({
  selector: 'app-quota-manual-full-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatDialogModule],
  template: `
    <h2 mat-dialog-title i18n="@@quota.manualFull.title">Blob limit reached</h2>
    <mat-dialog-content>
      <p i18n="@@quota.manualFull.body">
        You've hit the 100-blob limit and manual quota management is on. Delete a blob from your
        saved blobs to make room, or switch back to automatic cleanup of the oldest blob.
      </p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="close('switch_to_auto')" i18n="@@quota.manualFull.switchAuto"
        >Switch to automatic</button
      >
      <button
        mat-flat-button
        color="primary"
        cdkFocusInitial
        (click)="close('dismiss')"
        i18n="@@quota.manualFull.dismiss"
        >OK</button
      >
    </mat-dialog-actions>
  `,
})
export class QuotaManualFullDialogComponent {
  private readonly ref =
    inject<MatDialogRef<QuotaManualFullDialogComponent, QuotaManualFullChoice>>(MatDialogRef);

  close(choice: QuotaManualFullChoice): void {
    this.ref.close(choice);
  }
}
