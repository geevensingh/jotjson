import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';

/**
 * Choice emitted when the user interacts with the banner.
 *
 * - `always`         - persist `coldBootClipboardAutoPaste = 'always'`,
 *                      paste this time, and silently auto-paste on every
 *                      future cold boot with valid clipboard JSON.
 * - `just-this-time` - paste this once without changing the preference.
 *                      Banner returns next cold boot.
 * - `never`          - persist `coldBootClipboardAutoPaste = 'never'`,
 *                      do not paste, and never show this banner again.
 * - `dismiss`        - close the banner without changing the preference
 *                      and without pasting. Covers the X button, Esc,
 *                      and click-outside paths. Banner returns next
 *                      cold boot.
 */
export type ColdBootClipboardChoice = 'always' | 'just-this-time' | 'never' | 'dismiss';

/**
 * Non-blocking banner shown above the editor on cold boot when the
 * clipboard contains valid object/array JSON, the user has granted
 * clipboard-read permission, and their `coldBootClipboardAutoPaste`
 * preference is `'ask'`. Offers a one-shot Always / Just this time /
 * Never decision plus a dismiss escape hatch.
 *
 * Stateless and presentational: visibility is driven by a signal input
 * from the host component (which owns the cold-boot evaluator). User
 * intent is reported via the `choice` output. The host owns
 * preference writes, the snackbar undo, and telemetry emissions.
 */
@Component({
  selector: 'jj-cold-boot-clipboard-banner',
  standalone: true,
  imports: [MatButtonModule, MatCardModule, MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './cold-boot-clipboard-banner.component.html',
  styleUrl: './cold-boot-clipboard-banner.component.scss',
})
export class ColdBootClipboardBannerComponent {
  readonly visible = input.required<boolean>();

  readonly choice = output<ColdBootClipboardChoice>();

  onAlways(): void {
    this.choice.emit('always');
  }

  onJustThisTime(): void {
    this.choice.emit('just-this-time');
  }

  onNever(): void {
    this.choice.emit('never');
  }

  onDismiss(): void {
    this.choice.emit('dismiss');
  }
}
