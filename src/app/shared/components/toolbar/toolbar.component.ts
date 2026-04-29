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
export type PaneVisibility = 'both' | 'editor-only' | 'tree-only';

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
   * 3-state pane visibility cycle (issue #39). Driven by a localStorage-
   * backed signal in the parent (`HomeComponent.paneVisibility`); the
   * toolbar simply renders the icon/label and emits a cycle event on
   * click. The order is `both -> editor-only -> tree-only -> both`.
   */
  readonly paneVisibility = input<PaneVisibility>('both');

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
  readonly toggleLayout = output<void>();
  readonly toggleTheme = output<void>();
  readonly toggleSelectionSync = output<void>();
  readonly togglePaneVisibility = output<void>();
  readonly save = output<void>();
  readonly titleChange = output<string>();
  readonly copyShareLink = output<void>();
  readonly togglePublic = output<void>();
  readonly deleteBlob = output<void>();

  private readonly fileInput =
    viewChild.required<ElementRef<HTMLInputElement>>('fileInput');

  readonly layoutIcon = computed<JjIconName>(() =>
    this.prefs.prefs().layoutOrientation === 'horizontal'
      ? 'layout-vertical'
      : 'layout-horizontal'
  );

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
   * 3-state pane visibility (issue #39). The icon depicts the NEXT
   * state (what clicking will do), per spec: `both` -> show
   * `pane-left-only` (next click hides tree), `editor-only` -> show
   * `pane-right-only` (next click hides editor), `tree-only` -> show
   * `pane-both` (next click restores both panes).
   *
   * The next-action label is reused for both `matTooltip` and the
   * button's dynamic `aria-label` so screen readers announce the
   * action that activation will perform.
   */
  readonly paneVisibilityIcon = computed<JjIconName>(() => {
    switch (this.paneVisibility()) {
      case 'both':
        return 'pane-left-only';
      case 'editor-only':
        return 'pane-right-only';
      case 'tree-only':
        return 'pane-both';
    }
  });
  readonly paneVisibilityNextActionLabel = computed(() => {
    switch (this.paneVisibility()) {
      case 'both':
        return $localize`:@@toolbar.paneVisibility.tooltip.next.editorOnly:Hide tree (show editor only)`;
      case 'editor-only':
        return $localize`:@@toolbar.paneVisibility.tooltip.next.treeOnly:Hide editor (show tree only)`;
      case 'tree-only':
        return $localize`:@@toolbar.paneVisibility.tooltip.next.both:Show both panes`;
    }
  });

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

