import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TitleSuggesterService } from '../../../core/title-suggester/title-suggester.service';
import type { SuggestionCandidate } from '../../../core/title-suggester/types';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { JJ_MENU_IMPORTS } from '../../../shared/material/jj-menu-imports';

/**
 * Data injected via `MAT_DIALOG_DATA` when HomeComponent.onSaveAsBlob
 * opens this dialog. Carries everything the title-suggester needs
 * (`SuggestionInput` shape) plus the seed title for the input field.
 */
export interface SaveAsBlobDialogData {
  /**
   * Initial value for the title input. Typically derived from the
   * file's display name (sans extension) or the current document
   * title; HomeComponent picks the best seed.
   */
  readonly initialTitle: string;
  /**
   * Suggester input -- raw editor text. Forwarded to the suggester
   * unchanged (no re-parse).
   */
  readonly jsonText: string;
  /**
   * Suggester input -- already-parsed JSON value (`undefined` for
   * parse errors). Forwarded to the suggester unchanged.
   */
  readonly parsed: unknown;
  /**
   * Suggester input -- true when the document had parse errors.
   */
  readonly hasParseErrors: boolean;
  /**
   * Suggester input -- the bound local file's display name, or null
   * for a draft document. For the M-PWA-write-back Save-as-blob flow
   * this is always non-null (the dialog is reachable only from a
   * file-backed document's overflow menu).
   */
  readonly filename: string | null;
}

/**
 * Result returned via `MatDialogRef.close()` on Save. `undefined`
 * means the user cancelled.
 */
export interface SaveAsBlobDialogResult {
  readonly title: string;
}

/**
 * Dialog component for the file-backed Save-as-blob flow.
 *
 * Phase 4c of M-PWA-write-back. The dialog:
 *
 * - Takes a title seed + the suggester's standard input shape.
 * - Renders a title text input + a wand button (mat-menu) that
 *   surfaces title-suggester candidates on click. Picking a
 *   candidate replaces the input value (same precedent as the
 *   toolbar's title-suggester wand, see ToolbarComponent).
 * - Surfaces the fire-and-forget semantics in dialog copy: the
 *   local file binding survives the cloud save; subsequent
 *   Save-as-blob clicks create new cloud copies (the local file
 *   stays the single source of truth for the primary Save flow).
 * - Returns `{ title }` on Save, `undefined` on Cancel.
 *
 * Per skeptic v2 #6 (SaveAsBlob from file-backed has no hybrid
 * variant) + plan v2 user decision: the dialog explicitly states
 * the trade-off so the user opts into the fire-and-forget semantics
 * with full awareness.
 *
 * Per skeptic v2 #12 (hiding title input orphans the wand): the
 * wand lives inside this dialog rather than the toolbar header so a
 * signed-in file-backed user still gets the title-suggester wand UX
 * for cloud-blob naming, despite the toolbar's title input being
 * available unchanged for blob-backed documents.
 *
 * Placement under `features/home/` (vs `shared/dialogs/`) because
 * the dialog is invoked only from HomeComponent's overflow menu and
 * is not reusable elsewhere; the dialog's dependency on
 * `TitleSuggesterService` (which lives in `core/`, not
 * `features/home/`) is not the placement reason -- the
 * non-reusability is. Matches the precedent of
 * `clone-preset-dialog.component.ts` (a sibling under
 * `features/home/rule-sets-toolbar/`).
 */
@Component({
  selector: 'jj-save-as-blob-dialog',
  standalone: true,
  imports: [MatButtonModule, MatDialogModule, MatTooltipModule, IconComponent, ...JJ_MENU_IMPORTS],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title i18n="@@saveAsBlobDialog.title">Save as cloud blob</h2>
    <mat-dialog-content>
      <p class="lead" i18n="@@saveAsBlobDialog.lead">
        Create a separate cloud copy of the current document. The local file stays bound to your
        editor and continues to receive Save writes.
      </p>
      <div class="title-row">
        <label
          class="title-label"
          for="save-as-blob-title-input"
          i18n="@@saveAsBlobDialog.titleLabel"
        >
          Title
        </label>
        <div class="title-input-group">
          <input
            id="save-as-blob-title-input"
            class="title-input"
            type="text"
            [value]="title()"
            (input)="onTitleInput($event)"
            (keydown)="onTitleKeydown($event)"
            i18n-placeholder="@@saveAsBlobDialog.placeholder"
            placeholder="Untitled"
            maxlength="200"
            aria-label="Cloud blob title"
            i18n-aria-label="@@saveAsBlobDialog.titleAria"
            autocomplete="off"
            autofocus
          />
          <button
            type="button"
            mat-icon-button
            class="wand"
            i18n-aria-label="@@toolbar.titleSuggestion.action.aria"
            aria-label="Suggest a title"
            i18n-matTooltip="@@toolbar.titleSuggestion.action.tooltip"
            matTooltip="Suggest a title"
            [matMenuTriggerFor]="suggestionsMenu"
            (click)="onWandClick()"
          >
            <jj-icon name="wand" />
          </button>
          <mat-menu #suggestionsMenu="matMenu" class="jj-menu">
            @for (candidate of suggestedTitles(); track candidate.value) {
              <button mat-menu-item type="button" (click)="onSuggestionSelected(candidate)">
                <span>{{ candidate.value }}</span>
              </button>
            }
          </mat-menu>
        </div>
      </div>
      <p class="hint" i18n="@@saveAsBlobDialog.fireAndForget">
        Subsequent Save still writes the local file. To update the cloud copy, use Save as blob...
        again to create a new copy.
      </p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" (click)="onCancel()" i18n="@@common.cancel">Cancel</button>
      <button
        mat-flat-button
        color="primary"
        type="button"
        [disabled]="saveDisabled()"
        (click)="onSave()"
        i18n="@@saveAsBlobDialog.save"
      >
        Save
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .lead {
        margin: 0 0 12px;
        color: var(--mat-sys-on-surface-variant, #aeb6c2);
      }
      .title-row {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-bottom: 12px;
      }
      .title-label {
        font-weight: 600;
        font-size: 13px;
      }
      .title-input-group {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .title-input {
        flex: 1;
        padding: 6px 8px;
        background: var(--surface-1, rgba(127, 127, 127, 0.08));
        border: 1px solid var(--border-subtle, rgba(127, 127, 127, 0.25));
        border-radius: 4px;
        font: inherit;
        color: inherit;
      }
      .title-input:focus-visible {
        outline: 2px solid var(--focus-ring, #4c9aff);
        outline-offset: 1px;
      }
      .hint {
        margin: 0;
        font-size: 12px;
        color: var(--mat-sys-on-surface-variant, #aeb6c2);
      }
    `,
  ],
})
export class SaveAsBlobDialogComponent {
  readonly ref =
    inject<MatDialogRef<SaveAsBlobDialogComponent, SaveAsBlobDialogResult | undefined>>(
      MatDialogRef,
    );
  readonly data = inject<SaveAsBlobDialogData>(MAT_DIALOG_DATA);
  private readonly suggester = inject(TitleSuggesterService);

  readonly title = signal<string>(this.data.initialTitle);
  readonly suggestedTitles = signal<readonly SuggestionCandidate[]>([]);

  saveDisabled = (): boolean => this.title().trim().length === 0;

  onTitleInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.title.set(value);
  }

  onTitleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !this.saveDisabled()) {
      event.preventDefault();
      this.onSave();
    }
  }

  /**
   * Populate suggestion candidates lazily on wand click. The mat-menu
   * opens on the same click via `[matMenuTriggerFor]`; populating the
   * signal synchronously here means the menu sees the freshly-computed
   * list when it paints its items.
   */
  onWandClick(): void {
    const candidates = this.suggester.suggest({
      jsonText: this.data.jsonText,
      parsed: this.data.parsed,
      hasParseErrors: this.data.hasParseErrors,
      filename: this.data.filename,
    });
    this.suggestedTitles.set(candidates);
  }

  onSuggestionSelected(candidate: SuggestionCandidate): void {
    this.title.set(candidate.value);
  }

  onSave(): void {
    const trimmed = this.title().trim();
    if (trimmed.length === 0) return;
    this.ref.close({ title: trimmed });
  }

  onCancel(): void {
    this.ref.close(undefined);
  }
}
