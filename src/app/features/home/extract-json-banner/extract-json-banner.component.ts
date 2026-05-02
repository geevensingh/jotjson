import { ChangeDetectionStrategy, Component, input, output, viewChildren } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { IconComponent } from '../../../shared/components/icon/icon.component';

/**
 * Banner shown above the editor when the JSON extractor finds one or more
 * candidate JSON blocks inside otherwise-mixed text the user just pasted.
 *
 * Stateless and presentational: visibility, block count, and whether comments
 * survive extraction are all driven by signal inputs from the host component.
 * User intent is reported via the `extract` and `dismiss` outputs.
 */
@Component({
  selector: 'jotjson-extract-json-banner',
  standalone: true,
  imports: [MatButtonModule, MatCardModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './extract-json-banner.component.html',
  styleUrl: './extract-json-banner.component.scss',
})
export class ExtractJsonBannerComponent {
  readonly visible = input.required<boolean>();
  readonly blockCount = input.required<number>();
  /**
   * When true, the banner shows a "Comments will be dropped" secondary line
   * beneath the message. The host computes this from the extractor result
   * as `hasComments && !preservesComments` so we only warn when the source
   * actually contained comments AND the output format will lose them.
   */
  readonly commentsWillBeDropped = input.required<boolean>();

  readonly extract = output<void>();
  readonly dismiss = output<void>();

  /**
   * The Extract button - either the single-block or the multi-block variant
   * depending on `blockCount`. Only one is rendered at a time, so we use
   * `viewChildren` (returning at most one match) and focus the first.
   */
  private readonly extractButtons = viewChildren<HTMLButtonElement>('extractButton');

  /**
   * Move keyboard focus to the rendered Extract button. Called by the host
   * after a paste-driven banner show so keyboard users don't have to tab in.
   * Safe to call before the button is in the DOM - it is a no-op then.
   */
  focusExtractButton(): void {
    this.extractButtons()[0]?.focus();
  }
}
