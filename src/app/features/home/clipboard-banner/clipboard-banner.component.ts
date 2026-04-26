import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { ClipboardPollingService } from '../../../core/clipboard/clipboard-polling.service';
import { PreferencesService } from '../../../core/preferences/preferences.service';

/**
 * One-time banner above the editor that asks the user to opt in to
 * clipboard polling. Shown only when:
 *   - the browser supports `navigator.clipboard`,
 *   - the user has not already dismissed the banner, AND
 *   - the clipboard permission is in `prompt` or `unknown` state.
 *
 * The component owns no clipboard state itself; it delegates to
 * `ClipboardPollingService.enable()` (a user-gesture call) and updates
 * preferences via `PreferencesService`.
 */
@Component({
  selector: 'jj-clipboard-banner',
  standalone: true,
  imports: [MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './clipboard-banner.component.html',
  styleUrl: './clipboard-banner.component.scss'
})
export class ClipboardBannerComponent {
  private readonly clipboard = inject(ClipboardPollingService);
  private readonly prefs = inject(PreferencesService);

  readonly dismissed = output<void>();

  readonly visible = computed(() => {
    const state = this.clipboard.permissionState();
    if (state !== 'prompt' && state !== 'unknown') return false;
    if (this.prefs.prefs().seenClipboardBanner) return false;
    return true;
  });

  async onAllow(): Promise<void> {
    await this.clipboard.enable();
    this.markSeen();
  }

  onDismiss(): void {
    this.markSeen();
  }

  private markSeen(): void {
    if (!this.prefs.prefs().seenClipboardBanner) {
      this.prefs.update({ seenClipboardBanner: true });
    }
    this.dismissed.emit();
  }
}
