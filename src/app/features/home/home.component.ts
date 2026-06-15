import { isPlatformBrowser } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  HostListener,
  inject,
  input,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarRef, TextOnlySnackBar } from '@angular/material/snack-bar';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { createScanner, findNodeAtLocation, Node as JsoncNode } from 'jsonc-parser';
import {
  debounceTime,
  firstValueFrom,
  map,
  merge,
  of,
  pairwise,
  startWith,
  Subject,
  switchMap,
  timer,
} from 'rxjs';
import { BlobService } from '../../core/api/blob.service';
import type { BlobHighlight, CreateBlobResponse, JsonBlob } from '../../core/api/models';
import { AuthService } from '../../core/auth/auth.service';
import {
  BeaconNavigationService,
  type BeaconJumpRequest,
} from '../../core/beacons/beacon-navigation.service';
import { ClipboardCopyService } from '../../core/clipboard/clipboard-copy.service';
import {
  ClipboardPollingService,
  type ClipboardGrantedReadResult,
} from '../../core/clipboard/clipboard-polling.service';
import { EnvLabelService } from '../../core/env/env-label.service';
import { formatText } from '../../core/json/format-text';
import {
  ExtractedJson,
  IndentSize,
  JsonExtractorService,
} from '../../core/json/json-extractor.service';
import { JsonParseResult, JsonParserService } from '../../core/json/json-parser.service';
import { TreeStringExtractorService } from '../../core/json/tree-string-extractor.service';
import { createNarrowViewportSignal } from '../../core/layout/narrow-viewport';
import { LoadingSplashService } from '../../core/loading-splash/loading-splash.service';
import { DraftService } from '../../core/preferences/draft.service';
import { persistedSignal } from '../../core/preferences/persisted-signal';
import { PreferencesService } from '../../core/preferences/preferences.service';
import { QuotaNotificationService } from '../../core/quota/quota-notification.service';
import { SeoService } from '../../core/seo/seo.service';
import { bucketBytes, bucketCount, bucketUndoLatency } from '../../core/telemetry/buckets';
import { LoggerService } from '../../core/telemetry/logger.service';
import type { TelemetryMeasurements } from '../../core/telemetry/telemetry.service';
import { TitleSuggesterService } from '../../core/title-suggester/title-suggester.service';
import type { SuggestionCandidate } from '../../core/title-suggester/types';
import {
  DRAFT_BACKING,
  getSavedSnapshot,
  type DocumentBacking,
  type LoadedSnapshot,
} from '../../core/upload/document-backing';
import { DocumentDropController } from '../../core/upload/document-drop-controller.service';
import {
  FileAccessError,
  FileAccessService,
  type FileAccessFailureCause,
} from '../../core/upload/file-access.service';
import { LaunchQueueController } from '../../core/upload/launch-queue-controller.service';
import { validateAndReadSingleFile } from '../../core/upload/upload-file-validator';
import { AppHeaderComponent } from '../../shared/components/app-header/app-header.component';
import { JsonEditorComponent } from '../../shared/components/json-editor/json-editor.component';
import {
  EMPTY_BEACON_INDEX,
  type BeaconIndex,
} from '../../shared/components/json-tree/formatting-beacons-index';
import { highlightsEqual } from '../../shared/components/json-tree/highlight-resolver';
import {
  JsonTreeComponent,
  type TreeApplyDecodedRequest,
  type TreeExtractRequest,
  type TreeSortKeysRequest,
} from '../../shared/components/json-tree/json-tree.component';
import { PaneLayout, ToolbarComponent } from '../../shared/components/toolbar/toolbar.component';
import {
  ConfirmDialogComponent,
  ConfirmDialogData,
} from '../../shared/dialogs/confirm-dialog/confirm-dialog.component';
import { ClipboardBannerComponent } from './clipboard-banner/clipboard-banner.component';
import {
  ColdBootClipboardBannerComponent,
  type ColdBootClipboardChoice,
} from './cold-boot-clipboard-banner/cold-boot-clipboard-banner.component';
import { patchDecodedString, type DecodedApplyPatchResult } from './decoded-apply-patcher';
import { EditorMode } from './editor-mode';
import { ExtractJsonBannerComponent } from './extract-json-banner/extract-json-banner.component';
import type { PatchResult } from './extract-json-patcher';
import { patchExtractedValue } from './extract-json-patcher';
import { DropOverlayComponent } from './file-upload/drop-overlay.component';
import { RuleSetsToolbarComponent } from './rule-sets-toolbar/rule-sets-toolbar.component';
import {
  SaveAsBlobDialogComponent,
  type SaveAsBlobDialogData,
  type SaveAsBlobDialogResult,
} from './save-as-blob-dialog/save-as-blob-dialog.component';
import {
  patchSortKeysAtPath,
  patchSortKeysDeep,
  type SortDocumentResult,
  type SortPatchResult,
} from './sort-json-patcher';
import { StatusBarComponent } from './status-bar/status-bar.component';
import { collectStringLeaves } from './string-leaf-collector';
import { UploadErrorBannerComponent } from './upload-error-banner/upload-error-banner.component';

// SyntaxKind values inlined: jsonc-parser exports SyntaxKind as a `const enum`,
// which TypeScript cannot access under `isolatedModules`. See jsonc-parser
// main.d.ts: LineCommentTrivia=12, BlockCommentTrivia=13, EOF=17.
const SK_LINE_COMMENT = 12;
const SK_BLOCK_COMMENT = 13;
const SK_EOF = 17;

/**
 * Local-only pane visibility (issue #39). Stored in `localStorage`
 * via `paneVisibility` and combined with `layoutOrientation` to
 * derive the 4-state `paneLayout` shown in the toolbar's segmented
 * control. Kept as a separate type so a future change to the
 * persisted shape is independent of the UI surface.
 */
type PaneVisibility = 'both' | 'editor-only' | 'tree-only';
/**
 * The user-action that delivered files into the home editor. Closed-enum
 * so telemetry dimensions are queryable:
 * - `'drag'`: files dropped onto the document.
 * - `'pick'`: toolbar Upload button (`<input type="file">`).
 * - `'osLaunch'`: files delivered via the OS file-association launch
 *   (PWA `file_handlers` + `launchQueue`; Chromium-only).
 *
 * Renamed from `UploadSource` after the M-PWA plan added `'osLaunch'`:
 * the OS launch path isn't really an upload (no `<input type=file>`,
 * no drop overlay), so the type name now describes the broader
 * "anything that lands files in the editor" surface.
 */
type FileIngressSource = 'drag' | 'pick' | 'osLaunch';

type ColdBootClipboardCandidate = {
  text: string;
  sizeBytes: number;
};

type ColdBootClipboardReadRaceResult =
  | { kind: 'read'; result: ClipboardGrantedReadResult }
  | { kind: 'timeout' };

/**
 * Origin path that surfaced the current M7p extract candidate. Used as a
 * dimension on `home.extract.banner.{shown,accept,dismiss}` telemetry and
 * to gate the auto-focus-on-show behaviour (only `'paste'` auto-focuses
 * so Ctrl+V or drag-drop don't steal focus from a typing user).
 */
type ExtractSource = 'paste' | 'editor.paste' | 'upload.pick' | 'upload.drag' | 'upload.osLaunch';

/**
 * Closed-enum mapping from a `FileIngressSource` (user action that
 * delivered the files) to the `ExtractSource` dimension carried on the
 * three `home.extract.banner.{shown,accept,dismiss}` telemetry events.
 * Replaces the previous `source === 'pick' ? 'upload.pick' : 'upload.drag'`
 * ternaries that silently mis-bucketed the new `'osLaunch'` value as
 * `'upload.drag'` (advocate A1 in the M-PWA plan).
 */
const FILE_INGRESS_TO_EXTRACT_SOURCE: Readonly<Record<FileIngressSource, ExtractSource>> = {
  drag: 'upload.drag',
  pick: 'upload.pick',
  osLaunch: 'upload.osLaunch',
};

/**
 * Closed-enum label for the `trigger` prop on `home.upload.undo`
 * telemetry. Declared as its own type (rather than a passthrough of
 * `FileIngressSource`) so the next `FileIngressSource` widen forces a
 * compile-time decision at `FILE_INGRESS_TO_UNDO_TRIGGER` below
 * rather than silently widening the documented closed-enum on
 * `home.upload.undo.trigger` via `pending.uploadTrigger`. Mirrors the
 * boundary discipline already established by
 * `FILE_INGRESS_TO_EXTRACT_SOURCE` (six lines above) for
 * `home.extract.banner.*.pasteSource`.
 */
type UploadTriggerLabel = 'drag' | 'pick' | 'osLaunch';

/**
 * Closed-enum mapping from a `FileIngressSource` (user action that
 * delivered the files) to the `trigger` prop on `home.upload.undo`
 * telemetry. Identity-mapped today; the indirection exists so the
 * next `FileIngressSource` addition (e.g., a future Web Share Target
 * ingress) fails to compile here rather than silently flowing through
 * `pending.uploadTrigger` into the telemetry event. Mirrors
 * `FILE_INGRESS_TO_EXTRACT_SOURCE` above.
 */
const FILE_INGRESS_TO_UNDO_TRIGGER: Readonly<Record<FileIngressSource, UploadTriggerLabel>> = {
  drag: 'drag',
  pick: 'pick',
  osLaunch: 'osLaunch',
};

type SignInRestoreSnapshot = {
  slug: string | null;
  content: string;
  title: string;
};

/**
 * Wider closed-enum for `file.save.failed` telemetry, covering both
 * `FileAccessError.kind` causes (from save attempts) AND the
 * upload-validator-rejected adoption causes (`'tooLarge'`, `'binary'`).
 * Used by `HomeComponent.openFileSaveFailureSnackbar`.
 */
type FileSaveFailureCause = FileAccessFailureCause | 'tooLarge' | 'binary';

const SIGN_IN_RESTORE_KEY = 'jotjson.signInRestore.v1';

const TREE_EXTRACT_SCAN_DEBOUNCE_MS = 1000;
const COLD_BOOT_CLIPBOARD_TIMEOUT_MS = 150;
const COLD_BOOT_CLIPBOARD_MAX_BYTES = 1 * 1024 * 1024;

/**
 * Discriminator for `pendingReplaceUndo`. Every wholesale-replacement
 * surface that wants a snackbar Undo + Ctrl+Z gate routes through the
 * shared `installPendingReplace` / `openReplaceUndoSnack` helpers; the
 * `kind` tag drives the per-kind branches in `emitUndoTelemetry` and
 * `restoreSideStateFromPending`.
 *
 * `coldBoot` is reserved for a future consolidation of the cold-boot
 * clipboard snackbar into the same coordinator; it is not used today.
 */
type ReplaceUndoKind =
  | 'upload'
  | 'format'
  | 'minify'
  | 'sort.toolbar'
  | 'sort.tree'
  | 'extract.banner'
  | 'extract.tree'
  | 'decoded.apply'
  | 'coldBoot';

/**
 * Closed-enum reason for `home.<surface>.applyFailed` telemetry. Maps
 * 1:1 onto `ReplaceAllResult`'s failure outcomes plus the
 * editor-not-mounted case detected before `replaceAll` is reached:
 * - `'editorNotReady'`: `editor()` signal returned null (component
 *   not mounted yet).
 * - `'modelNull'`: `replaceAll` returned `'modelNull'` (Monaco or
 *   the underlying model is unavailable despite the wrapper being
 *   mounted).
 * - `'editsRejected'`: `replaceAll` returned `'editsRejected'`
 *   (Monaco's `executeEdits` reported the edit did not apply).
 * Not emitted on the no-op path (`replaceAll` returns `'noOp'`).
 */
type ReplaceApplyFailedReason = 'editorNotReady' | 'modelNull' | 'editsRejected';

/**
 * The shape of the `extractedCandidate` signal payload. Extracted so
 * `PendingReplaceUndoUploadExtras` can snapshot the pre-upload value
 * for restoration on undo.
 */
type ExtractedCandidate = {
  data: ExtractedJson;
  sourceVersion: number;
  source: ExtractSource;
};

/**
 * Distributive variant of `Omit`: when `T` is a union, applies `Omit`
 * to each variant individually so the discriminator is preserved.
 * Without this, `Omit<A | B, K>` collapses to a structural Omit that
 * loses per-variant non-shared properties, which makes object literals
 * narrowed by a `kind` discriminator fail excess-property checks.
 *
 * Used by `installPendingReplace` to accept a per-variant object that
 * the helper then merges with the auto-captured `priorBacking`.
 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * Fields shared by every `pendingReplaceUndo` kind. The `kind`
 * discriminator narrows to the appropriate extras union member when
 * accessing per-surface fields.
 */
type PendingReplaceUndoBase = {
  priorText: string;
  /**
   * Snapshot of the document backing at install time. Restored by
   * `restoreSideStateFromPending` on either snackbar Undo or Ctrl+Z so
   * a wholesale replacement that flipped the backing (e.g., osLaunch
   * adoption replacing a blob-loaded document) is fully reversible.
   *
   * Captured automatically inside `installPendingReplace` so per-kind
   * call sites don't need to know about it. Restoring this restores
   * the file-handle binding for file-backed documents, the blob
   * identity + savedSnapshot for blob-loaded documents, or the
   * draft-no-target state.
   */
  priorBacking: DocumentBacking;
  startMs: number;
  undoneViaSnackbar: boolean;
  /**
   * Phantom-undo gate. Surfaces that bump `viewResetToken` at install
   * time capture the post-bump value so the constructor effect can
   * distinguish a Monaco Ctrl+Z (token unchanged) from a user re-
   * pasting / re-uploading the same `priorText` (token bumped again).
   * `extract.tree` doesn't bump the token, so the gate is a no-op for
   * that kind (matched on the discriminator in the effect).
   */
  viewResetTokenAtAccept: number;
};

type PendingReplaceUndoUploadExtras = {
  kind: 'upload';
  /** Source filename at install time, restored on undo. */
  priorLastFilename: string | null;
  priorHighlights: readonly BlobHighlight[];
  priorMutatedPaths: ReadonlySet<string>;
  priorSuggestedTitles: readonly SuggestionCandidate[];
  priorExtractedCandidate: ExtractedCandidate | null;
  priorUploadError: { filename: string } | null;
  /** Whether the upload originated from the file-picker, a drag-drop, or an OS launch. */
  uploadTrigger: UploadTriggerLabel;
};

type PendingReplaceUndoFormatExtras = {
  kind: 'format';
};

type PendingReplaceUndoMinifyExtras = {
  kind: 'minify';
  /** Editor mode at install time. Minify always flips to 'json'. */
  priorMode: EditorMode;
};

type PendingReplaceUndoSortToolbarExtras = {
  kind: 'sort.toolbar';
  /**
   * Editor mode at install time. Sort uses the byte-splice patcher
   * which preserves comments, so post-Sort mode is auto-derived by
   * the detectMode effect from the patched content: a JSONC document
   * whose comments survive Sort stays in JSONC mode; a plain-JSON
   * document stays in 'json'. We still snapshot the prior mode so
   * Undo restores the exact mode that was in effect before Sort.
   */
  priorMode: EditorMode;
};

type PendingReplaceUndoSortTreeExtras = {
  kind: 'sort.tree';
};

type PendingReplaceUndoExtractBannerExtras = {
  kind: 'extract.banner';
  pasteSource: ExtractSource | null;
  /**
   * Banner-only snapshots: `resetHighlightsForDocumentReplacement`
   * moves highlights into `mutatedPaths` on accept, so the user
   * would lose their highlights permanently after undo. Capture
   * both pre-accept signals so undo can restore them.
   */
  highlightsSnapshot: readonly BlobHighlight[];
  mutatedPathsAtAccept: ReadonlySet<string>;
};

type PendingReplaceUndoExtractTreeExtras = {
  kind: 'extract.tree';
};

/**
 * Side-state-free Pending extras for the decoded-Apply mutation. No
 * `priorMode` (decoded.apply doesn't switch editor modes), no
 * pre-extract candidate (decoded.apply is a surgical splice that
 * doesn't disturb the extract banner), no highlights / mutatedPaths
 * snapshot (the splice preserves those by construction since the
 * patcher's `applyEdits` operates on a single string literal whose
 * path identity in the tree is stable across the edit). Mirrors
 * `PendingReplaceUndoExtractTreeExtras` exactly.
 */
type PendingReplaceUndoDecodedApplyExtras = {
  kind: 'decoded.apply';
};

type PendingReplaceUndoColdBootExtras = {
  kind: 'coldBoot';
};

/**
 * Wall-clock cap on `pendingReplaceUndo` retention. After this window,
 * the captured `priorText` snapshot is released regardless of user
 * activity, so a user who extracts and then walks away from the tab
 * cannot hold an arbitrarily large snapshot in memory indefinitely.
 * Reverts past this window (background-tab throttling, etc.) collapse
 * into the `'5s+'` `bucketUndoLatency` bucket.
 */
const REPLACE_UNDO_CAP_MS = 30_000;

/**
 * Tree-pane debounce window. Live consumers (errors, dirty, status
 * bar, Format/Minify, search) continue to update on every keystroke
 * by reading `parseResult()` directly; the tree pane reads the
 * debounced `treePaneInputs` signal instead, which collapses bursts
 * of keystrokes into one `buildTree` invocation per ~150 ms of idle.
 *
 * Discrete user actions (Clear, sign-in restore, delete-blob,
 * Extract Accept) call `treeFlush$.next()` to bypass the timer and
 * push the latest parse to the tree in the same CD tick.
 */
export const EDITOR_COMMIT_DEBOUNCE_MS = 150;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isSignInRestoreSnapshot = (value: unknown): value is SignInRestoreSnapshot => {
  if (!isRecord(value)) return false;
  const slug = value['slug'];
  return (
    (slug === null || typeof slug === 'string') &&
    typeof value['content'] === 'string' &&
    typeof value['title'] === 'string'
  );
};

function sameHighlightEntry(
  leftHighlight: BlobHighlight | undefined,
  rightHighlight: BlobHighlight | undefined,
): boolean {
  if (leftHighlight === undefined || rightHighlight === undefined) {
    return leftHighlight === rightHighlight;
  }
  return (
    leftHighlight.path === rightHighlight.path &&
    leftHighlight.color === rightHighlight.color &&
    leftHighlight.cascade === rightHighlight.cascade
  );
}

/**
 * Primary editor + tree experience. Home is an anonymous page - persistence
 * goes to localStorage via DraftService (spec §Features #1 / §Milestones #2).
 */
@Component({
  selector: 'app-home',
  standalone: true,
  imports: [
    AppHeaderComponent,
    JsonEditorComponent,
    JsonTreeComponent,
    ToolbarComponent,
    StatusBarComponent,
    ClipboardBannerComponent,
    ColdBootClipboardBannerComponent,
    RuleSetsToolbarComponent,
    DropOverlayComponent,
    ExtractJsonBannerComponent,
    UploadErrorBannerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent implements OnInit, OnDestroy {
  private readonly destroyRef = inject(DestroyRef);
  private readonly draft = inject(DraftService);
  private readonly prefs = inject(PreferencesService);
  private readonly parser = inject(JsonParserService);
  private readonly extractor = inject(JsonExtractorService);
  readonly treeStringExtractor = inject(TreeStringExtractorService);
  private readonly titleSuggester = inject(TitleSuggesterService);
  private readonly auth = inject(AuthService);
  private readonly blobs = inject(BlobService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly titleService = inject(Title);
  private readonly envLabel = inject(EnvLabelService);
  private readonly seo = inject(SeoService);
  private readonly quota = inject(QuotaNotificationService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  private readonly clipboard = inject(ClipboardPollingService);
  private readonly clipboardCopy = inject(ClipboardCopyService);
  private readonly logger = inject(LoggerService);
  private readonly dropController = inject(DocumentDropController);
  private readonly launchQueueController = inject(LaunchQueueController);
  private readonly fileAccess = inject(FileAccessService);
  private readonly beaconNav = inject(BeaconNavigationService);
  private readonly loadingSplash = inject(LoadingSplashService);
  protected readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Mirrors the controller's drag-active signal for the drop overlay. */
  readonly dropActive = this.dropController.dropActive;

  private disposeDropHandler?: () => void;
  private disposeLaunchHandler?: () => void;
  private destroyed = false;
  private coldBootClipboardEvaluated = false;
  private coldBootClipboardCandidate: ColdBootClipboardCandidate | null = null;
  /**
   * Retained reference to the snackbar opened by the cold-boot auto-paste
   * silent / banner-paste paths. Held so an unrelated snackbar opening
   * later cannot squelch the only undo affordance for the silent path.
   * Cleared on dismiss.
   */
  private coldBootClipboardSnackRef: MatSnackBarRef<TextOnlySnackBar> | null = null;
  private replaceUndoSnackRef: MatSnackBarRef<TextOnlySnackBar> | null = null;
  /**
   * Kind tag for the currently-visible Replace Undo snackbar. Set
   * atomically with `replaceUndoSnackRef` and cleared on dismiss.
   * Used to populate `from` / `to` on `home.replaceUndo.snackbarReplaced`
   * (and the legacy `tree.extract.snackbarReplaced` dual-emit for
   * extract-only pairs) when a new replacement supersedes a still-
   * visible snackbar.
   */
  private replaceUndoSnackKind: ReplaceUndoKind | null = null;
  /**
   * Single discriminated-union pending snapshot for ALL wholesale-
   * replacement surfaces that opt into snackbar Undo + Ctrl+Z. The
   * shared base fields cover the gate logic; the kind-specific union
   * branches carry the side-state each surface needs to restore on
   * undo. See `ReplaceUndoKind` for the discriminator.
   */
  private pendingReplaceUndo:
    | (PendingReplaceUndoBase & PendingReplaceUndoUploadExtras)
    | (PendingReplaceUndoBase & PendingReplaceUndoFormatExtras)
    | (PendingReplaceUndoBase & PendingReplaceUndoMinifyExtras)
    | (PendingReplaceUndoBase & PendingReplaceUndoSortToolbarExtras)
    | (PendingReplaceUndoBase & PendingReplaceUndoSortTreeExtras)
    | (PendingReplaceUndoBase & PendingReplaceUndoExtractBannerExtras)
    | (PendingReplaceUndoBase & PendingReplaceUndoExtractTreeExtras)
    | (PendingReplaceUndoBase & PendingReplaceUndoDecodedApplyExtras)
    | (PendingReplaceUndoBase & PendingReplaceUndoColdBootExtras)
    | null = null;
  // Single owner of the 30s `pendingReplaceUndo` cap. Cleared atomically
  // with `pendingReplaceUndo` via `clearPendingReplaceUndo()`; never null
  // it directly. Background-tab throttling can delay the callback past
  // 30s -- the helper is idempotent so a late firing after a manual
  // clear is a safe no-op.
  private pendingReplaceUndoTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Blob hydrated by the /s/:slug resolver. When present, the editor starts
   * from this blob's content and the title field reflects its title.
   */
  readonly initialBlob = input<JsonBlob | undefined>(undefined);

  readonly content = signal(this.draft.content());
  readonly mode = signal<EditorMode>(this.detectMode(this.draft.content()));
  readonly cursor = signal<{ line: number; column: number } | undefined>(undefined);

  /**
   * M7p extract-from-mixed-text. Holds the most recent extractor result
   * paired with the contentVersion at the time it was produced and the
   * source path that surfaced it (used as a telemetry dimension on
   * `home.extract.banner.{shown,accept,dismiss}`). The banner predicate
   * (`extractBannerVisible`) compares `sourceVersion` to the current
   * version so any subsequent content mutation auto-hides the banner
   * without needing an effect.
   */
  readonly extractedCandidate = signal<ExtractedCandidate | null>(null);
  private readonly contentVersion = signal(0);
  private readonly viewResetToken = signal(0);
  readonly viewResetTokenValue = this.viewResetToken.asReadonly();
  readonly extractBannerVisible = computed(() => {
    const cand = this.extractedCandidate();
    return cand !== null && cand.sourceVersion === this.contentVersion();
  });
  private readonly coldBootBannerVisibleSignal = signal(false);
  readonly coldBootClipboardBannerVisible = this.coldBootBannerVisibleSignal.asReadonly();

  /**
   * Persistent in-pane banner state for upload-source validation errors
   * (issue #36, spec §294). Set in `onFilesReceived` when an upload's text
   * parses with errors; cleared on dismiss, on subsequent valid upload, or
   * inside `setContent` once content reaches empty / clean state via typing.
   * Distinct from the inline editor errors (§795) so the user can tell the
   * failure came from their upload rather than ordinary typing.
   */
  readonly uploadError = signal<{ filename: string } | null>(null);
  readonly uploadErrorVisible = computed(() => this.uploadError() !== null);
  readonly uploadErrorFilename = computed(() => this.uploadError()?.filename ?? '');

  /**
   * Single funnel for every content mutation in HomeComponent. Bumps
   * `contentVersion` so the M7p extract banner predicate auto-invalidates
   * when content changes for any reason (typing, paste, format, hydrate,
   * upload, clear, ...).
   */
  private setContent(text: string): void {
    // M7p banner-visible -> banner-gone via content change. Emit
    // `home.extract.banner.dismiss` with `reason='content.changed'`
    // BEFORE bumping contentVersion (so the predicate still recognises
    // the candidate as visible). The candidate is then cleared so the
    // accept-then-setContent path in `onExtractAccept` does not double
    // count - that handler clears the candidate itself before calling
    // here.
    const previousCandidate = this.extractedCandidate();
    if (previousCandidate !== null && previousCandidate.sourceVersion === this.contentVersion()) {
      this.logger.event(
        'home.extract.banner.dismiss',
        {
          source: previousCandidate.source,
          reason: 'content.changed',
        },
        {
          blockCount: previousCandidate.data.blockCount,
          proseSegments: previousCandidate.data.proseSegments ?? 0,
        },
      );
      this.extractedCandidate.set(null);
    }
    this.content.set(text);
    this.contentVersion.update((v) => v + 1);
    // Tree<->editor selection sync (issue #42): clear any in-flight
    // round-trip sentinels. Content reparse can clear the tree's
    // selectedPath asynchronously, leaving a stale `pendingTreeApply`
    // that would suppress the user's next click on the same path.
    this.pendingEditorReveal = undefined;
    this.pendingTreeApply = undefined;
    // Issue #266: cancel any in-flight editor-cursor-driven defer
    // in the tree. Content has changed; any pending selection
    // request was computed against the prior content and is now
    // stale. We DO NOT clear `selectedPath` here -- the tree's
    // own preserve-or-clear effect handles that on the next
    // `value()` flush so the visible selection survives a same-
    // document edit (and gracefully clears on full document
    // replace via `viewResetToken`).
    this.tree()?.clearPendingSelectPath();
    // Auto-clear the upload-source banner once content reaches empty or
    // parses cleanly. Reading parseResult() shares its memoized parse with
    // the editor's render path, so this does not add an extra parse.
    // The banner stays set when the user is mid-edit on a still-invalid
    // upload, satisfying issue #36's "does not trigger for later typing"
    // (typing typos do not re-arm the banner; they only clear it on
    // success).
    if (this.uploadError() !== null) {
      const result = this.parseResult();
      if (result.empty || result.errors.length === 0) {
        this.uploadError.set(null);
      }
    }
  }

  /**
   * Replace the editor's document with `text` and signal the tree to re-arm
   * its initial-expansion gate so it re-fits to the new content. Use this for
   * discrete content-replacement actions (paste, blob load, URL-decode,
   * extract-banner accept, file upload). Typing and reformat use `setContent`
   * directly.
   */
  private replaceDocument(text: string, newBacking?: DocumentBacking): void {
    this.setContent(text);
    if (newBacking !== undefined) {
      this._documentBacking.set(newBacking);
    }
    // Bypass the 150 ms tree-pane debounce: a full-document swap is
    // a discrete action and should be visible to the user in the
    // same CD tick as the editor.
    this.treeFlush$.next();
    this.viewResetToken.update((token) => token + 1);
  }

  /**
   * Single funnel for installing or clearing the M7p extract candidate.
   * Emits `home.extract.banner.dismiss(content.changed)` for any
   * previously-visible candidate it replaces, then writes the new value
   * and emits `home.extract.banner.shown` for non-null installs. Also
   * conditionally moves keyboard focus to the banner's Extract button
   * when `source === 'paste'`.
   */
  private replaceExtractedCandidate(
    data: ExtractedJson | null,
    source: ExtractSource | null,
  ): void {
    const previousCandidate = this.extractedCandidate();
    const wasVisible =
      previousCandidate !== null && previousCandidate.sourceVersion === this.contentVersion();
    if (wasVisible) {
      this.logger.event(
        'home.extract.banner.dismiss',
        {
          source: previousCandidate.source,
          reason: 'content.changed',
        },
        {
          blockCount: previousCandidate.data.blockCount,
          proseSegments: previousCandidate.data.proseSegments ?? 0,
        },
      );
    }
    if (data === null || source === null) {
      this.extractedCandidate.set(null);
      return;
    }
    this.extractedCandidate.set({
      data,
      sourceVersion: this.contentVersion(),
      source,
    });
    this.logger.event(
      'home.extract.banner.shown',
      { source },
      {
        blockCount: data.blockCount,
        preservesComments: data.preservesComments ? 1 : 0,
        hasComments: data.hasComments ? 1 : 0,
        proseSegments: data.proseSegments ?? 0,
      },
    );
    // Conditional auto-focus: only when the user clicked the toolbar
    // Paste button. Other surfaces (Ctrl+V, file upload, drag-drop)
    // intentionally do not steal focus from a typist mid-edit. Defer
    // by a microtask so the banner has a chance to render before
    // `focusExtractButton()` runs.
    if (source === 'paste') {
      queueMicrotask(() => this.bannerRef()?.focusExtractButton());
    }
  }

  /**
   * Single source of truth for the editor document's persistence target.
   * One of `'draft'` (no target), `'blob'` (a saved server blob is
   * loaded), or `'file'` (a writable `FileSystemFileHandle` is bound).
   * See `core/upload/document-backing.ts` for the union shape and
   * helpers.
   *
   * Setters in this component must mutate this signal directly OR pass
   * a backing argument to {@link replaceDocument}. The convenience
   * `loadedBlob` computed below preserves the legacy reader contract
   * for callers that only care about the blob variant; new call sites
   * should switch on `_documentBacking().kind` for exhaustiveness.
   */
  private readonly _documentBacking = signal<DocumentBacking>(DRAFT_BACKING);

  /**
   * The currently-loaded server blob, if any. `null` when the document
   * is an anonymous draft or backed by a local file. Computed alias over
   * `_documentBacking` so the underlying union remains the single source
   * of truth.
   */
  readonly loadedBlob = computed<JsonBlob | null>(() => {
    const backing = this._documentBacking();
    return backing.kind === 'blob' ? backing.blob : null;
  });

  readonly title = signal<string>('');
  readonly highlights = signal<readonly BlobHighlight[]>([]);
  readonly saveInFlight = signal<boolean>(false);
  readonly saveError = signal<string | null>(null);

  private readonly mutatedPaths = signal<Set<string>>(new Set<string>());

  /**
   * Tracks the most recent file name that populated the editor (M7p).
   * Set in `onFilesReceived` (covers both upload-picker and drag-drop)
   * and used by the title-suggester's `filename` strategy.
   *
   * Cleared when the document is replaced through any non-file path:
   * paste, manual `clear`, blob load (route nav to /s/:slug), blob
   * delete, sign-in restore. A second drag-drop overwrites it with the
   * new file's name.
   *
   * Format / minify / title-edit do NOT clear it -- those keep the
   * "current document started as <foo>.json" association.
   */
  readonly lastFilename = signal<string | null>(null);

  /**
   * Title-suggester result list (M7p). Populated lazily by
   * `onSuggestRequested` when the user clicks the wand button. The
   * mat-menu reads from here. Empty by default and reset whenever
   * `lastFilename` is cleared so a stale list doesn't outlive its
   * context.
   */
  readonly suggestedTitlesForMenu = signal<readonly SuggestionCandidate[]>([]);

  /**
   * Tracks the id of the blob whose content we've most recently hydrated
   * the editor from. Used by the hydration effect to avoid re-hydrating
   * from an input that hasn't changed (even if the effect re-runs for
   * unrelated reasons).
   */
  private lastHydratedInputId: string | null = null;
  private signInRestoreAttempted = false;
  /**
   * Tracks the last `editorTabSize` observed by the issue #253 effect so
   * the first synchronous read during construction is treated as the
   * baseline rather than a change. Subsequent flips re-format the
   * extract banner preview in place.
   */
  private lastObservedExtractorTabSize: IndentSize | null = null;

  readonly parseResult = computed<JsonParseResult>(() => this.parser.parse(this.content()));

  readonly errors = computed(() => this.parseResult().errors);

  readonly treeValue = computed<unknown>(() => {
    const result = this.parseResult();
    return result.empty ? undefined : result.value;
  });

  private readonly treeValueChanges$ = toObservable(this.treeValue);

  /**
   * Discrete-action flush trigger for the tree-pane pipeline.
   * Calling `treeFlush$.next()` pushes the latest `parseResult` to
   * `treePaneInputs` synchronously, bypassing the 150 ms typing
   * debounce. Used by `replaceDocument` (full-doc swap) and
   * `onExtractRequest` (so `expandNodeAtPath` operates on the
   * freshly-flushed tree).
   *
   * Pattern matches `rule-editor.component.ts`'s `retryTrigger$` -
   * AGENTS.md s4's "RxJS only at I/O boundaries (HTTP, routing,
   * events)" carve-out covers this Subject-as-event-trigger usage.
   */
  private readonly treeFlush$ = new Subject<void>();

  /**
   * TODO(perf-debounce-extract): if a second consumer of the
   * debounced parseResult appears, lift this IIFE to a sibling
   * factory and inject the resulting Observable. Today only the
   * tree pane consumes it.
   */
  private readonly treePaneSource$ = (() => {
    if (!this.isBrowser) {
      // SSR/prerender path: emit the live parseResult once, no
      // debounce machinery. The `toSignal` bridge below sees a
      // single emission and stabilises immediately, so
      // ApplicationRef stability is not delayed.
      //
      // Note: `treePaneInputs` is never read during SSR because
      // `home.component.html` wraps `<jj-json-tree>` (the only
      // consumer) in `@if (isBrowser)` per AGENTS.md s4 prerender
      // constraints. The single emission here is purely defensive
      // to keep the signal type non-`undefined`; downstream readers
      // observe nothing during prerender.
      return of(this.parseResult());
    }
    const parseResult$ = toObservable(this.parseResult);

    // Single source for parseResult-derived updates. The inline
    // empty-toggle vs debounce decision lives inside switchMap so
    // a typing keystroke arriving with a pending timer naturally
    // cancels and replaces the timer (switchMap auto-cancels the
    // prior inner observable on each new emission).
    const parseResultPath$ = parseResult$.pipe(
      startWith(this.parseResult()),
      pairwise(),
      switchMap(([previous, next]) =>
        previous.empty !== next.empty
          ? of(next)
          : timer(EDITOR_COMMIT_DEBOUNCE_MS).pipe(map(() => next)),
      ),
    );

    // Discrete-action flush source. Reads `this.parseResult()`
    // imperatively because we need the value AT FLUSH TIME, not
    // whenever `parseResult$` happens to emit next - `toObservable`
    // emits via an effect that fires on the next CD pass, so
    // `withLatestFrom(parseResult$)` would deliver the previous
    // value to a flush that fires between a signal write and the
    // CD pass. Discrete flushes must NEVER be cancelled by a
    // subsequent typing keystroke, so they live as a separate merge
    // source rather than feeding into the switchMap above.
    //
    // Phase 4 lock-in surface: this assumes `parseResult` is a
    // synchronous computed signal. If Phase 4 ever moves parsing to
    // a worker, this map() must change to await the async result
    // (or the discrete-flush semantics must be re-thought).
    const discretePath$ = this.treeFlush$.pipe(map(() => this.parseResult()));

    return merge(parseResultPath$, discretePath$);
  })();

  /**
   * Debounced projection of `parseResult` consumed by the tree pane.
   * Live consumers (errors, dirty, status bar, search, Format/Minify)
   * continue to read `parseResult()` directly so they update on every
   * keystroke. Only the tree pane sees the 150 ms-debounced view.
   */
  readonly treePaneInputs = toSignal(
    this.treePaneSource$.pipe(
      map((result) => ({
        value: result.empty ? undefined : result.value,
        commentsByPath: result.commentsByPath,
      })),
    ),
    {
      // Seed from the live parseResult at construction time so a
      // hydrated draft renders synchronously on first paint.
      // Without this seed, `pairwise` in `parseResultPath$` would
      // absorb both the `startWith` emission and the bridging
      // effect's first emission (both equal V0), the switchMap
      // would take the timer branch (same `.empty`), and the tree
      // pane would stay blank for ~150 ms before showing the draft.
      // The pipeline's first downstream emission is the timer's,
      // not `startWith`'s; the seed is the only thing the tree
      // pane sees before then.
      initialValue: {
        value: this.parseResult().empty ? (undefined as unknown) : this.parseResult().value,
        commentsByPath: this.parseResult().commentsByPath,
      },
    },
  );

  readonly layoutOrientation = computed(() => this.prefs.prefs().layoutOrientation);

  readonly hasContent = computed(() => this.content().trim().length > 0);

  readonly dirty = computed(() => {
    const backing = this._documentBacking();
    const snapshot = getSavedSnapshot(backing);
    if (snapshot === null) {
      return this.content().length > 0 || this.title().length > 0 || this.highlights().length > 0;
    }
    if (backing.kind === 'file') {
      // File-backed dirty is content-only by design: highlights and
      // title edits do NOT flip the pill or trigger Save writes
      // because the on-disk JSON file has no representation for them
      // (highlights live only in-session for a file-backed doc;
      // titles are deferred to a future blob save). See
      // `core/upload/document-backing.ts` for the full rationale.
      return this.content() !== snapshot.content;
    }
    return (
      this.content() !== snapshot.content ||
      this.title() !== snapshot.title ||
      !highlightsEqual(this.highlights(), snapshot.highlights)
    );
  });

  readonly isOwnedBlob = computed(() => {
    const blob = this.loadedBlob();
    if (!blob) return false;
    const user = this.auth.user();
    return !!user && user.id === blob.ownerId;
  });

  /**
   * True when the document is bound to a local file via the
   * M-PWA-write-back flow (`DocumentBacking` kind === 'file').
   * Drives the toolbar's file-backed pill state, lifted Save block
   * for anonymous users, and overflow menu items.
   */
  readonly isFileBacked = computed(() => this._documentBacking().kind === 'file');

  /**
   * Filename of the bound local file, or `null` when the document is
   * not file-backed. Passed to the toolbar for the Save tooltip and
   * to the SaveAsBlobDialog as a suggested-name seed.
   */
  readonly fileBackedFilename = computed<string | null>(() => {
    const backing = this._documentBacking();
    return backing.kind === 'file' ? backing.filename : null;
  });

  readonly canEditHighlights = computed(() => this.loadedBlob() === null || this.isOwnedBlob());

  /**
   * Beacon index from the live tree component. Returns the
   * identity-shared `EMPTY_BEACON_INDEX` when the tree has not yet
   * mounted. Passed through to the toolbar so the beacon-pills
   * sub-component can render one pill per icon-bucket.
   */
  readonly treeBeaconIndex = computed<BeaconIndex>(() => {
    const tree = this.tree();
    if (!tree) return EMPTY_BEACON_INDEX;
    return tree.beaconIndex();
  });

  readonly canSave = computed(() => {
    if (!this.hasContent()) return false;
    const backing = this._documentBacking();
    if (backing.kind === 'file') {
      // File-backed Save needs no auth -- the write target is local
      // disk via the held FileSystemFileHandle. Gate on dirty so the
      // button doesn't fire a redundant write for an unchanged
      // document. File-backed dirty is already content-only (see
      // `dirty` computed above), so highlight or title edits do not
      // light the button up for a noop file write.
      return this.dirty();
    }
    if (!this.auth.isSignedIn()) return false;
    if (backing.kind === 'draft') return true;
    // backing.kind === 'blob': either fork (unowned) or in-place
    // update (owned + dirty).
    return !this.isOwnedBlob() || this.dirty();
  });

  /**
   * Title-suggester wand-enable predicate (M7r). The wand is enabled
   * whenever the editor has non-empty content. Picking a candidate from
   * the menu replaces whatever is currently in the title input -- the
   * user explicitly asked for a suggestion by clicking, and an explicit
   * click is treated as a deliberate write (same precedent as
   * autocomplete dropdowns).
   *
   * The synthetic-floor in `TitleSuggesterService` guarantees >=2
   * candidates from any non-empty content, so we don't peek at the
   * candidate count to decide enable/disable.
   */
  readonly wandEnabled = computed(() => this.hasContent());

  readonly clipboardState = computed<'enabled-json' | 'enabled-empty' | 'denied' | 'fallback'>(
    () => {
      const state = this.clipboard.permissionState();
      if (state === 'denied') return 'denied';
      if (state === 'granted') {
        return this.clipboard.hasJson() ? 'enabled-json' : 'enabled-empty';
      }
      return 'fallback';
    },
  );

  readonly clipboardPreview = computed(() => this.clipboard.preview());

  private readonly homepageTitle = $localize`:@@app.title.homepage:JotJSON - JSON viewer, formatter, and tree explorer`;

  readonly splitRatio = persistedSignal<number>({
    key: 'jotjson.splitRatio.v1',
    defaultValue: 0.5,
    parse: (raw) => {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return 0.5;
      return Math.min(0.9, Math.max(0.1, parsed));
    },
    serialize: (n) => String(n),
  });

  /**
   * 3-state pane visibility (issue #39, refined in the #39 follow-up).
   * Local-only via `localStorage` (parallel to `splitRatio`); intentionally
   * not synced via user preferences. Combined with `layoutOrientation`
   * (which IS roamed) by `paneLayout` below to produce the 4-state value
   * shown in the toolbar's segmented control.
   *
   * When the user picks one of the `both-*` segments after being in
   * single-pane mode, the persisted `splitRatio` (which was untouched
   * while one pane was hidden) is automatically restored, so users get
   * back the layout they had before collapsing.
   */
  readonly paneVisibility = persistedSignal<PaneVisibility>({
    key: 'jotjson.paneVisibility.v1',
    defaultValue: 'both',
    parse: (raw) => (raw === 'editor-only' || raw === 'tree-only' ? raw : 'both'),
    serialize: (value) => value,
  });

  /**
   * `true` when the viewport is narrow per the M7l breakpoint
   * (< 768px). Drives `effectivePaneVisibility` below; the persisted
   * `paneVisibility` is never mutated by this signal.
   */
  readonly narrowViewport = createNarrowViewportSignal();

  /**
   * Effective (rendered) pane visibility (M7l). At narrow widths the
   * `'both'` state collapses to `'tree-only'` so the user sees the
   * tree (the primary value at small sizes per AGENTS.md). Persisted
   * single-pane choices are honored unchanged. The persisted
   * `paneVisibility` is never mutated; widening the viewport restores
   * the original choice. All behavior consumers (paneLayout,
   * splitStyle, beacon dispatch, Ctrl+F routing, template class
   * bindings) read this signal rather than `paneVisibility` directly.
   */
  readonly effectivePaneVisibility = computed<PaneVisibility>(() => {
    const persisted = this.paneVisibility();
    if (this.narrowViewport() && persisted === 'both') return 'tree-only';
    return persisted;
  });

  /**
   * 4-state derived view of `effectivePaneVisibility` +
   * `layoutOrientation`, matching the segments of the toolbar's
   * pane-layout segmented control. Single-pane states ignore the
   * orientation pref - it is preserved untouched and re-applied when
   * the user picks a `both-*` segment again. Deriving from the
   * effective (not persisted) visibility ensures the highlighted
   * segment is always one of the visible segments at narrow widths
   * where the `both-*` segments are CSS-hidden.
   */
  readonly paneLayout = computed<PaneLayout>(() => {
    const visibility = this.effectivePaneVisibility();
    if (visibility === 'editor-only') return 'editor-only';
    if (visibility === 'tree-only') return 'tree-only';
    return this.layoutOrientation() === 'vertical' ? 'both-vertical' : 'both-horizontal';
  });

  readonly splitStyle = computed(() => {
    const visibility = this.effectivePaneVisibility();
    const orientation = this.layoutOrientation();
    if (visibility !== 'both') {
      return orientation === 'vertical'
        ? { 'grid-template-rows': '1fr' }
        : { 'grid-template-columns': '1fr' };
    }
    const ratio = this.splitRatio();
    const leftPct = `${(ratio * 100).toFixed(3)}%`;
    const rightPct = `${((1 - ratio) * 100).toFixed(3)}%`;
    return orientation === 'vertical'
      ? { 'grid-template-rows': `${leftPct} var(--splitter-size) ${rightPct}` }
      : { 'grid-template-columns': `${leftPct} var(--splitter-size) ${rightPct}` };
  });

  private readonly splitHost = viewChild<ElementRef<HTMLElement>>('splitHost');

  private readonly homeFocusFallback = viewChild<ElementRef<HTMLElement>>('homeFocusFallback');

  private readonly treeHost = viewChild<ElementRef<HTMLElement>>('treeHost');

  private readonly tree = viewChild(JsonTreeComponent);
  private readonly editor = viewChild(JsonEditorComponent);
  /**
   * View reference to the M7p extract banner. Used by
   * `replaceExtractedCandidate` to call `focusExtractButton()` after a
   * paste-driven banner show. Other surfaces (Ctrl+V via the editor, file
   * upload, drag-drop) intentionally do NOT auto-focus to avoid stealing
   * keyboard focus from a typing user.
   */
  private readonly bannerRef = viewChild(ExtractJsonBannerComponent);

  /**
   * Loop-suppression sentinels for tree<->editor selection sync (issue
   * #42). Each direction stores the canonical path string it just
   * pushed to the OTHER pane; when the round-trip echo arrives, we
   * recognise it as a no-op and drop it. Value-based, not flag-based,
   * so concurrent unrelated user gestures do not get squelched.
   */
  private pendingEditorReveal: string | null | undefined = undefined;
  private pendingTreeApply: string | null | undefined = undefined;
  private pendingTreeExtractTelemetry: {
    sourceVersion: number;
    stringLeaves: readonly string[];
    uniqueStringsScanned: number;
  } | null = null;

  constructor() {
    // Signal first browser paint of the JSON tree to LoadingSplashService
    // so the cold-boot "Rendering tree..." splash hides on the frame
    // *after* paint. Double-rAF mirrors `afterFirstPaint` (line 1256-1264)
    // and the JsonTreeComponent paint barrier - a single rAF runs before
    // the next paint and can clear the splash on the same tick the
    // user would have seen the label. The service guards re-entry, so
    // this is a safe no-op for in-app `/` -> `/s/:slug` navigations
    // where renderPending was never set.
    afterNextRender(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => this.loadingSplash.markBlobRenderComplete());
      });
    });

    // Persist anonymous draft edits only while no saved blob is loaded.
    effect(() => {
      if (this.loadedBlob() === null) {
        this.draft.set(this.content());
      }
    });

    // Keep mode in sync with content: jsonc if comments are present, json otherwise.
    effect(() => {
      const detected = this.detectMode(this.content());
      if (this.mode() !== detected) {
        this.mode.set(detected);
      }
    });

    // Hydrate from the resolved blob when navigating to /s/:slug. We track
    // the id of the blob we've already hydrated from in a plain instance
    // field so that re-runs of this effect (triggered by signal writes
    // inside the effect, or by any other reactive churn) never re-hydrate
    // from an already-processed input. When initialBlob becomes null/undefined
    // (e.g. onClear navigates home), we reset the guard so a future
    // /s/:slug visit can hydrate again.
    effect(() => {
      const blob = this.initialBlob();
      if (!blob) {
        this.lastHydratedInputId = null;
        return;
      }
      if (blob.id === this.lastHydratedInputId) return;
      this.lastHydratedInputId = blob.id;
      this.applyLoadedBlob(blob);
      this.lastFilename.set(null);
      this.suggestedTitlesForMenu.set([]);
      this.restoreSignInSnapshotOnce();
    });

    // Update the browser tab title whenever the loaded blob, local title, or
    // dirty state changes. Anonymous / unsaved editing falls back to the
    // homepage title.
    effect(() => {
      const backing = this._documentBacking();
      const title = this.title();
      const dirtyPrefix = this.dirty() ? '* ' : '';
      if (backing.kind === 'file') {
        // File-backed: surface the filename so multi-window PWA users
        // can distinguish their tabs at a glance. Same `* ` prefix
        // convention as the blob path. SEO: noindex because the
        // content is a local file (cannot be crawled regardless;
        // setting noindex is defensive consistency with the blob
        // branch).
        this.titleService.setTitle(
          this.envLabel.withPrefix(`${dirtyPrefix}${backing.filename} - JotJSON`),
        );
        if (this.isBrowser) {
          this.seo.setNoindex(true);
        }
        return;
      }
      const blob = backing.kind === 'blob' ? backing.blob : null;
      if (!blob) {
        this.titleService.setTitle(this.envLabel.withPrefix(`${dirtyPrefix}${this.homepageTitle}`));
        // Skip on server prerender so the static OG defaults from
        // index.html survive into the prerendered HTML. Crawlers see the
        // homepage's og:title / og:description / og:type / og:url /
        // og:site_name / twitter:card without an Angular-side wipe.
        if (this.isBrowser) {
          this.seo.setNoindex(false);
        }
        return;
      }
      const label =
        title.trim().length > 0 ? title.trim() : $localize`:@@app.title.untitled:Untitled`;
      this.titleService.setTitle(this.envLabel.withPrefix(`${dirtyPrefix}${label} | JotJSON`));
      if (this.isBrowser) {
        // All blobs are unlisted (see DESIGN_SPEC.md §Visibility) and the
        // SPA never emits per-blob Open Graph tags. Three crawler-defense
        // layers ship together in 1.3.0:
        //   1. `Disallow: /s/` in public/robots.txt
        //   2. `X-Robots-Tag: noindex` header from staticwebapp.config.json
        //      for /s/* responses
        //   3. This client-side `<meta name="robots" content="noindex">`
        //      tag for JS-executing crawlers
        this.seo.setNoindex(true);
      }
    });

    // Issue #253: when `editorTabSize` changes, re-run extraction over
    // the current content so the extract banner preview reformats with
    // the new indent. This is intentionally lightweight: it does NOT
    // emit `home.extract.banner.shown` again (the banner is already
    // shown, only its rendered text is changing) -- it patches the
    // candidate's `data` in place.
    effect(() => {
      const tabSize = this.prefs.prefs().editorTabSize;
      if (this.lastObservedExtractorTabSize === null) {
        this.lastObservedExtractorTabSize = tabSize;
        return;
      }
      if (this.lastObservedExtractorTabSize === tabSize) {
        return;
      }
      this.lastObservedExtractorTabSize = tabSize;
      const candidate = this.extractedCandidate();
      if (candidate === null || candidate.sourceVersion !== this.contentVersion()) {
        return;
      }
      const reformatted = this.extractor.extractFromMixedText(this.content(), tabSize);
      if (reformatted === null) {
        return;
      }
      this.extractedCandidate.set({
        data: reformatted,
        sourceVersion: candidate.sourceVersion,
        source: candidate.source,
      });
    });

    effect(() => {
      const currentContent = this.content();
      const pending = this.pendingReplaceUndo;
      if (!pending) {
        return;
      }
      const undoLatencyMs = performance.now() - pending.startMs;
      // Case 1: snackbar Undo already ran (the install helper's
      // `onAction` set the flag and called `replaceDocument(priorText)`);
      // the resulting content-match re-enters this effect. Telemetry was
      // emitted in the action callback; just clear the pending state.
      if (pending.undoneViaSnackbar && currentContent === pending.priorText) {
        this.clearPendingReplaceUndo();
        return;
      }
      // Phantom-undo gate (applies to every kind that bumps
      // `viewResetToken` at install time). A Monaco Ctrl+Z goes through
      // `applyEdit`/`replaceAll` -> `valueChange` -> `setContent` and
      // does NOT bump the token, while a user re-uploading or
      // re-pasting the same `priorText` goes through `replaceDocument`
      // which DOES bump the token again, so the captured
      // `viewResetTokenAtAccept` no longer matches and we bail.
      // `extract.tree` doesn't bump the token at install, so it is
      // exempt; `coldBoot` is reserved for a future folding-in (no
      // install path today).
      if (
        pending.kind !== 'extract.tree' &&
        pending.kind !== 'coldBoot' &&
        this.viewResetToken() !== pending.viewResetTokenAtAccept
      ) {
        return;
      }
      // Case 2: content reverted to priorText via some non-snackbar
      // path (Ctrl+Z is the dominant case). Fire ctrlZ telemetry,
      // restore side-state, clear pending state, and dismiss any
      // still-visible snackbar so the offer to undo disappears once
      // the undo is observable. The 30s wall-clock timer in
      // `clearPendingReplaceUndo()` is the single owner of the cap --
      // once it fires, `pendingReplaceUndo` is null and this branch
      // returns early at the top guard above.
      if (!pending.undoneViaSnackbar && currentContent === pending.priorText) {
        this.emitUndoTelemetry(pending, 'ctrlZ', undoLatencyMs);
        this.restoreSideStateFromPending(pending);
        this.clearPendingReplaceUndo();
        this.replaceUndoSnackRef?.dismiss();
        return;
      }
    });

    // The 30s `setTimeout` that backs `pendingReplaceUndoTimer` survives
    // component destruction if not cleaned up - the callback would then
    // touch a destroyed component's field and keep the instance alive
    // for the remainder of the window. Register the helper so the timer
    // (and any captured `priorText` snapshot) is released promptly on
    // teardown.
    this.destroyRef.onDestroy(() => {
      this.clearPendingReplaceUndo();
    });

    this.treeValueChanges$
      .pipe(debounceTime(TREE_EXTRACT_SCAN_DEBOUNCE_MS), takeUntilDestroyed(this.destroyRef))
      .subscribe((value) => this.scanTreeStringLeaves(value));

    // Beacon cross-pane dispatcher: a pill click (or ancestor-badge
    // click) emits a jump request through `BeaconNavigationService`.
    // We translate it into a tree expand+select OR an editor reveal
    // depending on `paneVisibility()` + `lastActivePane()`. The
    // service captures `lastActivePane` BEFORE the click handler ran,
    // so the value here reflects the user's intent rather than the
    // post-click focused element (always the pill or badge button).
    this.beaconNav.jumpRequest$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((request) => this.dispatchBeaconJump(request));

    this.blobs.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((event) => {
      const blob = this.loadedBlob();
      if (event.kind === 'conflict' && blob?.id === event.id) {
        void this.handleBlobConflict(event.blob);
      }
    });

    effect(() => {
      const scanInFlight = this.treeStringExtractor.scanInFlight();
      const sourceVersion = this.treeStringExtractor.currentVersion();
      const candidates = this.treeStringExtractor.candidates();
      if (!scanInFlight) {
        this.emitTreeExtractShownTelemetryIfPending(sourceVersion, candidates);
      }
    });

    // splitRatio is persisted via persistedSignal at the field declaration
    // above. Intentionally local-only (not part of UserPreferences / Cosmos
    // roaming): viewport-dependent, couples with layoutOrientation, transient
    // UI state, and updates on every pointermove during a drag. See
    // DESIGN_SPEC.md "UserPreferences -> Intentionally not roamed" for the
    // full rationale. If we ever roam this, it needs per-orientation (and
    // ideally per-viewport-class) storage plus a multi-second write debounce.

    // Clipboard polling (M7a): initial probe + gate polling on granted +
    // page visibility. Visibilitychange / focus listeners force a re-check
    // when the user returns to the tab, so the Paste button updates
    // promptly after an external copy.
    //
    // Skip on the server platform - the static prerender of `/` runs in
    // Node where `document` and `window` are not defined; the listeners
    // and the gating effect both reference them. The full clipboard wiring
    // re-attaches naturally once the browser bootstrap reaches this same
    // constructor.
    if (this.isBrowser) {
      this.evaluateColdBootClipboard();
      this.clipboard.checkOnce();
      const onVisibility = (): void => {
        if (document.visibilityState === 'visible') {
          this.clipboard.checkOnce();
        } else {
          this.clipboard.stopPolling();
        }
      };
      const onFocus = (): void => {
        this.clipboard.checkOnce();
      };
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('focus', onFocus);
      this.destroyRef.onDestroy(() => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('focus', onFocus);
        this.clipboard.stopPolling();
      });

      effect(() => {
        const state = this.clipboard.permissionState();
        if (state === 'granted' && document.visibilityState === 'visible') {
          this.clipboard.startPolling();
        } else {
          this.clipboard.stopPolling();
        }
      });
    }
  }

  private evaluateColdBootClipboard(): void {
    if (!this.shouldStartColdBootClipboardEvaluation()) {
      return;
    }
    this.coldBootClipboardEvaluated = true;

    const preference = this.prefs.prefs().coldBootClipboardAutoPaste;
    if (preference === 'always') {
      void this.evaluateAlwaysColdBootClipboard();
      return;
    }
    void this.evaluateAskColdBootClipboard();
  }

  private shouldStartColdBootClipboardEvaluation(): boolean {
    return (
      this.isBrowser &&
      !this.router.navigated &&
      !this.coldBootClipboardEvaluated &&
      this.isHomeRouteForColdBootClipboard() &&
      this.loadedBlob() === null &&
      this.prefs.prefs().coldBootClipboardAutoPaste !== 'never'
    );
  }

  private isHomeRouteForColdBootClipboard(): boolean {
    const pathBeforeQuery = this.router.url.split('?')[0] ?? this.router.url;
    const normalizedPath = pathBeforeQuery.split('#')[0] ?? pathBeforeQuery;
    return (
      !this.destroyed &&
      this.route.routeConfig?.path === '' &&
      (normalizedPath === '/' || normalizedPath === '') &&
      this.initialBlob() == null
    );
  }

  private canApplyColdBootClipboard(): boolean {
    return this.isHomeRouteForColdBootClipboard() && this.loadedBlob() === null;
  }

  private async evaluateAlwaysColdBootClipboard(): Promise<void> {
    // Permission gate: the silent path commits to a 150ms splash hold, so
    // we must avoid acquiring it for users who don't have clipboard-read
    // permission granted (Safari, Firefox, anyone who has not opted in
    // via the existing M7a clipboard banner). The roamed `'always'`
    // preference can land on any browser, including those where the
    // local clipboard permission is still `prompt` or `denied`. Wait
    // for permission discovery to settle before deciding - the service
    // kicks off discovery during DI so this typically resolves within a
    // microtask. Non-granted users skip immediately, paying zero added
    // cold-boot latency.
    await this.clipboard.awaitPermissionReady();
    if (this.clipboard.permissionState() !== 'granted') {
      return;
    }
    if (!this.canApplyColdBootClipboard()) {
      // Route or document state changed while we awaited permission.
      return;
    }
    const release = this.loadingSplash.beginBootstrapHold(
      'coldBootClipboard',
      COLD_BOOT_CLIPBOARD_TIMEOUT_MS,
    );
    try {
      const raceResult = await this.raceColdBootClipboardRead(
        this.clipboard.readGrantedClipboardOnce('coldBootAutoPaste'),
      );
      if (raceResult.kind === 'timeout' || !raceResult.result.ok) {
        return;
      }
      const candidate = this.toColdBootClipboardCandidate(raceResult.result.text);
      if (candidate === null || !this.canApplyColdBootClipboard()) {
        return;
      }
      this.applyColdBootClipboardCandidate(candidate, true);
    } finally {
      release();
    }
  }

  private async evaluateAskColdBootClipboard(): Promise<void> {
    const result = await this.clipboard.readGrantedClipboardOnce('coldBootAutoPaste');
    if (!result.ok || !this.canApplyColdBootClipboard()) {
      return;
    }
    const candidate = this.toColdBootClipboardCandidate(result.text);
    if (candidate === null || !this.canApplyColdBootClipboard()) {
      return;
    }
    this.coldBootClipboardCandidate = candidate;
    this.coldBootBannerVisibleSignal.set(true);
    this.logger.event('home.clipboard.coldBoot.prompt.shown');
  }

  private raceColdBootClipboardRead(
    readPromise: Promise<ClipboardGrantedReadResult>,
  ): Promise<ColdBootClipboardReadRaceResult> {
    let timeoutId: number | null = null;
    const timeoutPromise = new Promise<ColdBootClipboardReadRaceResult>((resolve) => {
      timeoutId = window.setTimeout(
        () => resolve({ kind: 'timeout' }),
        COLD_BOOT_CLIPBOARD_TIMEOUT_MS,
      );
    });
    const taggedReadPromise = readPromise.then<ColdBootClipboardReadRaceResult>((result) => ({
      kind: 'read',
      result,
    }));
    return Promise.race([taggedReadPromise, timeoutPromise]).finally(() => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    });
  }

  private toColdBootClipboardCandidate(text: string): ColdBootClipboardCandidate | null {
    const sizeBytes = new TextEncoder().encode(text).length;
    if (sizeBytes > COLD_BOOT_CLIPBOARD_MAX_BYTES) {
      return null;
    }
    const parsed = this.parser.parse(text);
    if (parsed.errors.length > 0 || !this.isTopLevelObjectOrArray(parsed.value)) {
      return null;
    }
    return { text, sizeBytes };
  }

  private isTopLevelObjectOrArray(value: unknown): boolean {
    return Array.isArray(value) || (typeof value === 'object' && value !== null);
  }

  onColdBootClipboardChoice(choice: ColdBootClipboardChoice): void {
    this.coldBootBannerVisibleSignal.set(false);
    this.logger.event('home.clipboard.coldBoot.prompt.choice', { choice });

    if (choice === 'never') {
      this.prefs.update({ coldBootClipboardAutoPaste: 'never' });
      this.coldBootClipboardCandidate = null;
      return;
    }
    if (choice === 'dismiss') {
      this.coldBootClipboardCandidate = null;
      return;
    }

    const candidate = this.coldBootClipboardCandidate;
    this.coldBootClipboardCandidate = null;
    if (choice === 'always') {
      this.prefs.update({ coldBootClipboardAutoPaste: 'always' });
    }
    if (candidate === null || !this.canApplyColdBootClipboard()) {
      return;
    }
    this.applyColdBootClipboardCandidate(candidate, choice === 'always');
  }

  private applyColdBootClipboardCandidate(
    candidate: ColdBootClipboardCandidate,
    emitAutoPasteTelemetry: boolean,
  ): void {
    const priorDraft = this.content();
    this.replaceDocument(candidate.text);
    this.resetHighlightsForDocumentReplacement();
    this.lastFilename.set(null);
    this.suggestedTitlesForMenu.set([]);
    if (emitAutoPasteTelemetry) {
      this.logger.event(
        'home.clipboard.coldBoot.autoPaste',
        { sizeBytesBucket: bucketBytes(candidate.sizeBytes) },
        { sizeBytes: candidate.sizeBytes },
      );
    }
    this.openColdBootClipboardUndoSnack(priorDraft);
  }

  private openColdBootClipboardUndoSnack(priorDraft: string): void {
    // Retain the SnackBarRef so other snackbars opening later cannot
    // squelch the only undo affordance for the silent / banner-paste
    // path. Cleared on dismiss.
    const snackRef: MatSnackBarRef<TextOnlySnackBar> = this.snack.open(
      $localize`:@@home.coldBootClipboard.snackbar.pasted:Pasted from clipboard.`,
      $localize`:@@home.coldBootClipboard.snackbar.undo:Undo`,
      { duration: 8000 },
    );
    this.coldBootClipboardSnackRef = snackRef;
    snackRef
      .onAction()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.replaceDocument(priorDraft);
        this.logger.event('home.clipboard.coldBoot.autoPaste.undo');
      });
    snackRef
      .afterDismissed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (this.coldBootClipboardSnackRef === snackRef) {
          this.coldBootClipboardSnackRef = null;
        }
      });
  }

  /**
   * Atomically clear the `pendingReplaceUndo` snapshot and any
   * outstanding wall-clock cap timer. Idempotent (safe to call when
   * already null, e.g. from a late-firing timer after a synchronous-
   * driven clear). Always pair every `pendingReplaceUndo` write with
   * this helper rather than touching the timer directly.
   */
  private clearPendingReplaceUndo(): void {
    if (this.pendingReplaceUndoTimer !== null) {
      clearTimeout(this.pendingReplaceUndoTimer);
      this.pendingReplaceUndoTimer = null;
    }
    this.pendingReplaceUndo = null;
  }

  /**
   * Install a new `pendingReplaceUndo` snapshot, replacing any prior
   * pending. Pair this with `openReplaceUndoSnack` after the actual
   * `replaceAll`/`applyEdit` attempt so the snackbar reflects the
   * post-edit state. The install ALWAYS happens BEFORE the edit so a
   * synchronously-flushed effect that re-enters the constructor's
   * content-watch effect sees the snapshot rather than a null
   * pending field.
   *
   * `priorBacking` is auto-captured from the current `_documentBacking()`
   * value so per-kind call sites don't need to know about it; this
   * preserves the existing call-site shape while letting Undo restore
   * the file-handle / blob binding as part of the undone state. The
   * input type omits the field for ergonomic call-site shape and the
   * implementation merges it in.
   */
  private installPendingReplace(
    newPending: DistributiveOmit<NonNullable<typeof this.pendingReplaceUndo>, 'priorBacking'>,
  ): void {
    this.clearPendingReplaceUndo();
    this.pendingReplaceUndo = {
      ...newPending,
      priorBacking: this._documentBacking(),
    } as NonNullable<typeof this.pendingReplaceUndo>;
    this.pendingReplaceUndoTimer = setTimeout(
      () => this.clearPendingReplaceUndo(),
      REPLACE_UNDO_CAP_MS,
    );
  }

  /**
   * Open the Replace Undo snackbar for the currently-installed
   * `pendingReplaceUndo`. If a prior snackbar is still visible, dismiss
   * it and emit `home.replaceUndo.snackbarReplaced { from, to }` so
   * dashboards can see the supersede-rate. For extract-only `{from,to}`
   * pairs we ALSO emit the legacy `tree.extract.snackbarReplaced` event
   * (with the legacy `'tree' | 'banner'` enum) for dashboard continuity
   * during one release of dual-emit, then it can be deprecated.
   */
  private openReplaceUndoSnack(snackMessage: string, snackUndoLabel: string): void {
    if (this.replaceUndoSnackRef !== null) {
      const fromKind: ReplaceUndoKind = this.replaceUndoSnackKind ?? 'extract.tree';
      const toKind: ReplaceUndoKind = this.pendingReplaceUndo?.kind ?? 'extract.tree';
      this.replaceUndoSnackRef.dismiss();
      this.logger.event('home.replaceUndo.snackbarReplaced', {
        from: fromKind,
        to: toKind,
      });
      const fromIsExtract = fromKind === 'extract.tree' || fromKind === 'extract.banner';
      const toIsExtract = toKind === 'extract.tree' || toKind === 'extract.banner';
      if (fromIsExtract && toIsExtract) {
        this.logger.event('tree.extract.snackbarReplaced', {
          from: fromKind === 'extract.tree' ? 'tree' : 'banner',
          to: toKind === 'extract.tree' ? 'tree' : 'banner',
        });
      }
      this.replaceUndoSnackRef = null;
      this.replaceUndoSnackKind = null;
    }
    const pending = this.pendingReplaceUndo;
    if (pending === null) {
      return;
    }
    // Extract and tree-sort surfaces use an 8-second snackbar duration
    // and `politeness: 'assertive'` so a screen reader announces the
    // Undo offer immediately. Upload/format/minify/toolbar-sort surfaces
    // use a 30-second snackbar (matching `REPLACE_UNDO_CAP_MS`, the
    // wall-clock cap on `priorText` retention) so the Undo affordance
    // remains visible for the full window during which Ctrl+Z still
    // works, and use the default politeness to match every other
    // user-initiated-action snackbar in the app (cold-boot, save,
    // blob load, etc.); a Format toast does not need to interrupt
    // an in-progress reader announcement. The longer pending cap
    // (`REPLACE_UNDO_CAP_MS = 30_000`) is the single owner of the
    // snapshot lifetime; the snackbar duration is purely about
    // visibility of the affordance.
    const isShortAssertive =
      pending.kind === 'extract.banner' ||
      pending.kind === 'extract.tree' ||
      pending.kind === 'decoded.apply' ||
      pending.kind === 'sort.tree';
    const snackRef: MatSnackBarRef<TextOnlySnackBar> | undefined = isShortAssertive
      ? this.snack.open(snackMessage, snackUndoLabel, { duration: 8000, politeness: 'assertive' })
      : this.snack.open(snackMessage, snackUndoLabel, { duration: REPLACE_UNDO_CAP_MS });
    // Test environments that don't care about the Undo affordance can
    // stub `MatSnackBar.open` as a Jasmine spy that returns undefined.
    // In production `MatSnackBar.open` always returns a `MatSnackBarRef`.
    // When the stub returns undefined, we still want the pending snapshot
    // installed (Ctrl+Z still works) but skip the snackbar's `onAction`
    // wiring rather than crash.
    if (!snackRef) {
      return;
    }
    this.replaceUndoSnackRef = snackRef;
    this.replaceUndoSnackKind = pending.kind;
    snackRef
      .onAction()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        // Race guard: if Ctrl+Z fired the effect's `dismiss()` while
        // the user's click was queued, the field has already been
        // cleared (or replaced by a subsequent replacement). The
        // captured local `pending` still references the original heap
        // object, so an identity mismatch means we lost the race -
        // treat the action as a no-op to avoid double-firing telemetry
        // and re-applying the (now redundant) revert.
        if (this.pendingReplaceUndo !== pending) {
          return;
        }
        pending.undoneViaSnackbar = true;
        // Full-doc swap (not a surgical reverse-edit via
        // `JsonEditorComponent.applyEdit` / `replaceAll`). Trade-off:
        // this clobbers Monaco's redo stack, so Ctrl+Y / Ctrl+Shift+Z
        // cannot reach the post-action state after snackbar Undo.
        // Accepted because the captured `priorText` is the entire pre-
        // action document and a surgical reverse splice would still
        // need to invalidate any post-action typing - same observable
        // outcome with more code.
        this.replaceDocument(pending.priorText);
        const latency = performance.now() - pending.startMs;
        this.emitUndoTelemetry(pending, 'snackbar', latency);
        this.restoreSideStateFromPending(pending);
      });
    snackRef
      .afterDismissed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (this.replaceUndoSnackRef === snackRef) {
          this.replaceUndoSnackRef = null;
          this.replaceUndoSnackKind = null;
        }
      });
  }

  /**
   * Emit the per-kind Undo telemetry event. Called by both the
   * snackbar `onAction` (source='snackbar') and the constructor effect
   * when content reverts to priorText (source='ctrlZ'). Per AGENTS.md
   * Sec 4 telemetry rules, props use closed enums and numeric latency
   * goes through `bucketUndoLatency`.
   */
  private emitUndoTelemetry(
    pending: NonNullable<typeof this.pendingReplaceUndo>,
    source: 'snackbar' | 'ctrlZ',
    undoLatencyMs: number,
  ): void {
    const undoLatencyMsBucket = bucketUndoLatency(undoLatencyMs);
    switch (pending.kind) {
      case 'upload':
        this.logger.event(
          'home.upload.undo',
          {
            source,
            trigger: pending.uploadTrigger,
            undoLatencyMsBucket,
          },
          { undoLatencyMs },
        );
        return;
      case 'format':
        this.logger.event('home.format.undo', { source, undoLatencyMsBucket }, { undoLatencyMs });
        return;
      case 'minify':
        this.logger.event(
          'home.minify.undo',
          { source, priorMode: pending.priorMode, undoLatencyMsBucket },
          { undoLatencyMs },
        );
        return;
      case 'sort.toolbar':
        this.logger.event(
          'home.sort.undo',
          { source, priorMode: pending.priorMode, undoLatencyMsBucket },
          { undoLatencyMs },
        );
        return;
      case 'sort.tree':
        this.logger.event('tree.sortKeys.undo', { source, undoLatencyMsBucket }, { undoLatencyMs });
        return;
      case 'extract.banner':
        this.logger.event('home.extract.banner.undo', {
          source,
          pasteSource: pending.pasteSource ?? 'paste',
          undoLatencyMsBucket,
        });
        return;
      case 'extract.tree':
        this.logger.event('tree.extract.undo', {
          source,
          undoLatencyMsBucket,
        });
        return;
      case 'decoded.apply':
        this.logger.event(
          'home.decodedApply.undo',
          { source, undoLatencyMsBucket },
          { undoLatencyMs },
        );
        return;
      case 'coldBoot':
        // Reserved for a future cold-boot consolidation; no telemetry
        // path today (cold-boot has its own messaging via
        // `home.clipboard.coldBoot.*`).
        return;
    }
  }

  /**
   * Restore the pre-action side-state captured at install time. Called
   * by both the snackbar `onAction` and the constructor effect after
   * `replaceDocument(priorText)` has rolled the content back. Per-kind
   * branches mirror what each surface's install path snapshotted.
   */
  private restoreSideStateFromPending(pending: NonNullable<typeof this.pendingReplaceUndo>): void {
    // Restore the document backing first so subsequent calls (e.g.,
    // applying the per-kind side-state below) see the correct
    // dirty/canSave derivations from the union. This is a no-op for
    // kinds that didn't change the backing (most replacements happen
    // within the same backing); it's the lifeline for file-backed
    // adoption that paste/clear/upload Undo-restores.
    this._documentBacking.set(pending.priorBacking);
    switch (pending.kind) {
      case 'upload':
        this.lastFilename.set(pending.priorLastFilename);
        this.highlights.set([...pending.priorHighlights]);
        this.mutatedPaths.set(new Set(pending.priorMutatedPaths));
        this.suggestedTitlesForMenu.set([...pending.priorSuggestedTitles]);
        this.extractedCandidate.set(pending.priorExtractedCandidate);
        this.uploadError.set(pending.priorUploadError);
        return;
      case 'format':
        // No side-state to restore: Format only touches editor text.
        return;
      case 'minify':
        this.mode.set(pending.priorMode);
        return;
      case 'sort.toolbar':
        this.mode.set(pending.priorMode);
        return;
      case 'sort.tree':
        // No side-state to restore; right-click sort is a surgical edit.
        return;
      case 'extract.banner':
        // Restore the pre-accept highlights / mutated paths and re-arm
        // the extract banner so the user lands at the mixed text with
        // the same offer they had before clicking Extract.
        this.highlights.set([...pending.highlightsSnapshot]);
        this.mutatedPaths.set(new Set(pending.mutatedPathsAtAccept));
        if (pending.pasteSource !== null) {
          this.runExtractorOnCurrentContent(pending.pasteSource);
        }
        return;
      case 'extract.tree':
        // No side-state to restore: tree-extract is a surgical edit
        // that preserves highlights and mutatedPaths.
        return;
      case 'decoded.apply':
        // No side-state to restore: decoded-apply is a surgical splice
        // (single string literal) that preserves highlights and
        // mutatedPaths by construction.
        return;
      case 'coldBoot':
        return;
    }
  }

  /**
   * Attempt to replace the entire document via `JsonEditorComponent.replaceAll`,
   * preserving Monaco's undo stack. Falls back to the legacy `setContent`
   * path (which clobbers undo via `model.setValue`) when the editor is not
   * mounted or rejects the edit, and emits the per-surface `applyFailed`
   * telemetry so the rate is observable. The snackbar Undo affordance still
   * works on the fallback path via the `pendingReplaceUndo.priorText`
   * snapshot.
   *
   * Token-bump policy mirrors today's pre-issue-#313 behavior so view state
   * is preserved on actions that don't fundamentally restructure the
   * document:
   * - `upload`: bumps `viewResetToken` (a new file is a wholesale change;
   *   matches today's `replaceDocument`).
   * - `format`, `minify`, and `sort`: do NOT bump (whitespace and
   *   serialization changes preserve tree structure; preserves the user's
   *   tree scroll position / cursor).
   */
  private applyReplaceWithFallback(
    next: string,
    editorSource: string,
    surface: 'upload' | 'format' | 'minify' | 'sort',
  ): void {
    const logApplyFailed = (reason: ReplaceApplyFailedReason): void => {
      switch (surface) {
        case 'upload':
          this.logger.warn('home.upload.applyFailed', { reason });
          return;
        case 'format':
          this.logger.warn('home.format.applyFailed', { reason });
          return;
        case 'minify':
          this.logger.warn('home.minify.applyFailed', { reason });
          return;
        case 'sort':
          this.logger.warn('home.sort.applyFailed', { reason });
          return;
      }
    };
    const bumpToken = surface === 'upload';
    const finishSuccess = (): void => {
      // Mirror the post-`setContent` side-effects `replaceDocument`
      // performs so the tree pane and view-reset listeners see the
      // same state.
      this.treeFlush$.next();
      if (bumpToken) {
        this.viewResetToken.update((token) => token + 1);
      }
    };
    const finishFallback = (reason: ReplaceApplyFailedReason): void => {
      logApplyFailed(reason);
      this.setContent(next);
      this.treeFlush$.next();
      if (bumpToken) {
        this.viewResetToken.update((token) => token + 1);
      }
    };
    const editor = this.editor();
    if (!editor) {
      // No editor mounted; the legacy path still flushes `content` to
      // the (eventual) Monaco model when it mounts. The captured
      // `priorText` snapshot keeps snackbar Undo working.
      finishFallback('editorNotReady');
      return;
    }
    // Defense in depth: every production caller already short-circuits
    // when `next === content()` (see `onFormat`, `onMinify`, and the
    // `onFilesReceived` text-no-op branch). `this.content()` is the
    // right oracle here because `setContent` is the single funnel that
    // updates it from the editor's value change events, so it stays in
    // sync with `model.getValue()` outside of mid-flight normalization
    // races. `replaceAll` also detects the no-op internally and returns
    // `'noOp'`; this gate avoids a stale-snackbar leak for a future
    // caller that forgets to short-circuit.
    const result = editor.replaceAll(next, editorSource);
    switch (result) {
      case 'applied':
        finishSuccess();
        return;
      case 'noOp':
        // No work needed; editor and content already in sync. Skip
        // `treeFlush$` and `viewResetToken` bumps -- `parseResult` is
        // unchanged by definition (`next === content()`), so the tree
        // pane and view-reset listeners have nothing to react to.
        return;
      case 'modelNull':
      case 'editsRejected':
        finishFallback(result);
        return;
    }
  }

  /**
   * Snackbar-display hygiene for an arbitrary filename. Strips ASCII C0
   * + C1 control chars (so a maliciously-named upload cannot inject
   * BEL/CR/etc. into a screen-reader announcement) and truncates to a
   * 40-character cap with an ASCII ellipsis. Telemetry never receives
   * the filename - it is display-only.
   */
  private formatFilenameForSnack(filename: string): string {
    const cleaned = filename.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
    return cleaned.length > 40 ? cleaned.slice(0, 37) + '...' : cleaned;
  }

  private applyLoadedBlob(blob: JsonBlob): void {
    const savedSnapshot = this.snapshotFromBlob(blob);
    this.replaceDocument(savedSnapshot.content, { kind: 'blob', blob, savedSnapshot });
    this.title.set(savedSnapshot.title);
    this.highlights.set(savedSnapshot.highlights);
    this.mutatedPaths.set(new Set<string>());
  }

  private applySavedBlobResponse(blob: JsonBlob, submitted: LoadedSnapshot): void {
    const savedSnapshot = this.snapshotFromBlob(blob);
    const newBacking: DocumentBacking = { kind: 'blob', blob, savedSnapshot };
    if (this.content() === submitted.content && this.content() !== savedSnapshot.content) {
      this.replaceDocument(savedSnapshot.content, newBacking);
    } else {
      this._documentBacking.set(newBacking);
    }
    if (this.title() === submitted.title) {
      this.title.set(savedSnapshot.title);
    }
    if (highlightsEqual(this.highlights(), submitted.highlights)) {
      this.highlights.set(savedSnapshot.highlights);
    }
    this.mutatedPaths.set(new Set<string>());
  }

  private snapshotFromBlob(blob: JsonBlob): LoadedSnapshot {
    return {
      content: blob.content,
      title: blob.title ?? '',
      highlights: [...(blob.highlights ?? [])],
    };
  }

  private currentSnapshot(): LoadedSnapshot {
    return {
      content: this.content(),
      title: this.title(),
      highlights: [...this.highlights()],
    };
  }

  private resetLoadedBlobState(): void {
    this._documentBacking.set(DRAFT_BACKING);
    this.highlights.set([]);
    this.mutatedPaths.set(new Set<string>());
  }

  private resetHighlightsForDocumentReplacement(): void {
    const removedHighlights = this.highlights();
    this.highlights.set([]);
    this.mutatedPaths.update((mutatedPaths) => {
      const mergedPaths = new Set(mutatedPaths);
      for (const highlight of removedHighlights) {
        mergedPaths.add(highlight.path);
      }
      return mergedPaths;
    });
    // Note: the prior `if (this.loadedBlob() === null) this.loadedSnapshot.set(null);`
    // dead code was removed in the M-PWA-write-back DocumentBacking
    // refactor. With the union, `'draft'` has no `savedSnapshot` to clear
    // and the other variants intentionally retain their snapshot when
    // highlights reset for a non-replacing flow.
  }

  __loadBlobForTesting(blob: JsonBlob): void {
    this.applyLoadedBlob(blob);
  }

  /**
   * Test seam: bypass the 150 ms tree-pane debounce so a spec can
   * synthesize a content change and immediately assert on rendered
   * tree state. Specs must still call `fixture.detectChanges()` after
   * calling this helper - it flushes the RxJS pipeline only, not
   * Angular's change-detection scheduler.
   *
   * Convention enforcement (`__<verb>ForTesting` prefix) lives in
   * AGENTS.md s4 + code review; TypeScript does not treat `__` as
   * private. Production callers must not reference this method.
   */
  __flushTreePaneForTesting(): void {
    this.treeFlush$.next();
  }

  onHighlightsChange(nextHighlights: readonly BlobHighlight[]): void {
    const previousHighlights = this.highlights();
    this.highlights.set([...nextHighlights]);
    const changedPaths = this.changedHighlightPaths(previousHighlights, nextHighlights);
    if (changedPaths.size === 0) {
      return;
    }
    this.mutatedPaths.update((mutatedPaths) => {
      const mergedPaths = new Set(mutatedPaths);
      for (const path of changedPaths) {
        mergedPaths.add(path);
      }
      return mergedPaths;
    });
  }

  private changedHighlightPaths(
    previousHighlights: readonly BlobHighlight[],
    nextHighlights: readonly BlobHighlight[],
  ): Set<string> {
    const previousByPath = new Map(
      previousHighlights.map((highlight) => [highlight.path, highlight]),
    );
    const nextByPath = new Map(nextHighlights.map((highlight) => [highlight.path, highlight]));
    const paths = new Set([...previousByPath.keys(), ...nextByPath.keys()]);
    const changedPaths = new Set<string>();
    for (const path of paths) {
      if (!sameHighlightEntry(previousByPath.get(path), nextByPath.get(path))) {
        changedPaths.add(path);
      }
    }
    return changedPaths;
  }

  private pruneHighlightsForSave(
    content: string,
    highlights: readonly BlobHighlight[],
  ): readonly BlobHighlight[] {
    const parsed = this.parser.parse(content);
    if (parsed.errors.length > 0 || parsed.ast === undefined) {
      return highlights;
    }

    const reachablePaths = new Set<string>();
    this.collectReachablePaths(parsed.ast, reachablePaths);
    return highlights.filter((highlight) => reachablePaths.has(highlight.path));
  }

  private collectReachablePaths(node: JsoncNode, reachablePaths: Set<string>): void {
    reachablePaths.add(this.parser.pathToString(this.parser.pathForNode(node)));
    for (const child of node.children ?? []) {
      this.collectReachablePaths(child, reachablePaths);
    }
  }

  private async handleBlobConflict(remoteBlob: JsonBlob): Promise<void> {
    this.snack.open(
      $localize`:@@blobs.conflict.toast:Reloaded - this blob was changed in another tab`,
      $localize`:@@common.dismiss:Dismiss`,
      { duration: 5000 },
    );

    const baseSnapshot = getSavedSnapshot(this._documentBacking());
    if (baseSnapshot === null) {
      this.applyLoadedBlob(remoteBlob);
      return;
    }

    const localSnapshot = this.currentSnapshot();
    const remoteSnapshot = this.snapshotFromBlob(remoteBlob);
    const contentConflicts =
      localSnapshot.content !== baseSnapshot.content &&
      remoteSnapshot.content !== baseSnapshot.content &&
      localSnapshot.content !== remoteSnapshot.content;
    const titleConflicts =
      localSnapshot.title !== baseSnapshot.title &&
      remoteSnapshot.title !== baseSnapshot.title &&
      localSnapshot.title !== remoteSnapshot.title;
    const replaceRemote =
      contentConflicts || titleConflicts ? await this.promptConflictResolution() : false;

    const nextContent = this.rebaseCoarseField(
      baseSnapshot.content,
      localSnapshot.content,
      remoteSnapshot.content,
      contentConflicts,
      replaceRemote,
    );
    const nextTitle = this.rebaseCoarseField(
      baseSnapshot.title,
      localSnapshot.title,
      remoteSnapshot.title,
      titleConflicts,
      replaceRemote,
    );
    const nextHighlights = this.rebaseHighlights(
      remoteSnapshot.highlights,
      localSnapshot.highlights,
      this.mutatedPaths(),
    );

    const newBacking: DocumentBacking = {
      kind: 'blob',
      blob: remoteBlob,
      savedSnapshot: remoteSnapshot,
    };
    if (this.content() !== nextContent) {
      this.replaceDocument(nextContent, newBacking);
    } else {
      this._documentBacking.set(newBacking);
    }
    this.title.set(nextTitle);
    this.highlights.set(nextHighlights);
    this.mutatedPaths.set(new Set<string>());
  }

  private rebaseCoarseField<T>(
    baseValue: T,
    localValue: T,
    remoteValue: T,
    conflicts: boolean,
    replaceRemote: boolean,
  ): T {
    if (conflicts) {
      return replaceRemote ? localValue : remoteValue;
    }
    return localValue !== baseValue ? localValue : remoteValue;
  }

  private async promptConflictResolution(): Promise<boolean> {
    const data: ConfirmDialogData = {
      title: $localize`:@@blobs.conflict.title:Blob changed in another tab`,
      message: $localize`:@@blobs.conflict.message:Your local changes conflict with the latest version. Discard your changes or replace the remote version on your next save?`,
      confirmLabel: $localize`:@@blobs.conflict.replaceRemote:Replace remote`,
      cancelLabel: $localize`:@@blobs.conflict.discardMine:Discard my changes`,
    };
    const ref = this.dialog.open<ConfirmDialogComponent, ConfirmDialogData, boolean>(
      ConfirmDialogComponent,
      { data, width: '420px', autoFocus: 'dialog' },
    );
    return (await firstValueFrom(ref.afterClosed())) === true;
  }

  private rebaseHighlights(
    remoteHighlights: readonly BlobHighlight[],
    localHighlights: readonly BlobHighlight[],
    mutatedPaths: ReadonlySet<string>,
  ): readonly BlobHighlight[] {
    const mergedByPath = new Map(remoteHighlights.map((highlight) => [highlight.path, highlight]));
    const localByPath = new Map(localHighlights.map((highlight) => [highlight.path, highlight]));
    for (const path of mutatedPaths) {
      const localHighlight = localByPath.get(path);
      if (localHighlight === undefined) {
        mergedByPath.delete(path);
      } else {
        mergedByPath.set(path, localHighlight);
      }
    }
    return [...mergedByPath.values()].sort((leftHighlight, rightHighlight) =>
      leftHighlight.path.localeCompare(rightHighlight.path),
    );
  }

  private scanTreeStringLeaves(value: unknown): void {
    if (value === null || value === undefined) {
      this.pendingTreeExtractTelemetry = null;
      return;
    }

    const sourceVersion = this.treeStringExtractor.beginGeneration();
    const stringLeaves = collectStringLeaves(value);
    this.pendingTreeExtractTelemetry = {
      sourceVersion,
      stringLeaves,
      uniqueStringsScanned: new Set(stringLeaves).size,
    };
    this.treeStringExtractor.enqueueScan(stringLeaves);

    if (!this.treeStringExtractor.scanInFlight()) {
      this.emitTreeExtractShownTelemetryIfPending(
        sourceVersion,
        this.treeStringExtractor.candidates(),
      );
    }
  }

  private emitTreeExtractShownTelemetryIfPending(
    sourceVersion: number,
    candidates: ReadonlyMap<string, ExtractedJson>,
  ): void {
    const pending = this.pendingTreeExtractTelemetry;
    if (!pending || pending.sourceVersion !== sourceVersion) {
      return;
    }

    const candidateNodes = this.countCandidateStringLeaves(pending.stringLeaves, candidates);
    this.logger.event('tree.extract.shown', undefined, {
      uniqueStringsScanned: pending.uniqueStringsScanned,
      uniqueCandidates: candidates.size,
      candidateNodes,
    });
    this.pendingTreeExtractTelemetry = null;
  }

  private countCandidateStringLeaves(
    stringLeaves: readonly string[],
    candidates: ReadonlyMap<string, ExtractedJson>,
  ): number {
    let count = 0;
    for (const stringLeaf of stringLeaves) {
      if (candidates.has(stringLeaf)) {
        count++;
      }
    }
    return count;
  }

  onSplitterPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    // Defensive guard: at narrow viewport widths the splitter is
    // CSS-hidden via `display:none`, so this handler should be
    // unreachable. If a stale event still fires (e.g. during a
    // viewport-width transition), refuse to start a drag rather than
    // mutate the persisted desktop split ratio.
    if (this.effectivePaneVisibility() !== 'both') return;
    const host = this.splitHost()?.nativeElement;
    if (!host) return;
    ev.preventDefault();
    const target = ev.currentTarget as HTMLElement;
    target.setPointerCapture(ev.pointerId);
    const vertical = this.layoutOrientation() === 'vertical';

    const move = (e: PointerEvent): void => {
      // Mid-drag guard (M7l): if the viewport crosses into narrow
      // mid-drag, the splitter is no longer rendered. Stop writing
      // splitRatio so the persisted desktop ratio survives the
      // transition unchanged.
      if (this.effectivePaneVisibility() !== 'both') return;
      const rect = host.getBoundingClientRect();
      const raw = vertical
        ? (e.clientY - rect.top) / rect.height
        : (e.clientX - rect.left) / rect.width;
      const clamped = Math.min(0.9, Math.max(0.1, raw));
      this.splitRatio.set(clamped);
    };

    const end = (e: PointerEvent): void => {
      try {
        target.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
    };

    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }

  onValueChange(next: string): void {
    this.setContent(next);
  }

  onCursorChange(pos: { line: number; column: number; offset: number }): void {
    this.cursor.set({ line: pos.line, column: pos.column });
    this.beaconNav.markEditorActive();
    if (!this.syncEnabled()) return;
    const tree = this.tree();
    if (!tree) return;
    const resolved = this.resolveTreePath(pos.offset);
    // If this cursor change is the echo of a tree->editor reveal we
    // just initiated, drop it. The pending value is consumed
    // single-shot so a subsequent independent move re-triggers sync.
    if (this.pendingEditorReveal === resolved) {
      this.pendingEditorReveal = undefined;
      return;
    }
    this.pendingTreeApply = resolved;
    tree.selectByPathString(resolved);
  }

  onTreeSelectionChange(path: readonly (string | number)[] | null): void {
    this.beaconNav.markTreeActive();
    if (!this.syncEnabled()) return;
    const editor = this.editor();
    if (!editor) return;
    const pathString = path === null ? null : this.parser.pathToString([...path]);
    if (this.pendingTreeApply === pathString) {
      this.pendingTreeApply = undefined;
      return;
    }
    if (path === null) return;

    const ast = this.parseResult().ast;
    if (!ast) return;
    const valueNode = findNodeAtLocation(ast, [...path]);
    if (!valueNode) return;
    // Object/array values inside a property: highlight the whole
    // "key": <value> block by selecting the parent property node.
    // Primitive leaves and array elements: highlight just the value.
    const target: JsoncNode =
      (valueNode.type === 'object' || valueNode.type === 'array') &&
      valueNode.parent?.type === 'property'
        ? valueNode.parent
        : valueNode;

    const text = this.content();
    // jsonc-parser strips a leading BOM before parsing, so AST node
    // offsets are in stripped-text coordinates. Monaco/editor offsets
    // are in full-text coordinates. Shift by the BOM length to align.
    const bomShift = this.bomShift(text);
    const startOffset = target.offset + bomShift;
    const startPos = this.parser.offsetToPosition(text, startOffset);
    const endPos = this.parser.offsetToPosition(text, startOffset + target.length);
    this.pendingEditorReveal = pathString;
    editor.revealRange({
      startLineNumber: startPos.line,
      startColumn: startPos.column,
      endLineNumber: endPos.line,
      endColumn: endPos.column,
    });
  }

  /**
   * Cross-pane dispatcher for beacon jump intents (pill clicks +
   * ancestor-badge clicks). Decides whether to drive the tree or the
   * editor based on `effectivePaneVisibility()` plus
   * `BeaconNavigationService.lastActivePane()` (the latter only used
   * when both panes are visible). Reads *effective* visibility (M7l)
   * so narrow-viewport dispatches never route to a hidden pane.
   * Always emits `beacons.crossPane.dispatched` telemetry with
   * closed-enum props (no paths, no key/value content).
   */
  private dispatchBeaconJump(request: BeaconJumpRequest): void {
    const paneVisibility = this.effectivePaneVisibility();
    const lastActive = this.beaconNav.lastActivePane();
    const target: 'tree' | 'editor' =
      paneVisibility === 'editor-only'
        ? 'editor'
        : paneVisibility === 'tree-only'
          ? 'tree'
          : lastActive;
    this.logger.info('beacons.crossPane.dispatched', {
      target,
      paneVisibility,
      source: request.source,
      icon: request.icon,
    });
    if (target === 'tree') {
      const tree = this.tree();
      if (!tree) return;
      const pathString = this.parser.pathToString([...request.path]);
      tree.selectByPathString(pathString);
      return;
    }
    // Editor target: reveal the value in Monaco directly without
    // going through the tree (mirrors the tree->editor branch of
    // `onTreeSelectionChange`, but without selectionChange echoes).
    const editor = this.editor();
    if (!editor) return;
    const ast = this.parseResult().ast;
    if (!ast) return;
    const valueNode = findNodeAtLocation(ast, [...request.path]);
    if (!valueNode) return;
    const targetNode =
      (valueNode.type === 'object' || valueNode.type === 'array') &&
      valueNode.parent?.type === 'property'
        ? valueNode.parent
        : valueNode;
    const text = this.content();
    const bomShift = this.bomShift(text);
    const startOffset = targetNode.offset + bomShift;
    const startPos = this.parser.offsetToPosition(text, startOffset);
    const endPos = this.parser.offsetToPosition(text, startOffset + targetNode.length);
    editor.revealRange({
      startLineNumber: startPos.line,
      startColumn: startPos.column,
      endLineNumber: endPos.line,
      endColumn: endPos.column,
    });
  }

  onExtractRequest(event: TreeExtractRequest): void {
    const currentVersion = this.treeStringExtractor.currentVersion();
    if (event.sourceVersion !== currentVersion) {
      this.logger.warn('tree.extract.staleClick', {
        eventVersion: event.sourceVersion,
        currentVersion,
      });
      return;
    }

    const priorText = this.content();
    let result: PatchResult;
    try {
      result = patchExtractedValue(priorText, event.path, event.replacement);
    } catch (error) {
      const reason = error instanceof Error ? error.message : null;
      switch (reason) {
        case 'extract.patch.parse-failed':
          this.logger.warn('tree.extract.applyFailed', { reason: 'parseFailed' });
          return;
        case 'extract.patch.path-not-found':
          this.logger.warn('tree.extract.applyFailed', { reason: 'pathNotFound' });
          return;
        default: {
          // Patcher's documented contract is the two extract.patch.*
          // cases above; if a third throw appears (patcher regression)
          // or an unexpected runtime fault leaks through (e.g. an
          // internal jsonc-parser error, OOM), log via `error` so the
          // cause is preserved in App Insights `exceptions` without
          // leaking the raw message into `customDimensions`. Closed-
          // enum `source` prop keeps the warn channel's reason union
          // clean. Mirrors `onSortKeysRequest`'s default branch.
          const cause = error instanceof Error ? error : new Error(String(error));
          this.logger.error('tree.extract.unexpectedError', cause, { source: 'patcher' });
          return;
        }
      }
    }

    const editor = this.editor();
    if (!editor) {
      this.logger.warn('tree.extract.applyFailed', { reason: 'editorUnavailable' });
      return;
    }
    const startOffset = result.targetOffset;
    const endOffset = startOffset + result.targetLength;
    if (!editor.applyEdit(startOffset, endOffset, result.replacementText, 'jotjson-extract')) {
      this.logger.warn('tree.extract.applyFailed', { reason: 'applyEditFailed' });
      return;
    }

    this.logger.event(
      'tree.extract.click',
      { source: event.source },
      {
        blockCount: event.replacement.blockCount,
        proseSegments: event.replacement.proseSegments ?? 0,
      },
    );
    // Bypass the 150 ms tree-pane debounce so `expandNodeAtPath`
    // (below) operates against the freshly-flushed tree rather
    // than the stale pre-Extract tree. We do NOT bump
    // `viewResetToken` here - Extract preserves the rest of the
    // document byte-for-byte, so any subtrees the user manually
    // expanded elsewhere must survive.
    this.treeFlush$.next();
    this.tree()?.expandNodeAtPath(event.path);
    // Clear any in-flight pending state first so a rapid re-extract
    // (A then B within 30s) cannot leave A's wall-clock timer queued -
    // it would later wipe B's snapshot mid-window. The helper is
    // idempotent when no prior state exists.
    this.installPendingReplace({
      priorText,
      startMs: performance.now(),
      undoneViaSnackbar: false,
      kind: 'extract.tree',
      // Tree-extract doesn't bump `viewResetToken`; record the
      // current value so the phantom-undo gate in the effect is a
      // no-op for `kind: 'extract.tree'` (gate explicitly exempts
      // this kind anyway).
      viewResetTokenAtAccept: this.viewResetToken(),
    });
    this.openReplaceUndoSnack(
      $localize`:@@home.extract.snackbar.applied:Extracted embedded JSON into the document.`,
      $localize`:@@home.extract.snackbar.undo:Undo`,
    );
  }

  onSortKeysRequest(event: TreeSortKeysRequest): void {
    const priorText = this.content();
    let result: SortPatchResult;
    try {
      result = patchSortKeysAtPath(priorText, event.path);
    } catch (error) {
      const reason = error instanceof Error ? error.message : null;
      switch (reason) {
        case 'sort.patch.parse-failed':
          this.logger.warn('tree.sortKeys.applyFailed', { reason: 'parseFailed' });
          return;
        case 'sort.patch.path-not-found':
          this.logger.warn('tree.sortKeys.applyFailed', { reason: 'pathNotFound' });
          return;
        case 'sort.patch.not-object':
          this.logger.warn('tree.sortKeys.applyFailed', { reason: 'notObject' });
          return;
        case 'sort.patch.empty-or-single':
          return;
        default: {
          // Patcher's documented contract is the four `sort.patch.*` cases
          // above; if a fifth throw appears (patcher regression) or an
          // unexpected runtime fault leaks through (e.g. an internal
          // jsonc-parser error, OOM), log via `error` so the cause is
          // preserved in App Insights `exceptions` without leaking the
          // raw message into `customDimensions`. Closed-enum `source`
          // prop keeps the warn channel's reason union clean.
          const cause = error instanceof Error ? error : new Error(String(error));
          this.logger.error('tree.sortKeys.unexpectedError', cause, { source: 'patcher' });
          return;
        }
      }
    }

    const ast = this.parseResult().ast;
    const targetNode = ast ? findNodeAtLocation(ast, [...event.path]) : null;
    const keyCountAtPath = targetNode?.type === 'object' ? (targetNode.children?.length ?? 0) : 0;
    const keyCountBucket = bucketCount(keyCountAtPath);
    if (result.patched === priorText) {
      this.logger.event('tree.sortKeys.click', { alreadySorted: 'true', keyCountBucket });
      return;
    }

    const editor = this.editor();
    if (!editor) {
      this.logger.warn('tree.sortKeys.applyFailed', { reason: 'editorUnavailable' });
      return;
    }
    const startOffset = result.targetOffset;
    const endOffset = startOffset + result.targetLength;
    if (!editor.applyEdit(startOffset, endOffset, result.replacementText, 'jotjson-sort')) {
      this.logger.warn('tree.sortKeys.applyFailed', { reason: 'applyEditFailed' });
      return;
    }

    this.logger.event('tree.sortKeys.click', { alreadySorted: 'false', keyCountBucket });
    this.treeFlush$.next();
    this.tree()?.expandNodeAtPath(event.path);
    this.installPendingReplace({
      priorText,
      startMs: performance.now(),
      undoneViaSnackbar: false,
      kind: 'sort.tree',
      viewResetTokenAtAccept: this.viewResetToken(),
    });
    this.openReplaceUndoSnack(
      $localize`:@@home.sortKeys.snackbar.applied:Sorted this object's keys.`,
      $localize`:@@home.sortKeys.snackbar.undo:Undo`,
    );
  }

  /**
   * Handler for the Apply button in {@link DecodedValueDialogComponent}.
   * Re-validates `sourceVersion` against the live tree-string extractor
   * (the tree-side `afterClosed` handler does its own three-invariant
   * stale check, but the version-check here defends against a race
   * where the document changes between dialog-close and event-receive),
   * calls {@link patchDecodedString} to rewrite the single string
   * literal at `event.path` to its prefix-decoded (CRLF-bearing) form,
   * and routes the result through `editor.applyEdit` with a named
   * undo group (`jotjson-decoded-apply`) so Ctrl+Z surgically reverts
   * just this edit. Mirrors `onExtractRequest` precedent.
   */
  onApplyDecodedRequest(event: TreeApplyDecodedRequest): void {
    const currentVersion = this.treeStringExtractor.currentVersion();
    if (event.sourceVersion !== currentVersion) {
      this.logger.warn('home.decodedApply.applyFailed', { reason: 'staleVersion' });
      return;
    }

    const priorText = this.content();
    let result: DecodedApplyPatchResult;
    try {
      result = patchDecodedString(priorText, event.path, event.manglingKind);
    } catch (error) {
      const message = error instanceof Error ? error.message : null;
      let reason: 'parseFailed' | 'pathNotFound' | 'notString' | 'unknown';
      switch (message) {
        case 'decoded.apply.parse-failed':
          reason = 'parseFailed';
          break;
        case 'decoded.apply.path-not-found':
          reason = 'pathNotFound';
          break;
        case 'decoded.apply.not-string':
          reason = 'notString';
          break;
        default:
          reason = 'unknown';
      }
      this.logger.warn('home.decodedApply.applyFailed', { reason });
      return;
    }

    if (result.patched === priorText) {
      // No-op splice (e.g. value was already decoded). Bail without
      // touching the editor or installing a pending undo.
      return;
    }

    const editor = this.editor();
    if (!editor) {
      this.logger.warn('home.decodedApply.applyFailed', { reason: 'editorUnavailable' });
      return;
    }
    const startOffset = result.targetOffset;
    const endOffset = startOffset + result.targetLength;
    if (
      !editor.applyEdit(startOffset, endOffset, result.replacementText, 'jotjson-decoded-apply')
    ) {
      this.logger.warn('home.decodedApply.applyFailed', { reason: 'applyEditFailed' });
      return;
    }

    this.logger.event('home.decodedApply.applied', {
      source: 'decodedDialog',
      manglingKind: event.manglingKind,
    });
    // Bypass the 150 ms tree-pane debounce so the post-apply tree reflects
    // the new (multi-line) string value immediately. We do NOT bump
    // `viewResetToken` -- decoded-apply preserves the document
    // byte-for-byte everywhere except inside the single string literal,
    // so manually-expanded subtrees elsewhere must survive.
    this.treeFlush$.next();
    this.installPendingReplace({
      priorText,
      startMs: performance.now(),
      undoneViaSnackbar: false,
      kind: 'decoded.apply',
      viewResetTokenAtAccept: this.viewResetToken(),
    });
    this.openReplaceUndoSnack(
      $localize`:@@home.decodedApply.snackbar.applied:Replaced "??" markers with line breaks in the document.`,
      $localize`:@@home.decodedApply.snackbar.undo:Undo`,
    );
  }

  onToggleSelectionSync(): void {
    const next = !this.prefs.prefs().treeEditorSelectionSync;
    this.prefs.update({ treeEditorSelectionSync: next });
    // Clear any in-flight echo expectations so a cycle that survives
    // an OFF flip cannot suppress a real gesture once sync turns back
    // on (the next gesture re-engages cleanly).
    this.pendingEditorReveal = undefined;
    this.pendingTreeApply = undefined;
    // Issue #266: clear any pending defer in the tree on sync toggle
    // (regardless of direction). A defer from the prior sync session
    // is moot. We DO NOT clear `selectedPath` -- preserving today's
    // behavior that toggling the preference does not destroy the
    // user's current visible selection.
    this.tree()?.clearPendingSelectPath();
  }

  private syncEnabled(): boolean {
    return this.prefs.prefs().treeEditorSelectionSync;
  }

  /**
   * Resolves a Monaco editor offset to a tree path string. Returns
   * `null` when the cursor is in trailing whitespace, before the
   * document starts, or otherwise outside the parsed AST.
   *
   * Validates the resolved path against the LIVE parse AST (not the
   * tree's possibly-stale `nodeIndex`). The tree's
   * `selectByPathString` defers application until `nodeIndex`
   * catches up (issue #266). Trailing placeholder segments produced
   * by `jsonc-parser`'s `getLocation` (cursor in incomplete syntax)
   * are trimmed by walking upward until the AST has a node at that
   * prefix. Falls back to the document root `$` ONLY when
   * `locationAt` itself returned an empty path (cursor genuinely at
   * top-level), preventing the historic root-jump on incomplete-
   * value cursor positions.
   */
  private resolveTreePath(offset: number): string | null {
    const text = this.content();
    // Align Monaco's full-text offset with the parser's stripped-text
    // coordinate space (BOM-aware).
    const bomShift = this.bomShift(text);
    const adjusted = offset - bomShift;
    if (adjusted < 0) return null;
    const stripped = bomShift > 0 ? text.slice(bomShift) : text;
    const ast = this.parseResult().ast;
    if (!ast) return null;
    const path = this.parser.locationAt(stripped, adjusted);

    for (let length = path.length; length > 0; length--) {
      const segments = path.slice(0, length);
      if (findNodeAtLocation(ast, [...segments])) {
        return this.parser.pathToString(segments);
      }
    }

    // Only fall back to '$' when the cursor was genuinely at top-
    // level (locationAt returned []). This avoids the historic
    // root-jump regression where an incomplete deeper path failed
    // to resolve and we silently selected the whole document.
    if (path.length === 0 && adjusted >= ast.offset && adjusted <= ast.offset + ast.length) {
      return '$';
    }
    return null;
  }

  private bomShift(text: string): number {
    return text.charCodeAt(0) === 0xfeff ? 1 : 0;
  }

  private durationSince(startedAt: number): number {
    const durationMs = performance.now() - startedAt;
    return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
  }

  private afterFirstPaint(
    handlerStartedAt: number,
    callback: (firstPaintMs: number) => void,
  ): void {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        callback(this.durationSince(handlerStartedAt));
      });
    });
  }

  async onPaste(): Promise<void> {
    const handlerStartedAt = performance.now();
    const clipboardReadStartedAt = performance.now();
    const text = await this.clipboard.readForPaste();
    const clipboardReadMs = this.durationSince(clipboardReadStartedAt);
    if (!text || text.trim().length === 0) return;
    const sizeBytes = new Blob([text]).size;
    const parseStartedAt = performance.now();
    const { unescaped, changed } = this.parser.tryUnescape(text);
    const parseMs = this.durationSince(parseStartedAt);
    this.replaceDocument(unescaped);
    this.resetHighlightsForDocumentReplacement();
    // M7p title-suggester: paste replaces the document; any prior
    // file-name association is no longer relevant and the suggestion
    // list (if computed earlier) is now stale.
    this.lastFilename.set(null);
    this.suggestedTitlesForMenu.set([]);
    if (changed) {
      // Pretty-print the newly-unescaped payload so the user sees the real
      // structure rather than a single dense line (per issue #38). Call
      // `formatText` inline instead of `this.onFormat()` so paste does NOT
      // open a Format snackbar on top of the (already-no-snackbar) paste
      // UX. Issue #313 changed `onFormat` to install a pending-undo +
      // snackbar; recursing through it here would leak a stray "Formatted
      // document" snackbar after every paste of an escaped string.
      const formatted = formatText(unescaped, this.prefs.prefs().editorTabSize);
      if (formatted !== unescaped) {
        this.setContent(formatted);
      }
    }

    this.runExtractorOnCurrentContent('paste');
    const syncHandlerMs = this.durationSince(handlerStartedAt);
    this.afterFirstPaint(handlerStartedAt, (firstPaintMs) => {
      const measurements: TelemetryMeasurements = {
        sizeBytes,
        clipboardReadMs,
        parseMs,
        syncHandlerMs,
        firstPaintMs,
      };
      this.logger.event('paste.handle', { sizeBytesBucket: bucketBytes(sizeBytes) }, measurements);
    });
  }

  /**
   * M7p: if the current editor content does not already parse as a JSON
   * object/array, try embedded JSON extraction so the user can promote a
   * JSON block buried inside log lines or prose. Used by both the toolbar
   * Paste path and the file-load path (drag/drop or Upload), since a
   * `.log`/`.txt` file can carry the same mixed-text shape as a paste.
   * The `source` argument is recorded on the candidate signal so the
   * `home.extract.banner.{shown,accept,dismiss}` events can attribute
   * outcomes to the originating surface.
   */
  private runExtractorOnCurrentContent(source: ExtractSource): void {
    const parsed = this.parser.parse(this.content());
    const isObjectOrArray =
      parsed.errors.length === 0 && typeof parsed.value === 'object' && parsed.value !== null;
    if (isObjectOrArray) {
      this.replaceExtractedCandidate(null, null);
      return;
    }
    const extracted = this.extractor.extractFromMixedText(
      this.content(),
      this.prefs.prefs().editorTabSize,
    );
    if (extracted) {
      this.replaceExtractedCandidate(extracted, source);
    } else {
      this.replaceExtractedCandidate(null, null);
    }
  }

  /**
   * Native Monaco paste path. The editor emits the pasted region plus a
   * pre-computed parse outcome for the post-paste buffer. If the full buffer
   * already parses there is nothing to extract; otherwise we run the extractor
   * on the pasted region only (NOT the whole buffer) so that pasting into an
   * existing valid document does not surface unrelated nested blocks.
   */
  onEditorPaste(event: {
    pastedText: string;
    postPasteContent: string;
    postPasteParses: boolean;
  }): void {
    const handlerStartedAt = performance.now();
    const sizeBytes = new Blob([event.pastedText]).size;
    let parseMs = 0;
    if (event.postPasteParses) {
      this.replaceExtractedCandidate(null, null);
    } else {
      const parseStartedAt = performance.now();
      const extracted = this.extractor.extractFromMixedText(
        event.pastedText,
        this.prefs.prefs().editorTabSize,
      );
      parseMs = this.durationSince(parseStartedAt);
      if (extracted) {
        this.replaceExtractedCandidate(extracted, 'editor.paste');
      } else {
        this.replaceExtractedCandidate(null, null);
      }
    }
    const syncHandlerMs = this.durationSince(handlerStartedAt);
    this.afterFirstPaint(handlerStartedAt, (firstPaintMs) => {
      const measurements: TelemetryMeasurements = {
        sizeBytes,
        parseMs,
        syncHandlerMs,
        firstPaintMs,
      };
      this.logger.event(
        'paste.handle.editor',
        { sizeBytesBucket: bucketBytes(sizeBytes) },
        measurements,
      );
    });
  }

  onExtractAccept(): void {
    const candidate = this.extractedCandidate();
    if (!candidate) return;
    // Capture everything into locals BEFORE mutating signals so the
    // fallback branch (and the snackbar's captured closure) never
    // depends on the signal-backed state being non-null.
    const priorText = this.content();
    const candidateText = candidate.data.text;
    const pasteSource = candidate.source;
    const highlightsSnapshot = this.highlights();
    const mutatedPathsAtAccept = new Set(this.mutatedPaths());

    this.logger.event(
      'home.extract.banner.accept',
      { source: pasteSource },
      {
        blockCount: candidate.data.blockCount,
        preservesComments: candidate.data.preservesComments ? 1 : 0,
        hasComments: candidate.data.hasComments ? 1 : 0,
        proseSegments: candidate.data.proseSegments ?? 0,
      },
    );
    // Clear the candidate FIRST so `setContent`'s banner-replace guard
    // does not additionally fire `home.extract.banner.dismiss` with
    // `reason='content.changed'` for the same candidate.
    this.extractedCandidate.set(null);

    // Install pending state BEFORE `applyEdit` so any synchronously-
    // flushed effect that reaches the constructor's content-watch
    // effect sees the snapshot rather than a null pending field.
    this.installPendingReplace({
      priorText,
      startMs: performance.now(),
      undoneViaSnackbar: false,
      kind: 'extract.banner',
      pasteSource,
      highlightsSnapshot,
      mutatedPathsAtAccept,
      // Both the happy and fallback paths bump `viewResetToken` by
      // exactly 1 below; record the post-bump value so the
      // phantom-undo gate in the constructor effect can distinguish
      // a Monaco Ctrl+Z (token unchanged) from a user re-pasting the
      // same `priorText` (token bumped again).
      viewResetTokenAtAccept: this.viewResetToken() + 1,
    });

    const editor = this.editor();
    const applied =
      editor?.applyEdit(0, priorText.length, candidateText, 'jotjson-extract-banner') ?? false;

    if (applied) {
      // `applyEdit` only mutates the Monaco model; mirror the three
      // side-effects `replaceDocument` performs on top of `setContent`
      // so the rest of the app (tree pane, view-reset listeners,
      // highlight reset) sees the same state it would have after a
      // full document swap.
      this.treeFlush$.next();
      this.viewResetToken.update((token) => token + 1);
      this.resetHighlightsForDocumentReplacement();
    } else {
      this.logger.warn('home.extract.banner.applyFailed', {
        reason: editor ? 'applyEditFailed' : 'editorUnavailable',
      });
      // Snapshot-based snackbar Undo still works on this branch
      // (`replaceDocument(priorText)` doesn't depend on Monaco's
      // undo stack), so the snackbar is still opened below to
      // preserve at least one undo affordance even when Monaco-
      // native Ctrl+Z is lost. Precedent: cold-boot clipboard's
      // snackbar-only Undo at home.component.ts cold-boot section.
      this.replaceDocument(candidateText);
      this.resetHighlightsForDocumentReplacement();
    }

    this.openReplaceUndoSnack(
      $localize`:@@home.extract.snackbar.applied:Extracted embedded JSON into the document.`,
      $localize`:@@home.extract.snackbar.undo:Undo`,
    );
  }

  onExtractDismiss(): void {
    const candidate = this.extractedCandidate();
    if (candidate !== null) {
      this.logger.event(
        'home.extract.banner.dismiss',
        { source: candidate.source, reason: 'user.click' },
        {
          blockCount: candidate.data.blockCount,
          proseSegments: candidate.data.proseSegments ?? 0,
        },
      );
    }
    this.extractedCandidate.set(null);
  }

  onUploadErrorDismiss(): void {
    this.uploadError.set(null);
  }

  async onCopy(): Promise<void> {
    const text = this.content();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard unavailable / denied - graceful fallback: user can still Ctrl+C.
    }
  }

  /**
   * Copies the editor contents as a JSON-string-literal encoding - i.e. what
   * `JSON.stringify(content)` returns. The resulting clipboard value can be
   * pasted directly into another JSON document as a string value and later
   * round-tripped by onPaste's auto-unescape. Bound to Alt+click on the
   * toolbar Copy button (issue #38).
   */
  async onCopyEscaped(): Promise<void> {
    const text = this.content();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(this.parser.escapeAsJsonString(text));
    } catch {
      // Clipboard unavailable / denied - no fallback beyond raw Ctrl+C.
    }
  }

  ngOnInit(): void {
    this.disposeDropHandler = this.dropController.registerEditorHandler((files, handles) => {
      void this.onFilesReceived(files, 'drag', handles);
    });
    this.disposeLaunchHandler = this.launchQueueController.registerHandler(async (event) => {
      if (event.kind === 'error') {
        this.snack.open(
          $localize`:@@home.osLaunch.error.unreadable:Could not open the file.`,
          $localize`:@@common.dismiss:Dismiss`,
          { duration: 6000 },
        );
        return;
      }
      const files = event.entries.map((entry) => entry.file);
      const handles = event.entries.map((entry) => entry.handle);
      await this.onFilesReceived(files, 'osLaunch', handles);
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.disposeDropHandler?.();
    this.disposeDropHandler = undefined;
    this.disposeLaunchHandler?.();
    this.disposeLaunchHandler = undefined;
  }

  async onUpload(file: File): Promise<void> {
    // Phase 3: toolbar Upload still goes through `<input type="file">`
    // which yields a `File` without a writable handle. Phase 4 upgrades
    // the toolbar Upload click to `showOpenFilePicker({mode:
    // 'readwrite'})` on Chromium so the picker path also produces a
    // file-backed `DocumentBacking` variant (see `onLocalFilePicked`).
    // This handler covers the Safari/Firefox fallback path and any
    // future surface that delivers a bare `File`. Pass `[null]` for
    // handles so the unified `onFilesReceived` path can still gate on
    // the handle availability.
    await this.onFilesReceived([file], 'pick', [null]);
  }

  /**
   * Toolbar emits this when the Chromium `showOpenFilePicker` resolved
   * with `{ file, handle }`. Routes through the same
   * `onFilesReceived` pipeline as drag-drop / osLaunch / legacy
   * upload, but with a non-null handle slot so the document binds to
   * the `'file'` DocumentBacking variant.
   */
  async onLocalFilePicked(picked: { file: File; handle: FileSystemFileHandle }): Promise<void> {
    await this.onFilesReceived([picked.file], 'pick', [picked.handle]);
  }

  /**
   * Opens the {@link SaveAsBlobDialogComponent} to create a cloud copy
   * of the current file-backed document. The local file binding is
   * preserved (fire-and-forget semantics per skeptic v2 #6 + plan v2
   * user decision): subsequent Save still writes the file; subsequent
   * Save-as-blob creates another new cloud copy.
   *
   * Only reachable from the toolbar overflow when the document is
   * file-backed AND the user is signed in. Defensive checks guard
   * against accidental invocation outside that gate.
   */
  async onSaveAsBlob(): Promise<void> {
    const backing = this._documentBacking();
    if (backing.kind !== 'file') return;
    const user = this.auth.user();
    if (!user) return;
    if (this.saveInFlight()) return;

    const parsed = this.parseResult();
    const data: SaveAsBlobDialogData = {
      initialTitle: this.suggestedBlobTitleForFile(backing.filename),
      jsonText: this.content(),
      parsed: parsed.empty ? undefined : parsed.value,
      hasParseErrors: parsed.errors.length > 0,
      filename: backing.filename,
    };
    const dialogRef = this.dialog.open<
      SaveAsBlobDialogComponent,
      SaveAsBlobDialogData,
      SaveAsBlobDialogResult | undefined
    >(SaveAsBlobDialogComponent, {
      data,
      width: '480px',
      autoFocus: 'first-tabbable',
    });
    const result = await firstValueFrom(dialogRef.afterClosed());
    if (!result) return; // user cancelled

    this.saveInFlight.set(true);
    this.saveError.set(null);
    const submittedContent = this.content();
    const submittedHighlights = this.pruneHighlightsForSave(submittedContent, this.highlights());
    try {
      const created = await firstValueFrom(
        this.blobs.create(submittedContent, result.title, [...submittedHighlights]),
      );
      this.logger.event('share.created', undefined, {
        sizeBytes: new Blob([submittedContent]).size,
      });
      const { autoDeleted, ...blob } = created;
      // Fire-and-forget: do NOT transition documentBacking. The
      // local file remains the primary save target. Surface a
      // snackbar so the user knows the cloud copy succeeded; the
      // snackbar's action navigates to the new blob's share URL in
      // a new tab so the user does not lose their file-backed
      // editing context.
      const ref = this.snack.open(
        $localize`:@@home.saveAsBlob.success:Cloud copy created.`,
        $localize`:@@home.saveAsBlob.openAction:Open`,
        { duration: 8000 },
      );
      if (ref) {
        ref
          .onAction()
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe(() => {
            // Open the share URL in a new tab so the file-backed
            // editing session in this tab is preserved.
            window.open(`/s/${blob.slug}`, '_blank', 'noopener');
          });
      }
      if (autoDeleted) {
        void this.quota.notifyAutoDeleted(autoDeleted);
      }
    } catch (error) {
      const httpError = error as { status?: number; error?: { code?: string } };
      if (httpError.status === 409 && httpError.error?.code === 'quota_exceeded') {
        void this.quota.notifyQuotaExceededManual();
        this.snack.open(
          $localize`:@@save.error.quotaExceeded:Blob limit reached - delete one from your saved blobs to save a new blob.`,
          $localize`:@@common.dismiss:Dismiss`,
          { duration: 6000 },
        );
      } else {
        const message = this.formatSaveError(error);
        this.snack.open(message, $localize`:@@common.dismiss:Dismiss`, { duration: 6000 });
      }
      this.logger.warn('home.save.failed');
    } finally {
      this.saveInFlight.set(false);
    }
  }

  /**
   * Compose a sensible seed title for the SaveAsBlobDialog when the
   * source is a file-backed document. Strips the file extension from
   * the filename (the cloud blob's title is a freeform string, not a
   * filename, so the `.json` suffix is noise) and trims whitespace.
   * Falls back to the current document title or 'Untitled'.
   */
  private suggestedBlobTitleForFile(filename: string): string {
    const cleaned = filename.replace(/\.(json|jsonc|json5|geojson|jsonl|webmanifest)$/i, '').trim();
    if (cleaned.length > 0) return cleaned;
    const fromTitle = this.title().trim();
    if (fromTitle.length > 0) return fromTitle;
    return $localize`:@@app.title.untitled:Untitled`;
  }

  private async onFilesReceived(
    files: readonly File[],
    source: FileIngressSource,
    handles?: readonly (FileSystemFileHandle | null)[],
  ): Promise<void> {
    const adoptedHandle = handles?.[0] ?? null;
    const handlerStartedAt = performance.now();
    const fileReadStartedAt = performance.now();
    const result = await validateAndReadSingleFile(files);
    const fileReadMs = this.durationSince(fileReadStartedAt);
    switch (result.kind) {
      case 'ok': {
        const filename = files[0]?.name ?? 'file';
        const sizeBytes = files[0]?.size ?? new Blob([result.text]).size;
        const lastModifiedAtAttach = files[0]?.lastModified ?? Date.now();
        const parseStartedAt = performance.now();
        const { unescaped } = this.parser.tryUnescape(result.text);
        const parseMs = this.durationSince(parseStartedAt);
        // Text-no-op short-circuit: when uploaded content matches the
        // current editor content (regardless of filename), there is
        // nothing to undo. Skip the pending-undo install + snackbar so
        // a snackbar Undo click does not emit a spurious
        // `home.upload.undo` event for a content-no-op (issue #313 PR
        // review). Still set `lastFilename` so filename-only changes
        // (e.g., user renamed `data.json` to `data-copy.json` and
        // re-dragged) propagate; still run the extractor in case
        // filename-driven heuristics depend on it.
        const priorText = this.content();
        if (unescaped === priorText) {
          this.suggestedTitlesForMenu.set([]);
          this.lastFilename.set(filename);
          this.runExtractorOnCurrentContent(FILE_INGRESS_TO_EXTRACT_SOURCE[source]);
        } else {
          // Capture the full pre-upload side-state for snackbar Undo /
          // Ctrl+Z. Six fields mutated by the happy path:
          // `lastFilename`, `highlights`, `mutatedPaths`,
          // `suggestedTitlesForMenu`, `extractedCandidate`,
          // `uploadError`. The first four are touched in-line below;
          // the latter two are touched by `runExtractorOnCurrentContent`
          // / the inline `uploadError.set(...)`.
          const priorLastFilename = this.lastFilename();
          const priorHighlights = this.highlights();
          const priorMutatedPaths = this.mutatedPaths();
          const priorSuggestedTitles = this.suggestedTitlesForMenu();
          const priorExtractedCandidate = this.extractedCandidate();
          const priorUploadError = this.uploadError();
          this.installPendingReplace({
            priorText,
            startMs: performance.now(),
            undoneViaSnackbar: false,
            kind: 'upload',
            priorLastFilename,
            priorHighlights,
            priorMutatedPaths,
            priorSuggestedTitles,
            priorExtractedCandidate,
            priorUploadError,
            uploadTrigger: FILE_INGRESS_TO_UNDO_TRIGGER[source],
            // `applyReplaceWithFallback` bumps `viewResetToken` (either
            // via `replaceAll`'s mirror at line 1672 or the legacy
            // `setContent`+token bump fallback). Record the post-bump
            // value so the phantom-undo gate distinguishes Ctrl+Z
            // (token unchanged) from a user re-uploading the same
            // file (token bumped again).
            viewResetTokenAtAccept: this.viewResetToken() + 1,
          });
          this.applyReplaceWithFallback(unescaped, 'jotjson-upload', 'upload');
          this.resetHighlightsForDocumentReplacement();
          this.lastFilename.set(filename);
          this.suggestedTitlesForMenu.set([]);
          this.runExtractorOnCurrentContent(FILE_INGRESS_TO_EXTRACT_SOURCE[source]);
          this.openReplaceUndoSnack(
            source === 'osLaunch'
              ? $localize`:@@home.osLaunch.snackbar.opened:Opened ${this.formatFilenameForSnack(filename)}:filename:.`
              : $localize`:@@home.upload.snackbar.uploaded:Uploaded ${this.formatFilenameForSnack(filename)}:filename:.`,
            $localize`:@@home.upload.snackbar.undo:Undo`,
          );
        }
        // When the adoption path delivered a writable handle (osLaunch
        // today; Chromium picker + drag-drop after Phase 4), bind the
        // document to it via the `'file'` DocumentBacking variant.
        // The handle is attached AFTER the editor content has been
        // applied + the pending-undo snapshot has been installed, so
        // Undo can restore the prior backing (draft or blob) without
        // racing the editor's content-watch effect. The savedSnapshot
        // is the just-loaded file content; file-backed dirty is
        // content-only (see `dirty` computed) so highlights/title
        // are ignored downstream.
        if (adoptedHandle !== null) {
          this._documentBacking.set({
            kind: 'file',
            handle: adoptedHandle,
            filename,
            lastModifiedAtAttach,
            savedSnapshot: {
              content: unescaped,
              title: this.title(),
              highlights: this.highlights(),
            },
          });
          this.logger.event(
            'file.adoptHandle',
            { source, sizeBytesBucket: bucketBytes(sizeBytes) },
            { sizeBytes },
          );
        }
        // Surface upload-source validation errors as a persistent in-pane
        // banner (issue #36, spec §294). parseResult() shares its memoized
        // parse with the editor's render path, so this is not an extra
        // parse on top of the existing reactive flow. When the M7p extract
        // banner is offering a fix we suppress the upload-error banner
        // (#62 follow-up): the extract banner is the more actionable
        // surface, so showing both is redundant. If the user dismisses or
        // rejects the extraction, they have implicitly chosen to keep the
        // raw text and the inline validation errors remain visible.
        const parsed = this.parseResult();
        const hasErrors = !parsed.empty && parsed.errors.length > 0;
        if (hasErrors && !this.extractBannerVisible()) {
          this.uploadError.set({ filename });
        } else {
          this.uploadError.set(null);
        }
        const syncHandlerMs = this.durationSince(handlerStartedAt);
        this.afterFirstPaint(handlerStartedAt, (firstPaintMs) => {
          const measurements: TelemetryMeasurements = {
            sizeBytes,
            fileReadMs,
            parseMs,
            syncHandlerMs,
            firstPaintMs,
          };
          this.logger.event(
            'upload.handle',
            { sizeBytesBucket: bucketBytes(sizeBytes), source },
            measurements,
          );
        });
        return;
      }
      case 'empty':
        return;
      case 'tooMany':
        this.snack.open(
          $localize`:@@home.upload.error.tooMany:Please drop one file at a time.`,
          $localize`:@@common.dismiss:Dismiss`,
          { duration: 4000 },
        );
        return;
      case 'tooLarge':
        this.logger.warn('home.upload.tooLarge', {
          sizeBytes: result.sizeBytes,
        });
        // Adoption telemetry: if the user opened a file via a handle-
        // bearing path (osLaunch / picker / drag-drop on Chromium),
        // the writable handle is dropped here. Fire `file.save.failed`
        // so dashboards can see "writable adoption attempted but
        // validator rejected the content" distinct from save-time
        // failures. The user-facing snackbar below is unchanged.
        if (adoptedHandle !== null) {
          this.logger.warn('file.save.failed', { cause: 'tooLarge' });
        }
        this.snack.open(
          $localize`:@@home.upload.error.tooLarge:File too large - max 5 MB`,
          $localize`:@@common.dismiss:Dismiss`,
          { duration: 4000 },
        );
        return;
      case 'binary':
        this.logger.info('home.upload.binary', { filename: result.filename });
        if (adoptedHandle !== null) {
          this.logger.warn('file.save.failed', { cause: 'binary' });
        }
        this.snack.open(
          $localize`:@@home.upload.error.binary:File does not appear to be a text file - upload was ignored.`,
          $localize`:@@common.dismiss:Dismiss`,
          { duration: 4000 },
        );
        return;
      case 'readFailed':
        this.logger.warn('home.upload.readFailed', {
          cause: String(result.cause),
        });
        this.snack.open(
          $localize`:@@home.upload.error.readFailed:Could not read file`,
          $localize`:@@common.dismiss:Dismiss`,
          { duration: 4000 },
        );
        return;
    }
  }

  onDownload(): void {
    const text = this.content();
    const ext = this.mode() === 'jsonc' ? 'jsonc' : 'json';
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `jotjson-untitled.${ext}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  onClear(): void {
    this.replaceDocument('');
    this.title.set('');
    this.resetLoadedBlobState();
    this.lastFilename.set(null);
    this.suggestedTitlesForMenu.set([]);
    // Clear the draft synchronously. The `content` -> draft effect is async
    // and may be cancelled when this component is destroyed by the
    // subsequent router.navigate below, leaving stale blob content in the
    // draft that the next HomeComponent would re-read on mount.
    this.draft.set('');
    if (this.router.url !== '/') {
      void this.router.navigate(['/']);
    }
  }

  onTitleChange(next: string): void {
    this.title.set(next);
  }

  /**
   * Title-suggester wand-button click (M7p). Computes candidates
   * synchronously using the already-memoized `parseResult` (no
   * double-parse) plus the last-known filename, and writes them into
   * `suggestedTitlesForMenu` so the toolbar's mat-menu can paint them
   * on the same click. Service intentionally has no async hop --
   * the mat-menu opens immediately after this handler returns.
   */
  onSuggestRequested(): void {
    const parsed = this.parseResult();
    const result = this.titleSuggester.suggest({
      jsonText: this.content(),
      parsed: parsed.empty ? undefined : parsed.value,
      hasParseErrors: parsed.errors.length > 0,
      filename: this.lastFilename(),
    });
    this.suggestedTitlesForMenu.set(result);
  }

  onSignInRequested(): void {
    const snapshot: SignInRestoreSnapshot = {
      slug: this.loadedBlob()?.slug ?? null,
      content: this.content(),
      title: this.title(),
    };

    try {
      sessionStorage.setItem(SIGN_IN_RESTORE_KEY, JSON.stringify(snapshot));
    } catch {
      // Storage can be disabled; sign-in should still proceed.
    }

    this.auth.signIn();
  }

  private restoreSignInSnapshotOnce(): void {
    if (this.signInRestoreAttempted) return;
    this.signInRestoreAttempted = true;

    try {
      const serializedSnapshot = sessionStorage.getItem(SIGN_IN_RESTORE_KEY);
      if (serializedSnapshot === null) return;

      const parsedSnapshot: unknown = JSON.parse(serializedSnapshot);
      if (!isSignInRestoreSnapshot(parsedSnapshot)) {
        this.clearSignInRestoreSnapshot();
        return;
      }

      if (parsedSnapshot.slug === (this.loadedBlob()?.slug ?? null)) {
        this.replaceDocument(parsedSnapshot.content);
        this.title.set(parsedSnapshot.title);
        // M7p: snapshot-restore replaces the document; any prior
        // file-name association predates the round-trip and is gone.
        this.lastFilename.set(null);
        this.suggestedTitlesForMenu.set([]);
      }
      this.clearSignInRestoreSnapshot();
    } catch {
      this.clearSignInRestoreSnapshot();
    }
  }

  private clearSignInRestoreSnapshot(): void {
    try {
      sessionStorage.removeItem(SIGN_IN_RESTORE_KEY);
    } catch {
      // Ignore disabled-storage errors.
    }
  }

  /**
   * Save the current editor contents. Branches on `documentBacking().kind`:
   *
   * - **`'file'`**: write to the bound `FileSystemFileHandle` via
   *   `FileAccessService.saveToFile`. No cloud auth required. Permission
   *   is re-checked inside the Save click gesture (deferred-at-save path
   *   for osLaunch adoptions whose original OS click was consumed by the
   *   browser; the picker / drag-drop paths already obtained readwrite
   *   permission at adoption time but this guard catches mid-session
   *   revocations too). On failure, surfaces a localized snackbar; for
   *   `'permissionDeniedRevoked'` / `'permissionDeniedInitial'` the
   *   snackbar includes a "Save as new file..." action so the user is
   *   never stuck in a permission cul-de-sac.
   * - **`'blob'` (owned)**: PUT in place at the existing slug.
   * - **`'blob'` (unowned) / `'draft'`**: POST a new blob (fork or create).
   *
   * Returns early when `canSave()` is false or a save is already in
   * flight. The `saveInFlight` flag gates both this method and
   * `onSaveAsNewFile` so a double-click or rapid Save-then-Save-As
   * cannot race two writables.
   */
  async onSave(): Promise<void> {
    if (!this.canSave() || this.saveInFlight()) return;

    const backing = this._documentBacking();

    if (backing.kind === 'file') {
      await this.onSaveToFile(backing);
      return;
    }

    // Blob / draft path: requires a signed-in user.
    const user = this.auth.user();
    if (!user) return;

    this.saveInFlight.set(true);
    this.saveError.set(null);

    const existing = backing.kind === 'blob' ? backing.blob : null;
    const submitted = this.currentSnapshot();
    const trimmedTitle = submitted.title.trim();
    const titlePatch = trimmedTitle.length > 0 ? trimmedTitle : undefined;
    const highlights = this.pruneHighlightsForSave(submitted.content, submitted.highlights);

    try {
      if (existing && existing.ownerId === user.id) {
        const updated = await new Promise<JsonBlob>((resolve, reject) => {
          this.blobs
            .update(existing.id, {
              content: submitted.content,
              title: titlePatch,
              highlights: [...highlights],
            })
            .subscribe({ next: resolve, error: reject });
        });
        this.applySavedBlobResponse(updated, submitted);
      } else {
        const created = await new Promise<CreateBlobResponse>((resolve, reject) => {
          this.blobs
            .create(submitted.content, titlePatch, [...highlights])
            .subscribe({ next: resolve, error: reject });
        });
        this.logger.event('share.created', undefined, {
          sizeBytes: new Blob([submitted.content]).size,
        });
        // Strip the auxiliary quota marker before we treat it as a JsonBlob
        // so loadedBlob stays clean.
        const { autoDeleted, ...blob } = created;
        this.applySavedBlobResponse(blob, submitted);
        void this.router.navigate(['/s', blob.slug]);
        if (autoDeleted) {
          void this.quota.notifyAutoDeleted(autoDeleted);
        }
      }
    } catch (error) {
      const httpError = error as { status?: number; error?: { code?: string } };
      if (httpError.status === 412) {
        return;
      }
      if (httpError.status === 409 && httpError.error?.code === 'quota_exceeded') {
        void this.quota.notifyQuotaExceededManual();
        this.saveError.set(
          $localize`:@@save.error.quotaExceeded:Blob limit reached - delete one from your saved blobs to save a new blob.`,
        );
        return;
      }
      const message = this.formatSaveError(error);
      this.saveError.set(message);
      this.logger.warn('home.save.failed');
      void error;
    } finally {
      this.saveInFlight.set(false);
    }
  }

  /**
   * File-backed save branch. Extracted from {@link onSave} to keep the
   * 3-branch switch readable and so unit tests can exercise the file
   * path in isolation without provisioning a fake `BlobService`.
   */
  private async onSaveToFile(backing: Extract<DocumentBacking, { kind: 'file' }>): Promise<void> {
    this.saveInFlight.set(true);
    this.saveError.set(null);
    const text = this.content();
    const startedAt = performance.now();
    try {
      // Re-check (or first-prompt) write permission inside the Save
      // gesture. For picker / drag-drop adoptions this typically
      // short-circuits to 'granted'; for osLaunch it surfaces the
      // Chromium first-time prompt; for any path it catches a
      // mid-session revocation as 'denied'.
      const permission = await this.fileAccess.requestWritePermission(backing.handle);
      if (permission !== 'granted') {
        this.openFileSaveFailureSnackbar('permissionDeniedInitial');
        return;
      }
      const { lastModified } = await this.fileAccess.saveToFile(backing.handle, text);
      const durationMs = performance.now() - startedAt;
      const sizeBytes = new Blob([text]).size;
      this.logger.event(
        'file.save.success',
        { kind: 'overwrite', sizeBytesBucket: bucketBytes(sizeBytes) },
        { sizeBytes, durationMs },
      );
      // Refresh the saved snapshot to mark the document clean.
      // File-backed dirty is content-only, so only `content` matters,
      // but the shape carries title + highlights too for uniformity
      // with the other variants.
      this._documentBacking.set({
        kind: 'file',
        handle: backing.handle,
        filename: backing.filename,
        lastModifiedAtAttach: lastModified,
        savedSnapshot: {
          content: text,
          title: this.title(),
          highlights: this.highlights(),
        },
      });
    } catch (cause) {
      const kind: FileAccessFailureCause =
        cause instanceof FileAccessError ? cause.kind : 'writeError';
      this.openFileSaveFailureSnackbar(kind);
    } finally {
      this.saveInFlight.set(false);
    }
  }

  /**
   * Save the current document to a new local file chosen by the user.
   * Opens `showSaveFilePicker` (Chromium only), writes the content to
   * the chosen handle, and replaces the document backing with the new
   * file. Gated by `saveInFlight` so this cannot race with the
   * primary {@link onSave}.
   *
   * When the user cancels the picker, this is a no-op (no error, no
   * snackbar, no telemetry). When the picker resolves but the write
   * fails, surfaces the same failure-snackbar branch as
   * {@link onSave} for the file-backed path.
   */
  async onSaveAsNewFile(): Promise<void> {
    if (this.saveInFlight()) return;
    if (!this.fileAccess.hasFileSystemAccess()) {
      // Should never reach here because the toolbar overflow item is
      // gated on `hasFileSystemAccess`. Defensive fallback only.
      this.logger.info('file.openPicker.unsupported');
      return;
    }
    this.saveInFlight.set(true);
    this.saveError.set(null);
    const text = this.content();
    const startedAt = performance.now();
    const suggestedName = this.suggestedFilenameForSaveAs();
    try {
      const result = await this.fileAccess.saveAsNewFile(text, suggestedName);
      if (result === null) {
        // User-cancelled the picker. No-op.
        return;
      }
      const durationMs = performance.now() - startedAt;
      const sizeBytes = new Blob([text]).size;
      this.logger.event(
        'file.save.success',
        { kind: 'saveAs', sizeBytesBucket: bucketBytes(sizeBytes) },
        { sizeBytes, durationMs },
      );
      this._documentBacking.set({
        kind: 'file',
        handle: result.handle,
        filename: result.file.name,
        lastModifiedAtAttach: result.lastModified,
        savedSnapshot: {
          content: text,
          title: this.title(),
          highlights: this.highlights(),
        },
      });
      this.lastFilename.set(result.file.name);
    } catch (cause) {
      const kind: FileAccessFailureCause =
        cause instanceof FileAccessError ? cause.kind : 'writeError';
      this.openFileSaveFailureSnackbar(kind);
    } finally {
      this.saveInFlight.set(false);
    }
  }

  /**
   * Compose a suggested filename for `showSaveFilePicker`. Prefers
   * the current `lastFilename` (covers Save-As of an already-named
   * file), then a title-derived name, then a default. The picker UI
   * appends the file extension based on the manifest's accept dict.
   */
  private suggestedFilenameForSaveAs(): string {
    const fromLast = this.lastFilename();
    if (fromLast !== null && fromLast.length > 0) return fromLast;
    const fromTitle = this.title().trim();
    if (fromTitle.length > 0) {
      // Strip characters that would be invalid in a filename on
      // Windows / macOS / Linux. Keep it conservative; the picker UI
      // accepts a wider set but the suggested name should be safe.
      return fromTitle.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 100) + '.json';
    }
    return 'untitled.json';
  }

  /**
   * Open the file-save failure snackbar with a "Save as new file..."
   * action button for the permission-denied causes (skeptic v2 #4
   * cul-de-sac fix). Other causes show a dismiss-only snackbar.
   * Always fires `file.save.failed` telemetry with the closed-enum
   * cause.
   */
  private openFileSaveFailureSnackbar(cause: FileSaveFailureCause): void {
    this.logger.warn('file.save.failed', { cause });
    const message = this.formatFileSaveFailureMessage(cause);
    const offersSaveAs =
      cause === 'permissionDeniedInitial' ||
      cause === 'permissionDeniedRevoked' ||
      cause === 'notFound';
    if (offersSaveAs) {
      const ref = this.snack.open(
        message,
        $localize`:@@home.fileSave.action.saveAs:Save as new file...`,
        { duration: 8000, politeness: 'assertive' },
      );
      // Test environments may stub `MatSnackBar.open` as a vi.fn() that
      // returns undefined; the warn-trace + `file.save.failed` event
      // still fire and the failure is logged, but the action chain is
      // skipped (no Undo to subscribe to). Matches the defensive shape
      // in `openReplaceUndoSnack`.
      if (!ref) return;
      ref
        .onAction()
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => {
          void this.onSaveAsNewFile();
        });
      return;
    }
    this.snack.open(message, $localize`:@@common.dismiss:Dismiss`, { duration: 6000 });
  }

  private formatFileSaveFailureMessage(cause: FileSaveFailureCause): string {
    switch (cause) {
      case 'permissionDeniedInitial':
        return $localize`:@@home.fileSave.error.permissionDeniedInitial:Permission to write the file was denied.`;
      case 'permissionDeniedRevoked':
        return $localize`:@@home.fileSave.error.permissionDeniedRevoked:Permission to write the file was revoked.`;
      case 'notFound':
        return $localize`:@@home.fileSave.error.notFound:The file is no longer available on disk.`;
      case 'diskFull':
        return $localize`:@@home.fileSave.error.diskFull:Not enough disk space to save the file.`;
      case 'aborted':
        return $localize`:@@home.fileSave.error.aborted:Save was interrupted - please try again.`;
      case 'tooLarge':
        return $localize`:@@home.fileSave.error.tooLarge:File too large - max 5 MB`;
      case 'binary':
        return $localize`:@@home.fileSave.error.binary:Binary content cannot be saved as text.`;
      case 'noHandle':
        return $localize`:@@home.fileSave.error.noHandle:No file is currently bound to this document.`;
      case 'unsupportedBrowser':
        return $localize`:@@home.fileSave.error.unsupportedBrowser:Saving local files is not supported in this browser.`;
      case 'writeError':
        return $localize`:@@home.fileSave.error.writeError:Could not save the file - please try again.`;
    }
  }

  private formatSaveError(error: unknown): string {
    const httpError = error as { status?: number; error?: { error?: string } };
    const body = httpError.error?.error;
    if (body) return body;
    if (httpError.status === 401) {
      return $localize`:@@save.error.signIn:Please sign in to save`;
    }
    if (httpError.status === 403) {
      return $localize`:@@save.error.forbidden:You do not own this blob`;
    }
    return $localize`:@@save.error.generic:Could not save - please try again`;
  }

  onFormat(): void {
    const text = this.content();
    if (!text) return;
    const next = formatText(text, this.prefs.prefs().editorTabSize);
    if (next === text) return;
    this.installPendingReplace({
      priorText: text,
      startMs: performance.now(),
      undoneViaSnackbar: false,
      kind: 'format',
      // Format doesn't bump `viewResetToken` (matches today's pre-#313
      // behavior - whitespace changes preserve tree structure). The
      // gate in the constructor effect therefore expects the same
      // token at undo time as at install time; capturing the current
      // value makes the gate a no-op for Format (same precedent as
      // `extract.tree`). Phantom-undo via user typing the same text
      // back is theoretically possible here but practically astronomical.
      viewResetTokenAtAccept: this.viewResetToken(),
    });
    this.applyReplaceWithFallback(next, 'jotjson-format', 'format');
    this.openReplaceUndoSnack(
      $localize`:@@home.format.snackbar.applied:Formatted document.`,
      $localize`:@@home.format.snackbar.undo:Undo`,
    );
  }

  onMinify(): void {
    const parsed = this.parseResult();
    if (parsed.empty || parsed.errors.length > 0) return;
    let next: string;
    try {
      next = JSON.stringify(parsed.value);
    } catch {
      return;
    }
    const text = this.content();
    const priorMode = this.mode();
    // No-op short-circuit: already-minified content + already-JSON mode
    // means no observable change. Skip the pending-undo install so a
    // Ctrl+Z does not accidentally consume a stale snackbar.
    if (next === text && priorMode === 'json') return;
    this.installPendingReplace({
      priorText: text,
      startMs: performance.now(),
      undoneViaSnackbar: false,
      kind: 'minify',
      priorMode,
      // Minify doesn't bump `viewResetToken` (same view-preservation
      // rationale as Format); capture current value so the gate is a
      // no-op for this kind.
      viewResetTokenAtAccept: this.viewResetToken(),
    });
    this.applyReplaceWithFallback(next, 'jotjson-minify', 'minify');
    // Minified output has no comments -> switch back to JSON mode.
    this.mode.set('json');
    this.openReplaceUndoSnack(
      $localize`:@@home.minify.snackbar.applied:Minified document.`,
      $localize`:@@home.minify.snackbar.undo:Undo`,
    );
  }

  onSort(): void {
    const text = this.content();
    if (!text) return;
    const parsed = this.parseResult();
    if (parsed.empty || parsed.errors.length > 0) return;

    let result: SortDocumentResult;
    try {
      result = patchSortKeysDeep(text);
    } catch {
      // 'sort.patch.parse-failed' -> silent no-op (matches today's
      // parse-error gate; we also gated above on parsed.errors).
      return;
    }
    if (!result.changed) return;

    const priorMode = this.mode();
    const rootKeyCount =
      isRecord(parsed.value) && !Array.isArray(parsed.value) ? Object.keys(parsed.value).length : 0;
    this.logger.event('home.sort.click', { keyCountBucket: bucketCount(rootKeyCount) });
    this.installPendingReplace({
      priorText: text,
      startMs: performance.now(),
      undoneViaSnackbar: false,
      kind: 'sort.toolbar',
      priorMode,
      viewResetTokenAtAccept: this.viewResetToken(),
    });
    this.applyReplaceWithFallback(result.patched, 'jotjson-sort', 'sort');
    // No explicit mode.set('json'). The detectMode effect at lines ~983-989
    // re-derives mode from the patched content, which preserves comments
    // when they survive Sort (so JSONC stays JSONC if any comment survives).
    this.openReplaceUndoSnack(
      $localize`:@@home.sort.snackbar.applied:Sorted keys.`,
      $localize`:@@home.sort.snackbar.undo:Undo`,
    );
  }

  /**
   * Translates a 4-state `PaneLayout` segment selection from the
   * toolbar back into the two underlying preferences:
   *  - `editor-only` / `tree-only` set `paneVisibility` and leave
   *    `layoutOrientation` untouched (so it is restored when the
   *    user returns to a `both-*` segment).
   *  - `both-horizontal` / `both-vertical` set `paneVisibility` to
   *    `'both'` AND set `layoutOrientation` to the matching value.
   *
   * `splitRatio` is not touched here. While `paneVisibility !==
   * 'both'`, `splitStyle` ignores the ratio and renders a single
   * `1fr` track, which means the persisted ratio survives the
   * round-trip and is restored automatically.
   */
  onPaneLayoutChange(next: PaneLayout): void {
    switch (next) {
      case 'editor-only':
        this.paneVisibility.set('editor-only');
        return;
      case 'tree-only':
        this.paneVisibility.set('tree-only');
        return;
      case 'both-horizontal':
        this.paneVisibility.set('both');
        if (this.prefs.prefs().layoutOrientation !== 'horizontal') {
          this.prefs.update({ layoutOrientation: 'horizontal' });
        }
        return;
      case 'both-vertical':
        this.paneVisibility.set('both');
        if (this.prefs.prefs().layoutOrientation !== 'vertical') {
          this.prefs.update({ layoutOrientation: 'vertical' });
        }
        return;
    }
  }

  onToggleTheme(): void {
    // Three-state cycle driven by the raw preference: light -> dark -> system.
    // 'system' follows the OS's prefers-color-scheme setting.
    const current = this.prefs.prefs().theme;
    const next = current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light';
    this.prefs.update({ theme: next });
  }

  onCopyShareLink(): void {
    const blob = this.loadedBlob();
    if (!blob) return;
    const url = `${window.location.origin}/s/${blob.slug}`;
    void this.clipboardCopy.copyWithToast(url, {
      success: $localize`:@@share.copyLink.success:Share link copied to clipboard.`,
      failed: $localize`:@@share.copyLink.failed:Failed to copy share link.`,
      unsupported: $localize`:@@share.copyLink.unsupported:Copy is not supported in this browser.`,
    });
  }

  async onDeleteBlob(): Promise<void> {
    const blob = this.loadedBlob();
    if (!blob) return;
    const user = this.auth.user();
    if (!user || user.id !== blob.ownerId) return;

    const label = blob.title?.trim() || blob.slug;
    const data: ConfirmDialogData = {
      title: $localize`:@@share.delete.title:Delete this blob?`,
      message: $localize`:@@share.delete.message:"${label}:name:" will be permanently deleted. This cannot be undone.`,
      confirmLabel: $localize`:@@share.delete.confirm:Delete`,
      cancelLabel: $localize`:@@common.cancel:Cancel`,
      destructive: true,
    };
    const ref = this.dialog.open<ConfirmDialogComponent, ConfirmDialogData, boolean>(
      ConfirmDialogComponent,
      { data, width: '420px', autoFocus: 'dialog' },
    );
    const confirmed = await firstValueFrom(ref.afterClosed());
    if (!confirmed) return;

    try {
      await firstValueFrom(this.blobs.delete(blob.id));
      this.replaceDocument('');
      this.title.set('');
      this.resetLoadedBlobState();
      this.lastFilename.set(null);
      this.suggestedTitlesForMenu.set([]);
      this.snack.open(
        $localize`:@@share.delete.success:Blob deleted.`,
        $localize`:@@common.dismiss:Dismiss`,
        { duration: 3000 },
      );
      await this.router.navigate(['/']);
      this.scheduleFocusAfterDelete();
    } catch (error) {
      this.logger.warn('share.delete.failed');
      void error;
      this.snack.open(
        $localize`:@@share.delete.failed:Failed to delete blob.`,
        $localize`:@@common.dismiss:Dismiss`,
        { duration: 4000 },
      );
    }
  }

  private scheduleFocusAfterDelete(): void {
    setTimeout(() => this.homeFocusFallback()?.nativeElement.focus(), 0);
  }

  focusTreeSearch(): void {
    const host = this.treeHost()?.nativeElement;
    const input = host?.querySelector<HTMLInputElement>('.tree-search');
    input?.focus();
    input?.select();
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(ev: KeyboardEvent): void {
    // Ctrl+Shift+] / Ctrl+Shift+[ - expand/collapse all
    if (ev.ctrlKey && ev.shiftKey && (ev.key === ']' || ev.key === '[')) {
      const tree = this.tree();
      if (!tree) return;
      ev.preventDefault();
      if (ev.key === ']') tree.expandAll();
      else tree.collapseAll();
      return;
    }

    // Alt+1..9 - expand to level N (uses Alt to avoid browser tab shortcuts per spec)
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey && /^[1-9]$/.test(ev.key)) {
      const tree = this.tree();
      if (tree) {
        ev.preventDefault();
        tree.expandToLevel(Number(ev.key));
      }
      return;
    }

    // Ctrl+F when focus is NOT in the editor -> focus tree search. When in the
    // editor, Monaco's native find runs. When the tree pane is hidden via the
    // 3-state pane visibility toggle (issue #39) or by the M7l narrow-viewport
    // override we skip the routing rather than focusing a `display:none`
    // input - the keypress falls through to the browser default. Reads
    // *effective* visibility so the narrow-viewport collapse is honored.
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'f') {
      const active = document.activeElement;
      const inEditor = active?.closest('.monaco-editor') != null;
      const treeHidden = this.effectivePaneVisibility() === 'editor-only';
      if (!inEditor && !treeHidden) {
        ev.preventDefault();
        this.focusTreeSearch();
      }
    }
  }

  private detectMode(text: string): EditorMode {
    if (!text) return 'json';
    // Scan tokens; stop on the first comment trivia.
    const scanner = createScanner(text, /* ignoreTrivia */ false);
    let kind = scanner.scan();
    while (kind !== SK_EOF) {
      if (kind === SK_LINE_COMMENT || kind === SK_BLOCK_COMMENT) {
        return 'jsonc';
      }
      kind = scanner.scan();
    }
    return 'json';
  }
}
