import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AuthService } from '../../../core/auth/auth.service';
import { PreferencesService } from '../../../core/preferences/preferences.service';
import { LoggerService } from '../../../core/telemetry/logger.service';
import type { SuggestionCandidate } from '../../../core/title-suggester/types';
import { FileAccessError, FileAccessService } from '../../../core/upload/file-access.service';
import { SignedInDirective } from '../../directives/signed-in.directive';
import { JJ_MENU_IMPORTS } from '../../material/jj-menu-imports';
import { IconComponent, JjIconName } from '../icon/icon.component';
import { EMPTY_BEACON_INDEX, type BeaconIndex } from '../json-tree/formatting-beacons-index';
import { ToolbarBeaconPillsComponent } from '../toolbar-beacon-pills/toolbar-beacon-pills.component';

type ToolbarAction =
  | 'paste'
  | 'copy'
  | 'copyEscaped'
  | 'openFile'
  | 'download'
  | 'format'
  | 'minify'
  | 'sort'
  | 'clear'
  | 'save'
  | 'saveAsNewFile'
  | 'saveAsBlob'
  | 'copyShareLink'
  | 'deleteBlob'
  | 'fileChange';

type PillState = 'draft' | 'saved' | 'modified' | 'saving' | 'signInToSave';
type PillTextVariant = 'full' | 'compact';

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
export type PaneLayout = 'editor-only' | 'both-horizontal' | 'both-vertical' | 'tree-only';

@Component({
  selector: 'jj-toolbar',
  standalone: true,
  imports: [
    MatButtonModule,
    ...JJ_MENU_IMPORTS,
    MatTooltipModule,
    MatButtonToggleModule,
    IconComponent,
    SignedInDirective,
    ToolbarBeaconPillsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './toolbar.component.html',
  styleUrl: './toolbar.component.scss',
})
export class ToolbarComponent {
  private readonly auth = inject(AuthService);
  private readonly prefs = inject(PreferencesService);
  private readonly loggerService = inject(LoggerService);
  private readonly fileAccess = inject(FileAccessService);

  readonly hasContent = input<boolean>(false);
  readonly title = input<string>('');
  readonly canSave = input<boolean>(false);
  readonly isSavedBlob = input<boolean>(false);
  readonly isDirty = input<boolean>(false);
  readonly saveInFlight = input<boolean>(false);
  readonly loadedBlobTitle = input<string | null>(null);
  readonly isOwnedBlob = input<boolean>(false);
  /**
   * Set to true when a blob is loaded AND the signed-in user owns it.
   * Controls whether the 3-dot overflow menu (copy link / delete) is shown.
   */
  readonly isOwner = input<boolean>(false);

  /**
   * True when the document is bound to a local `FileSystemFileHandle`
   * via the M-PWA-write-back flow (`DocumentBacking` kind === 'file').
   * Drives:
   * - Pill state: `saved` / `modified` regardless of cloud sign-in.
   * - Save button visibility for anonymous users.
   * - Overflow menu items: `Save as new file...` + (if signed-in)
   *   `Save as blob...`, replacing the blob-owner items.
   */
  readonly isFileBacked = input<boolean>(false);

  /**
   * Filename of the bound local file, surfaced in tooltips and the
   * Save-as-blob dialog's suggested name. `null` when not file-backed.
   */
  readonly filename = input<string | null>(null);

  /**
   * Title-suggester candidates (M7p). Lazily populated by the parent
   * AFTER the user clicks the wand button -- the wand handler emits
   * `suggestRequested` synchronously, the parent computes candidates
   * and writes them back through this input, then mat-menu opens.
   *
   * Empty when the wand has never been clicked or content is empty.
   */
  readonly suggestedTitles = input<readonly SuggestionCandidate[]>([]);

  /**
   * Whether the wand button itself should be enabled (M7r). True when
   * the editor has non-empty content. Computed by the parent so this
   * component does not need direct access to the full editor text.
   */
  readonly wandEnabled = input<boolean>(false);

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
  readonly clipboardState = input<'enabled-json' | 'enabled-empty' | 'denied' | 'fallback'>(
    'fallback',
  );
  readonly clipboardPreview = input<string>('');

  /**
   * Beacon index passed through to `<jj-toolbar-beacon-pills>`. The
   * pills component renders nothing when the index is the
   * identity-shared `EMPTY_BEACON_INDEX`, so callers can default this
   * input rather than conditionally attaching the child component.
   */
  readonly beaconIndex = input<BeaconIndex>(EMPTY_BEACON_INDEX);

  readonly pasteRequested = output<void>();
  readonly copyRequested = output<void>();
  readonly copyEscaped = output<void>();
  readonly upload = output<File>();
  /**
   * Emitted when the user picks a local file via
   * `window.showOpenFilePicker` (Chromium-installed-PWA + Chromium-tab).
   * Carries both the resolved `File` and the writable
   * `FileSystemFileHandle` so the parent can bind the document to a
   * `kind: 'file'` `DocumentBacking` variant for the M-PWA-write-back
   * flow. The legacy `upload` event continues to fire for the
   * `<input type="file">` fallback path on Safari/Firefox (no handle).
   */
  readonly localFilePicked = output<{ file: File; handle: FileSystemFileHandle }>();
  readonly saveAsNewFile = output<void>();
  readonly saveAsBlob = output<void>();
  readonly download = output<void>();
  readonly clear = output<void>();
  readonly format = output<void>();
  readonly minify = output<void>();
  readonly sort = output<void>();
  readonly toggleTheme = output<void>();
  readonly toggleSelectionSync = output<void>();
  readonly paneLayoutChange = output<PaneLayout>();
  readonly save = output<void>();
  readonly titleChange = output<string>();
  readonly signInRequested = output<void>();
  readonly copyShareLink = output<void>();
  readonly deleteBlob = output<void>();

  /**
   * Title-suggester wand click (M7p). Fires synchronously when the
   * user clicks the wand button. The parent handler MUST populate
   * `[suggestedTitles]` synchronously in response so the mat-menu
   * (which opens on the same click via `[matMenuTriggerFor]`) sees
   * the freshly-computed list.
   */
  readonly suggestRequested = output<void>();

  private readonly fileInput = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');

  readonly themeIcon = computed<JjIconName>(() => {
    const theme = this.prefs.prefs().theme;
    if (theme === 'light') return 'sun';
    if (theme === 'dark') return 'moon';
    return 'system';
  });

  /**
   * Predictive tooltip for the 3-state theme toggle (M7f-2). The
   * cycle is `light -> dark -> system -> light`, so each state
   * advertises the next:
   *   - light  -> "Switch to dark theme"
   *   - dark   -> "Match system theme" (matches Profile dropdown's
   *               "Match system" copy)
   *   - system -> "Switch to light theme"
   *
   * The aria-label binds to the same computed value so screen readers
   * get the same affordance.
   */
  readonly themeToggleLabel = computed(() => {
    const theme = this.prefs.prefs().theme;
    if (theme === 'light') {
      return $localize`:@@toolbar.theme.tooltip.toDark:Switch to dark theme`;
    }
    if (theme === 'dark') {
      return $localize`:@@toolbar.theme.tooltip.toSystem:Match system theme`;
    }
    return $localize`:@@toolbar.theme.tooltip.toLight:Switch to light theme`;
  });

  /**
   * Tree<->editor selection sync (issue #42). Default-on user
   * preference; both this toolbar button and the matching toggle on
   * the profile page write through to the same `treeEditorSelectionSync`
   * key. Icon flips between `arrows-exchange` (on) and
   * `arrows-exchange-off` (off).
   */
  readonly selectionSyncEnabled = computed(() => this.prefs.prefs().treeEditorSelectionSync);
  readonly selectionSyncIcon = computed<JjIconName>(() =>
    this.selectionSyncEnabled() ? 'arrows-exchange' : 'arrows-exchange-off',
  );
  readonly selectionSyncTooltip = computed(() =>
    this.selectionSyncEnabled()
      ? $localize`:@@toolbar.syncSelection.tooltip.on:Disable tree-editor selection sync`
      : $localize`:@@toolbar.syncSelection.tooltip.off:Enable tree-editor selection sync`,
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

  readonly isSignedIn = computed(() => this.auth.isSignedIn());
  readonly ownsLoadedBlob = computed(() => this.isOwner() || this.isOwnedBlob());
  readonly pillState = computed<PillState>(() => {
    if (this.saveInFlight()) return 'saving';
    // File-backed shortcut: anonymous-OK; pill mirrors dirty/clean
    // against the saved snapshot. This branch runs BEFORE the
    // signInToSave branch so file-backed anonymous users never see
    // a cloud-auth nag.
    if (this.isFileBacked()) {
      return this.isDirty() ? 'modified' : 'saved';
    }
    if (!this.isSavedBlob()) return 'draft';
    if (!this.isSignedIn()) return 'signInToSave';
    if (this.isDirty()) return 'modified';
    return 'saved';
  });
  readonly pillTextFull = computed(() => this.pillTextForState(this.pillState(), 'full'));
  readonly pillTextCompact = computed(() => this.pillTextForState(this.pillState(), 'compact'));
  readonly pillStateClass = computed(() => `state-pill--${this.pillState()}`);
  readonly isCta = computed(() => this.pillState() === 'signInToSave');
  readonly saveButtonLabel = computed(() =>
    this.isSavedBlob() && !this.ownsLoadedBlob()
      ? $localize`:@@toolbar.save.asCopy:Save as copy`
      : $localize`:@@toolbar.save.label:Save`,
  );
  readonly isAnonymousOnSavedBlob = computed(() => this.isSavedBlob() && !this.isSignedIn());
  readonly untitledLabel = $localize`:@@toolbar.title.untitled:Untitled`;

  readonly wandAriaLabel = $localize`:@@toolbar.titleSuggestion.action.aria:Suggest a title`;
  readonly wandTooltip = $localize`:@@toolbar.titleSuggestion.action.tooltip:Suggest a title`;

  readonly saveDisabled = computed(() => !this.canSave() || this.saveInFlight());

  /**
   * The overflow menu is visible when:
   * - The signed-in user owns the loaded blob (existing blob actions),
   *   OR
   * - The document is file-backed (file actions: `Save as new file...`
   *   + signed-in-only `Save as blob...`).
   *
   * Mutually exclusive: the M-PWA-write-back flow keeps file backing
   * even after Save-as-blob (fire-and-forget snapshot) so a single
   * document is either blob-backed or file-backed, never both.
   */
  readonly showOverflowMenu = computed(() => this.ownsLoadedBlob() || this.isFileBacked());

  /**
   * Whether the toolbar Save button + overflow menu should render. Lifts
   * the historical `*jjSignedIn` wrapper around the Save block so
   * anonymous file-backed users can save to their local file (no cloud
   * auth required for the write-target).
   *
   * Truth table (verified in toolbar.component.test.ts):
   * - anonymous draft (isFileBacked=false, isSignedIn=false) -> false
   *   (no Save button shown; matches today's behavior).
   * - anonymous file-backed (isFileBacked=true, isSignedIn=false) ->
   *   true (Save button visible; new for M-PWA-write-back).
   * - signed-in draft / blob (isSignedIn=true) -> true.
   * - signed-in file-backed -> true.
   */
  readonly showSaveBlock = computed(() => this.isFileBacked() || this.isSignedIn());

  readonly saveTooltip = computed(() => {
    if (!this.saveInFlight() && this.saveDisabled()) {
      return $localize`:@@toolbar.save.disabledTooltip:No changes to save`;
    }
    if (!this.saveInFlight() && this.isFileBacked() && this.filename() !== null) {
      return $localize`:@@toolbar.save.fileTooltip:Save changes to ${this.filename()}:filename:`;
    }
    if (!this.saveInFlight() && this.isSavedBlob() && !this.ownsLoadedBlob()) {
      return $localize`:@@toolbar.save.asCopyTooltip:Save your changes as a new blob`;
    }
    return '';
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

  onTitleInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.titleChange.emit(value);
  }

  onTitleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !this.saveDisabled()) {
      event.preventDefault();
      this.emitToolbarAction('save');
      this.save.emit();
    }
  }

  onPasteClick(): void {
    this.emitToolbarAction('paste');
    this.pasteRequested.emit();
  }

  triggerFilePicker(): void {
    this.emitToolbarAction('openFile');
    // Chromium-installed-PWA + Chromium-tab: use the File System Access
    // picker so the resulting handle is writable. The promise resolves
    // null on user-cancel; rejects only for unexpected failures, which
    // we log + fall through to the legacy input. Safari/Firefox: the
    // feature-detect returns false and we go straight to the legacy
    // `<input type="file">` click.
    if (this.fileAccess.hasFileSystemAccess()) {
      void this.openViaPicker();
      return;
    }
    this.loggerService.info('file.openPicker.unsupported');
    this.fileInput().nativeElement.click();
  }

  private async openViaPicker(): Promise<void> {
    try {
      const result = await this.fileAccess.openLocalFile();
      if (result === null) return; // user-cancel
      this.localFilePicked.emit({ file: result.file, handle: result.handle });
    } catch (cause) {
      // Permission denied, picker failure, etc. The service has already
      // mapped to a typed FileAccessError; the parent's snackbar layer
      // is the user-facing surface for save failures, but a failed
      // picker open at the toolbar level is silent + logged.
      if (cause instanceof FileAccessError) {
        this.loggerService.warn('file.save.failed', { cause: cause.kind });
      } else {
        this.loggerService.warn('file.save.failed', { cause: 'writeError' });
      }
    }
  }

  onSaveAsNewFileClick(): void {
    this.emitToolbarAction('saveAsNewFile');
    this.saveAsNewFile.emit();
  }

  onSaveAsBlobClick(): void {
    this.emitToolbarAction('saveAsBlob');
    this.saveAsBlob.emit();
  }

  onFileChange(event: Event): void {
    const inputElement = event.target as HTMLInputElement;
    const file = inputElement.files?.[0];
    if (file) {
      this.emitToolbarAction('fileChange');
      this.upload.emit(file);
    }
    inputElement.value = '';
  }

  onDownloadClick(): void {
    this.emitToolbarAction('download');
    this.download.emit();
  }

  onFormatClick(): void {
    this.emitToolbarAction('format');
    this.format.emit();
  }

  onMinifyClick(): void {
    this.emitToolbarAction('minify');
    this.minify.emit();
  }

  onSortClick(): void {
    this.emitToolbarAction('sort');
    this.sort.emit();
  }

  onClearClick(): void {
    this.emitToolbarAction('clear');
    this.clear.emit();
  }

  onSaveClick(): void {
    this.emitToolbarAction('save');
    this.save.emit();
  }

  onCopyShareLinkClick(): void {
    this.emitToolbarAction('copyShareLink');
    this.copyShareLink.emit();
  }

  onDeleteBlobClick(): void {
    this.emitToolbarAction('deleteBlob');
    this.deleteBlob.emit();
  }

  /**
   * Wand-button click (M7p). Asks the parent to compute candidates
   * synchronously -- the parent writes the result back via
   * `[suggestedTitles]` BEFORE the mat-menu's `[matMenuTriggerFor]`
   * paints its items. We don't emit telemetry on open: only acceptance
   * counts as a real signal of usefulness (per AGENTS.md S6).
   */
  onWandClick(): void {
    this.suggestRequested.emit();
  }

  /**
   * Menu-item click (M7p). Sets the title field to the candidate's
   * value and records `toolbar.titleSuggestionAccepted` with the
   * source strategy and the menu's total candidate count. The
   * candidate's literal text is NEVER logged -- privacy per
   * AGENTS.md S6.
   */
  onSuggestionSelected(candidate: SuggestionCandidate): void {
    this.titleChange.emit(candidate.value);
    this.loggerService.event(
      'toolbar.titleSuggestionAccepted',
      { source: candidate.source },
      { candidateCount: this.suggestedTitles().length },
    );
  }

  onPaneLayoutChange(next: PaneLayout): void {
    this.paneLayoutChange.emit(next);
  }

  /**
   * Click handler for the Copy button. Alt-click is a power-user affordance
   * that copies the editor contents as a JSON-string-literal (see issue #38).
   */
  onCopyClick(event: MouseEvent): void {
    if (event.altKey) {
      this.emitToolbarAction('copyEscaped');
      this.copyEscaped.emit();
    } else {
      this.emitToolbarAction('copy');
      this.copyRequested.emit();
    }
  }

  private pillTextForState(state: PillState, variant: PillTextVariant): string {
    switch (state) {
      case 'draft':
        return $localize`:@@toolbar.state.draft:Draft`;
      case 'saved':
        return $localize`:@@toolbar.state.saved:Saved`;
      case 'modified':
        return $localize`:@@toolbar.state.modified:Modified`;
      case 'saving':
        return $localize`:@@toolbar.state.saving:Saving...`;
      case 'signInToSave':
        return variant === 'compact'
          ? $localize`:@@toolbar.state.signInToSaveCompact:Sign in`
          : $localize`:@@toolbar.state.signInToSave:Sign in to save`;
    }
    const exhaustiveState: never = state;
    return exhaustiveState;
  }

  private emitToolbarAction(action: ToolbarAction): void {
    this.loggerService.event('toolbar.action', { action }, undefined);
  }
}
