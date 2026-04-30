import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  viewChild
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { PreferencesService } from '../../../core/preferences/preferences.service';
import { SignedInDirective } from '../../directives/signed-in.directive';
import { IconComponent, JjIconName } from '../icon/icon.component';

export type EditorMode = 'json' | 'jsonc';

/**
 * 4-state pane layout segmented control. The toolbar's parent
 * (`HomeComponent`) derives this from two underlying preferences:
 *  - `paneVisibility` (local-only, one of `'both' | 'editor-only' |
 *    'tree-only'`).
 *  - `layoutOrientation` (roamed via UserPreferences, one of
 *    `'horizontal' | 'vertical'`).
 *
 * The two `both-*` segments expose the orientation directly so users
 * can swap orientations without first restoring both panes; the
 * `editor-only` and `tree-only` segments leave `layoutOrientation`
 * untouched (it gets restored when the user picks a `both-*` segment
 * again).
 */
export type PaneLayout =
  | 'editor-only'
  | 'both-horizontal'
  | 'both-vertical'
  | 'tree-only';

@Component({
  selector: 'jj-toolbar',
  standalone: true,
  imports: [
    MatButtonModule,
    MatMenuModule,
    MatTooltipModule,
    MatButtonToggleModule,
    IconComponent,
    SignedInDirective
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './toolbar.component.html',
  styleUrl: './toolbar.component.scss'
})
export class ToolbarComponent {
  private readonly prefs = inject(PreferencesService);

  readonly mode = input<EditorMode>('json');
  readonly hasContent = input<boolean>(false);
  readonly title = input<string>('');
  readonly canSave = input<boolean>(false);
  readonly saveInFlight = input<boolean>(false);
  /**
   * Set to true when a blob is loaded AND the signed-in user owns it.
   * Controls whether the 3-dot overflow menu (copy link / toggle visibility
   * / delete) is shown.
   */
  readonly isOwner = input<boolean>(false);
  /** Current isPublic flag of the loaded blob, drives the visibility toggle label. */
  readonly isPublic = input<boolean>(false);

  /**
   * 4-state pane layout (issue #39 follow-up). Driven by the parent
   * via `[paneLayout]`; segment changes raise `paneLayoutChange`,
   * which the parent translates back into the two underlying
   * preferences (see `PaneLayout` for details).
   */
  readonly paneLayout = input<PaneLayout>('both-horizontal');

  /**
   * Clipboard UX state driving the Paste button, per DESIGN_SPEC.md §Smart
   * Paste Button. One of:
   * - `enabled-json`  : accent-tinted, tooltip shows the `clipboardPreview`
   * - `enabled-empty` : disabled, "Clipboard does not contain JSON"
   * - `denied`        : disabled with instructions to re-enable permission
   * - `fallback`      : neutral state (clipboard API unsupported / unknown /
   *                      not yet prompted); click path does a user-gesture
   *                      read via `ClipboardPollingService.readForPaste`.
   */
  readonly clipboardState = input<
    'enabled-json' | 'enabled-empty' | 'denied' | 'fallback'
  >('fallback');
  readonly clipboardPreview = input<string>('');

  readonly pasteRequested = output<void>();
  readonly copyRequested = output<void>();
  readonly copyEscaped = output<void>();
  readonly upload = output<File>();
  readonly download = output<void>();
  readonly clear = output<void>();
  readonly format = output<void>();
  readonly minify = output<void>();
  readonly modeChange = output<EditorMode>();
  readonly toggleTheme = output<void>();
  readonly toggleSelectionSync = output<void>();
  readonly paneLayoutChange = output<PaneLayout>();
  readonly save = output<void>();
  readonly titleChange = output<string>();
  readonly copyShareLink = output<void>();
  readonly togglePublic = output<void>();
  readonly deleteBlob = output<void>();

  private readonly fileInput =
    viewChild.required<ElementRef<HTMLInputElement>>('fileInput');

  readonly themeIcon = computed<JjIconName>(() => {
    const theme = this.prefs.prefs().theme;
    if (theme === 'light') return 'sun';
    if (theme === 'dark') return 'moon';
    return 'system';
  });

  /**
   * Tree<->editor selection sync (issue #42). Default-on user
   * preference; both this toolbar button and the matching toggle on
   * the profile page write through to the same `treeEditorSelectionSync`
   * key. Icon flips between `arrows-exchange` (on) and
   * `arrows-exchange-off` (off).
   */
  readonly selectionSyncEnabled = computed(
    () => this.prefs.prefs().treeEditorSelectionSync
  );
  readonly selectionSyncIcon = computed<JjIconName>(() =>
    this.selectionSyncEnabled() ? 'arrows-exchange' : 'arrows-exchange-off'
  );
  readonly selectionSyncTooltip = computed(() =>
    this.selectionSyncEnabled()
      ? $localize`:@@toolbar.syncSelection.tooltip.on:Disable tree-editor selection sync`
      : $localize`:@@toolbar.syncSelection.tooltip.off:Enable tree-editor selection sync`
  );
  readonly selectionSyncAriaLabel = $localize`:@@toolbar.syncSelection.aria:Toggle tree-editor selection sync`;

  /**
   * 4-state pane layout segmented control (issue #39 follow-up).
   * Each segment shows the icon for the layout it picks; selecting
   * a segment is a direct jump (no cycling). The two `both-*`
   * variants are adjacent so a user can swap orientations without
   * first restoring both panes.
   */
  readonly paneLayoutGroupAriaLabel = $localize`:@@toolbar.paneLayout.aria:Pane layout`;
  readonly paneLayoutEditorOnlyLabel = $localize`:@@toolbar.paneLayout.editorOnly:Show editor only`;
  readonly paneLayoutBothHorizontalLabel = $localize`:@@toolbar.paneLayout.bothHorizontal:Editor and tree side-by-side`;
  readonly paneLayoutBothVerticalLabel = $localize`:@@toolbar.paneLayout.bothVertical:Editor above tree`;
  readonly paneLayoutTreeOnlyLabel = $localize`:@@toolbar.paneLayout.treeOnly:Show tree only`;

  readonly saveDisabled = computed(
    () => !this.canSave() || !this.hasContent() || this.saveInFlight()
  );

  /**
   * The overflow menu is visible only when the parent tells us the current
   * signed-in user owns the loaded blob.
   */
  readonly showOverflowMenu = computed(() => this.isOwner());

  readonly visibilityMenuLabel = computed(() =>
    this.isPublic()
      ? $localize`:@@toolbar.overflow.makePrivate:Make private`
      : $localize`:@@toolbar.overflow.makePublic:Make public`
  );

  readonly saveTooltip = computed(() => {
    if (this.saveInFlight()) return $localize`:@@toolbar.save.tooltip.saving:Saving...`;
    if (!this.hasContent()) return $localize`:@@toolbar.save.tooltip.empty:Nothing to save`;
    return $localize`:@@toolbar.save.tooltip.save:Save & share`;
  });

  readonly pasteDisabled = computed(() => {
    const state = this.clipboardState();
    return state === 'enabled-empty' || state === 'denied';
  });

  readonly pasteTooltip = computed(() => {
    switch (this.clipboardState()) {
      case 'enabled-json': {
        const preview = this.clipboardPreview();
        return preview
          ? $localize`:@@toolbar.paste.tooltip.ready:Paste: ${preview}:PREVIEW:`
          : $localize`:@@toolbar.paste.tooltip.readyNoPreview:Paste from clipboard`;
      }
      case 'enabled-empty':
        return $localize`:@@toolbar.paste.tooltip.empty:Clipboard does not contain JSON`;
      case 'denied':
        return $localize`:@@toolbar.paste.tooltip.denied:Clipboard access blocked - enable it in your browser settings. Ctrl+V still works.`;
      default:
        return $localize`:@@toolbar.paste.tooltip:Paste from clipboard`;
    }
  });

  onTitleInput(ev: Event): void {
    const value = (ev.target as HTMLInputElement).value;
    this.titleChange.emit(value);
  }

  onTitleKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Enter' && !this.saveDisabled()) {
      ev.preventDefault();
      this.save.emit();
    }
  }

  triggerFilePicker(): void {
    this.fileInput().nativeElement.click();
  }

  onFileChange(ev: Event): void {
    const el = ev.target as HTMLInputElement;
    const file = el.files?.[0];
    if (file) this.upload.emit(file);
    el.value = '';
  }

  onModeChange(next: EditorMode): void {
    this.modeChange.emit(next);
  }

  onPaneLayoutChange(next: PaneLayout): void {
    this.paneLayoutChange.emit(next);
  }

  /**
   * Click handler for the Copy button. Alt-click is a power-user affordance
   * that copies the editor contents as a JSON-string-literal (see issue #38).
   */
  onCopyClick(ev: MouseEvent): void {
    if (ev.altKey) {
      this.copyEscaped.emit();
    } else {
      this.copyRequested.emit();
    }
  }
}

