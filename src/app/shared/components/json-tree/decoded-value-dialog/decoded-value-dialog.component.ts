import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ClipboardCopyService } from '../../../../core/clipboard/clipboard-copy.service';
import type { ExtractedJson } from '../../../../core/json/json-extractor.service';
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
  imports: [MatButtonModule, MatDialogModule, MatTooltipModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './decoded-value-dialog.component.html',
  styleUrl: './decoded-value-dialog.component.scss',
})
export class DecodedValueDialogComponent {
  readonly ref =
    inject<MatDialogRef<DecodedValueDialogComponent, DecodedValueDialogResult>>(MatDialogRef);
  readonly data = inject<DecodedValueDialogData>(MAT_DIALOG_DATA);
  private readonly clipboardCopy = inject(ClipboardCopyService);

  readonly titleLabel = $localize`:@@tree.decoded.dialog.title:Inspect string value`;
  readonly canExtract = computed(() => this.data.extractCandidate !== undefined);

  /**
   * The string is split on `\r\n` / `\n` / `\r` so CRLF and CR-only
   * payloads both render with one logical line per visual row. An
   * empty string still yields a single (empty) line so the gutter
   * remains visible.
   */
  readonly lines = computed<readonly DecodedLine[]>(() => {
    const value = this.data.value;
    const split = value.split(/\r\n|\r|\n/);
    return split.map((text, index) => ({ index: index + 1, text }));
  });

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
}
