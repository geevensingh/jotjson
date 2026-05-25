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
   * button that closes the dialog with `{ kind: 'extract' }`. The tree
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

export type DecodedValueDialogResult =
  | { readonly kind: 'extract' }
  | { readonly kind: 'applyDecoded' }
  | undefined;

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

  readonly manglingToggleLabel = $localize`:@@tree.decoded.dialog.manglingToggle.label:Show "??" as line breaks`;
  readonly manglingToggleTooltip = $localize`:@@tree.decoded.dialog.manglingToggle.tooltip:This string has more "??" markers than line breaks - they may be where line breaks were lost in transcoding. Toggle to render the "??" markers as line breaks. The underlying value is not modified; use Apply to commit the change.`;
  readonly applyTooltip = $localize`:@@tree.decoded.dialog.apply.tooltip:Replaces the "??" markers in this string with CRLF line breaks. Can be undone via the snackbar or Ctrl+Z.`;

  extract(): void {
    this.ref.close({ kind: 'extract' });
  }

  copy(): void {
    void this.clipboardCopy.copyWithToast(this.displayValue(), {
      success: $localize`:@@tree.contextMenu.copy.success.value:Value copied to clipboard.`,
      failed: $localize`:@@tree.contextMenu.copy.failed.value:Failed to copy value.`,
      unsupported: $localize`:@@tree.contextMenu.copy.unsupported:Copy is not supported in this browser.`,
    });
  }

  /**
   * Closes the dialog with `{ kind: 'applyDecoded' }`, signaling to the
   * parent tree component that the user authorized a same-path,
   * same-version replacement of the raw mangled string with the
   * prefix-decoded form (CRLF for `httpFraming`).
   *
   * The dialog only emits the intent + a present-progressive
   * screen-reader announcement ("Applying decoded value to source.")
   * here; the actual document mutation, undo group, success snackbar
   * (which is `politeness: 'assertive'` and announces the confirmed
   * outcome), and `home.decodedApply.applied` telemetry are owned by
   * `HomeComponent` (`onApplyDecodedRequest`). The announce is
   * deliberately present-progressive rather than past-tense: the
   * request can still be dropped downstream (tree-side `staleClose`
   * re-validation, home-side `applyFailed`, or a no-op patch), so the
   * dialog must not claim success at click time. Mirrors how
   * `extract()` hands off to `HomeComponent.onExtractRequest`.
   */
  applyDecoded(): void {
    const manglingKind = this.detection().kind;
    this.ref.close({ kind: 'applyDecoded' });
    void this.liveAnnouncer.announce(
      $localize`:@@tree.decoded.dialog.announceApplied:Applying decoded value to source.`,
    );
    this.logger.event('tree.decoded.apply', {
      manglingKind,
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
      ? $localize`:@@tree.decoded.dialog.announceDecoded:Showing "??" markers as line breaks.`
      : $localize`:@@tree.decoded.dialog.announceRaw:Showing raw value.`;
    void this.liveAnnouncer.announce(announce);
    this.logger.event('tree.decoded.manglingToggle', {
      to: checked ? 'decoded' : 'raw',
    });
  }
}
