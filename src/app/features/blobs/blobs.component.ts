import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';

import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { firstValueFrom } from 'rxjs';
import { BlobService } from '../../core/api/blob.service';
import { ClipboardCopyService } from '../../core/clipboard/clipboard-copy.service';
import type { JsonBlob } from '../../core/api/models';
import { LoggerService } from '../../core/telemetry/logger.service';
import { SeoService } from '../../core/seo/seo.service';
import { AppHeaderComponent } from '../../shared/components/app-header/app-header.component';
import { IconComponent } from '../../shared/components/icon/icon.component';
import {
  ConfirmDialogComponent,
  ConfirmDialogData,
} from '../../shared/dialogs/confirm-dialog/confirm-dialog.component';

type LoadState = 'loading' | 'ready' | 'error';

@Component({
  selector: 'app-blobs',
  standalone: true,
  imports: [RouterLink, MatButtonModule, MatTooltipModule, AppHeaderComponent, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './blobs.component.html',
  styleUrl: './blobs.component.scss',
})
export class BlobsComponent implements OnInit {
  private readonly blobs = inject(BlobService);
  private readonly clipboardCopy = inject(ClipboardCopyService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  private readonly router = inject(Router);
  private readonly seo = inject(SeoService);
  private readonly logger = inject(LoggerService);

  readonly state = signal<LoadState>('loading');
  readonly blobList = signal<JsonBlob[]>([]);
  readonly errorMessage = signal<string | null>(null);

  readonly isEmpty = computed(() => this.state() === 'ready' && this.blobList().length === 0);

  ngOnInit(): void {
    this.seo.clearBlobTags();
    this.seo.setNoindex(true);
    void this.reload();
  }

  async reload(): Promise<void> {
    this.state.set('loading');
    try {
      const list = await firstValueFrom(this.blobs.list());
      // Server returns updatedAt DESC already, but defend in depth.
      const sorted = [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      this.blobList.set(sorted);
      this.state.set('ready');
    } catch (error) {
      this.logger.warn('blobs.load.failed');
      void error;
      this.errorMessage.set($localize`:@@blobs.load.failed:Failed to load your saved blobs.`);
      this.state.set('error');
    }
  }

  displayTitle(blob: JsonBlob): string {
    const title = blob.title?.trim();
    return title && title.length > 0 ? title : $localize`:@@blobs.untitled:Untitled`;
  }

  relativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '';
    const diff = Date.now() - then;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return $localize`:@@blobs.justNow:just now`;
    if (minutes < 60) return $localize`:@@blobs.minutesAgo:${minutes}:count: min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return $localize`:@@blobs.hoursAgo:${hours}:count: h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return $localize`:@@blobs.daysAgo:${days}:count: d ago`;
    return new Date(iso).toLocaleDateString();
  }

  openBlob(blob: JsonBlob): void {
    void this.router.navigate(['/s', blob.slug]);
  }

  async copyLink(blob: JsonBlob): Promise<void> {
    const url = `${window.location.origin}/s/${blob.slug}`;
    const copied = await this.clipboardCopy.copyWithToast(url, {
      success: $localize`:@@blobs.copyLink.success:Link copied to clipboard`,
      failed: $localize`:@@blobs.copyLink.failed:Failed to copy link`,
      unsupported: $localize`:@@blobs.copyLink.unsupported:Copy is not supported in this browser.`,
    });
    if (!copied) {
      this.logger.warn('blobs.copyLink.failed');
    }
  }

  async deleteBlob(blob: JsonBlob): Promise<void> {
    const label = this.displayTitle(blob);
    const data: ConfirmDialogData = {
      title: $localize`:@@blobs.delete.title:Delete this blob?`,
      message: $localize`:@@blobs.delete.message:"${label}:name:" will be permanently deleted. This cannot be undone.`,
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
    try {
      await firstValueFrom(this.blobs.delete(blob.id));
      this.blobList.update((list) => list.filter((b) => b.id !== blob.id));
      this.snack.open(
        $localize`:@@share.delete.success:Blob deleted.`,
        $localize`:@@common.dismiss:Dismiss`,
        { duration: 3000 },
      );
    } catch (error) {
      this.logger.warn('share.delete.failed');
      void error;
      this.snack.open(
        $localize`:@@share.delete.failed:Failed to delete blob.`,
        $localize`:@@common.dismiss:Dismiss`,
        { duration: 4000 },
      );
    }
  }
}
