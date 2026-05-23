import { LiveAnnouncer } from '@angular/cdk/a11y';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ClipboardCopyService } from '../../../../core/clipboard/clipboard-copy.service';
import type { ExtractedJson } from '../../../../core/json/json-extractor.service';
import { LoggerService } from '../../../../core/telemetry/logger.service';
import { decodeLossyMangling, detectLossyMangling } from '../../../../core/text/lossy-mangling';
import { IconComponent } from '../../icon/icon.component';

/**
 * Read-only data passed via `MAT_DIALOG_DATA` when the parent tree row
 * opens the decoded-value viewer. `value` is the raw string leaf value
 * (with real `\n` / `\r` / `\t` / quotes / backslashes); the dialog
 * renders it as `pre-wrap` text with line numbers. `pathString` is the
 * originating tree row's path (e.g. `$.users[0].message`) and is shown
 * in the dialog title for orientation.
 */
export interface DecodedValueDialogData {
  readonly value: string;
  readonly pathString: string;
  /**
   * Optional. When present, the dialog renders an 'Extract embedded JSON'
   * button that closes the dialog with `{ extract: true }`. The tree
   * component re-validates at close time.
   */
  readonly extractCandidate?: ExtractedJson;
  /**
   * Optional. The originating tree row's path (e.g. `['payload', 0]`)
   * for the extractable candidate. Carried through so the tree
   * component can re-validate against the live source-version map at
   * dialog-close time without re-deriving the path from `pathString`.
   * Should be supplied whenever `extractCandidate` is supplied.
   */
  readonly extractPath?: readonly (string | number)[];
}

export type DecodedValueDialogResult = { extract: true } | undefined;

interface DecodedLine {
  readonly index: number;
  readonly text: string;
}

/**
 * Modal viewer for a single string leaf shown in its decoded form.
 *
 * Replaces the old per-row inline `pre-wrap` toggle (issue #95
 * Phase 0): uniform tree-row height is required for fixed-size virtual
 * scrolling, and content-driven row heights are fundamentally
 * incompatible with that. The dialog is a strict superset of the prior
 * inline render: line numbers, dedicated copy button, larger font,
 * and a mobile-friendly viewport. When the caller supplies an
 * `extractCandidate`, the dialog also hosts the confirm-before-mutate
 * "Extract embedded JSON" action.
 *
 * The component is self-contained: it does not depend on the tree
 * component, and accepts only the raw string value plus its originating
 * path for the title. Copy goes through `ClipboardCopyService` so the
 * three-state (success / failed / unsupported) snackbar UX matches every
 * other copy affordance in the app. The snackbar surfaces on the global
 * `MatSnackBar` instance, NOT stacked above the dialog overlay.
 */
@Component({
  selector: 'jj-decoded-value-dialog',
  standalone: true,
  imports: [
    MatButtonModule,
    MatDialogModule,
    MatSlideToggleModule,
    MatTooltipModule,
    IconComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './decoded-value-dialog.component.html',
  styleUrl: './decoded-value-dialog.component.scss',
})
export class DecodedValueDialogComponent {
  readonly ref =
    inject<MatDialogRef<DecodedValueDialogComponent, DecodedValueDialogResult>>(MatDialogRef);
  readonly data = inject<DecodedValueDialogData>(MAT_DIALOG_DATA);
  private readonly clipboardCopy = inject(ClipboardCopyService);
  private readonly liveAnnouncer = inject(LiveAnnouncer);
  private readonly logger = inject(LoggerService);

  readonly titleLabel = $localize`:@@tree.decoded.dialog.title:Inspect string value`;
  readonly canExtract = computed(() => this.data.extractCandidate !== undefined);

  /**
   * Heuristic detection of lossy-transcoded mangling shapes in the raw
   * value. The result drives the visibility of the Decode toggle:
   * `kind === 'none'` keeps the dialog identical to its pre-feature
   * shape; any non-`none` kind surfaces a sub-header strip with the
   * toggle. Detection is pure / deterministic / O(n) and runs once via
   * `computed` (memoised per distinct `data.value`).
   */
  readonly detection = computed(() => detectLossyMangling(this.data.value));

  /** True when {@link detection} returned a non-`none` kind. */
  readonly manglingActive = computed(() => this.detection().kind !== 'none');

  /**
   * Toggle state: false (default) renders the raw value; true renders
   * the prefix-decoded variant from {@link decodeLossyMangling}. The
   * toggle is dialog-local; closing the dialog forgets it. The
   * underlying `data.value` is never mutated.
   */
  private readonly _decoded = signal(false);
  readonly decoded = this._decoded.asReadonly();

  /**
   * The string the dialog actually renders. In raw mode it is
   * `data.value` verbatim; in decoded mode it is the prefix-decoded
   * variant. Memoised by `computed`, so toggle flips compute once per
   * distinct boolean and `lines` re-flows automatically.
   */
  readonly displayValue = computed(() => {
    if (!this._decoded()) return this.data.value;
    return decodeLossyMangling(this.data.value, this.detection().kind);
  });

  /**
   * The string is split on `\r\n` / `\n` / `\r` so CRLF and CR-only
   * payloads both render with one logical line per visual row. An
   * empty string still yields a single (empty) line so the gutter
   * remains visible. Rebased on {@link displayValue} so the decoded
   * toggle re-flows the line numbers automatically.
   */
  readonly lines = computed<readonly DecodedLine[]>(() => {
    const value = this.displayValue();
    const split = value.split(/\r\n|\r|\n/);
    return split.map((text, index) => ({ index: index + 1, text }));
  });

  readonly manglingToggleLabel = $localize`:@@tree.decoded.dialog.manglingToggle.label:Decode HTTP "??" framing as line breaks`;
  readonly manglingToggleTooltip = $localize`:@@tree.decoded.dialog.manglingToggle.tooltip:This string looks like it contains HTTP request or response framing whose line breaks were replaced with "??". Toggle to render the framing as multi-line. Body content is preserved verbatim.`;

  extract(): void {
    this.ref.close({ extract: true });
  }

  copy(): void {
    void this.clipboardCopy.copyWithToast(this.data.value, {
      success: $localize`:@@tree.decoded.dialog.copied:Decoded value copied to clipboard.`,
      failed: $localize`:@@tree.decoded.dialog.copyFailed:Failed to copy decoded value.`,
      unsupported: $localize`:@@tree.decoded.dialog.copyUnsupported:Copy is not supported in this browser.`,
    });
  }

  /**
   * Copies the prefix-decoded form (with real line breaks) of the raw
   * value to the clipboard. Visible only when the decode toggle is on.
   * The raw {@link copy} button continues to copy `data.value`
   * verbatim, preserving the DESIGN_SPEC §502 copy invariant
   * ("the dialog's Copy button writes the raw string").
   */
  copyWithLineBreaks(): void {
    const decoded = decodeLossyMangling(this.data.value, this.detection().kind);
    void this.clipboardCopy.copyWithToast(decoded, {
      success: $localize`:@@tree.decoded.dialog.copyWithLineBreaks.copied:Decoded value with line breaks copied to clipboard.`,
      failed: $localize`:@@tree.decoded.dialog.copyWithLineBreaks.failed:Failed to copy decoded value with line breaks.`,
      unsupported: $localize`:@@tree.decoded.dialog.copyUnsupported:Copy is not supported in this browser.`,
    });
  }

  /**
   * Handler bound to the mat-slide-toggle's `change` event. Updates
   * the dialog-local toggle signal, announces the new visual state
   * via {@link LiveAnnouncer} for screen-reader users, and emits one
   * `tree.decoded.manglingToggle` telemetry event with the post-flip
   * state.
   */
  toggleDecoded(checked: boolean): void {
    this._decoded.set(checked);
    const announce = checked
      ? $localize`:@@tree.decoded.dialog.announceDecoded:Showing HTTP framing as multi-line.`
      : $localize`:@@tree.decoded.dialog.announceRaw:Showing raw value.`;
    void this.liveAnnouncer.announce(announce);
    this.logger.event('tree.decoded.manglingToggle', {
      to: checked ? 'decoded' : 'raw',
    });
  }
}
