import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { Title } from '@angular/platform-browser';
import {
  format as jsoncFormat,
  applyEdits,
  createScanner,
  findNodeAtLocation,
  Node as JsoncNode,
} from 'jsonc-parser';

// SyntaxKind values inlined: jsonc-parser exports SyntaxKind as a `const enum`,
// which TypeScript cannot access under `isolatedModules`. See jsonc-parser
// main.d.ts: LineCommentTrivia=12, BlockCommentTrivia=13, EOF=17.
const SK_LINE_COMMENT = 12;
const SK_BLOCK_COMMENT = 13;
const SK_EOF = 17;
import { AuthService } from '../../core/auth/auth.service';
import { BlobService } from '../../core/api/blob.service';
import type { BlobHighlight, CreateBlobResponse, JsonBlob } from '../../core/api/models';
import { DraftService } from '../../core/preferences/draft.service';
import { persistedSignal } from '../../core/preferences/persisted-signal';
import { LoggerService } from '../../core/telemetry/logger.service';
import { LoadingSplashService } from '../../core/loading-splash/loading-splash.service';
import { bucketBytes } from '../../core/telemetry/buckets';
import type { TelemetryMeasurements } from '../../core/telemetry/telemetry.service';
import { SeoService } from '../../core/seo/seo.service';
import { PreferencesService } from '../../core/preferences/preferences.service';
import { QuotaNotificationService } from '../../core/quota/quota-notification.service';
import {
  BeaconNavigationService,
  type BeaconJumpRequest,
} from '../../core/beacons/beacon-navigation.service';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { debounceTime, firstValueFrom } from 'rxjs';
import {
  ConfirmDialogComponent,
  ConfirmDialogData,
} from '../../shared/dialogs/confirm-dialog/confirm-dialog.component';
import { JsonParserService, JsonParseResult } from '../../core/json/json-parser.service';
import { JsonExtractorService, ExtractedJson } from '../../core/json/json-extractor.service';
import { TreeStringExtractorService } from '../../core/json/tree-string-extractor.service';
import { TitleSuggesterService } from '../../core/title-suggester/title-suggester.service';
import type { SuggestionCandidate } from '../../core/title-suggester/types';
import { JsonEditorComponent } from '../../shared/components/json-editor/json-editor.component';
import { ExtractJsonBannerComponent } from './extract-json-banner/extract-json-banner.component';
import { UploadErrorBannerComponent } from './upload-error-banner/upload-error-banner.component';
import {
  JsonTreeComponent,
  type TreeExtractRequest,
} from '../../shared/components/json-tree/json-tree.component';
import {
  EMPTY_BEACON_INDEX,
  type BeaconIndex,
} from '../../shared/components/json-tree/formatting-beacons-index';
import { highlightsEqual } from '../../shared/components/json-tree/highlight-resolver';
import { AppHeaderComponent } from '../../shared/components/app-header/app-header.component';
import { PaneLayout, ToolbarComponent } from '../../shared/components/toolbar/toolbar.component';
import { EditorMode } from './editor-mode';
import { StatusBarComponent } from './status-bar/status-bar.component';
import { ClipboardCopyService } from '../../core/clipboard/clipboard-copy.service';
import { ClipboardPollingService } from '../../core/clipboard/clipboard-polling.service';
import { ClipboardBannerComponent } from './clipboard-banner/clipboard-banner.component';
import { RuleSetsToolbarComponent } from './rule-sets-toolbar/rule-sets-toolbar.component';
import { DropOverlayComponent } from './file-upload/drop-overlay.component';
import { DocumentDropController } from '../../core/upload/document-drop-controller.service';
import { validateAndReadSingleFile } from '../../core/upload/upload-file-validator';
import { patchExtractedValue } from './extract-json-patcher';
import type { PatchResult } from './extract-json-patcher';
import { collectStringLeaves } from './string-leaf-collector';

/**
 * Local-only pane visibility (issue #39). Stored in `localStorage`
 * via `paneVisibility` and combined with `layoutOrientation` to
 * derive the 4-state `paneLayout` shown in the toolbar's segmented
 * control. Kept as a separate type so a future change to the
 * persisted shape is independent of the UI surface.
 */
type PaneVisibility = 'both' | 'editor-only' | 'tree-only';
type UploadSource = 'drag' | 'pick';

/**
 * Origin path that surfaced the current M7p extract candidate. Used as a
 * dimension on `home.extract.banner.{shown,accept,dismiss}` telemetry and
 * to gate the auto-focus-on-show behaviour (only `'paste'` auto-focuses
 * so Ctrl+V or drag-drop don't steal focus from a typing user).
 */
type ExtractSource = 'paste' | 'editor.paste' | 'upload.pick' | 'upload.drag';

type SignInRestoreSnapshot = {
  slug: string | null;
  content: string;
  title: string;
};

type LoadedSnapshot = {
  content: string;
  title: string;
  isPublic: boolean;
  highlights: readonly BlobHighlight[];
};

const SIGN_IN_RESTORE_KEY = 'jotjson.signInRestore.v1';

const TREE_EXTRACT_SCAN_DEBOUNCE_MS = 1000;

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
  private readonly titleService = inject(Title);
  private readonly seo = inject(SeoService);
  private readonly quota = inject(QuotaNotificationService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  private readonly clipboard = inject(ClipboardPollingService);
  private readonly clipboardCopy = inject(ClipboardCopyService);
  private readonly logger = inject(LoggerService);
  private readonly dropController = inject(DocumentDropController);
  private readonly beaconNav = inject(BeaconNavigationService);
  private readonly loadingSplash = inject(LoadingSplashService);

  /** Mirrors the controller's drag-active signal for the drop overlay. */
  readonly dropActive = this.dropController.dropActive;

  private disposeDropHandler?: () => void;

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
  readonly extractedCandidate = signal<{
    data: ExtractedJson;
    sourceVersion: number;
    source: ExtractSource;
  } | null>(null);
  private readonly contentVersion = signal(0);
  private readonly viewResetToken = signal(0);
  readonly viewResetTokenValue = this.viewResetToken.asReadonly();
  readonly extractBannerVisible = computed(() => {
    const cand = this.extractedCandidate();
    return cand !== null && cand.sourceVersion === this.contentVersion();
  });

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
        { blockCount: previousCandidate.data.blockCount },
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
  private replaceDocument(text: string): void {
    this.setContent(text);
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
        { blockCount: previousCandidate.data.blockCount },
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

  /** The currently-loaded server blob, if any. Null when editing an anonymous draft. */
  readonly loadedBlob = signal<JsonBlob | null>(null);
  readonly title = signal<string>('');
  readonly isPublic = signal<boolean>(false);
  readonly highlights = signal<readonly BlobHighlight[]>([]);
  readonly saveInFlight = signal<boolean>(false);
  readonly saveError = signal<string | null>(null);

  private readonly loadedSnapshot = signal<LoadedSnapshot | null>(null);
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

  readonly parseResult = computed<JsonParseResult>(() => this.parser.parse(this.content()));

  readonly errors = computed(() => this.parseResult().errors);

  readonly treeValue = computed<unknown>(() => {
    const result = this.parseResult();
    return result.empty ? undefined : result.value;
  });

  private readonly treeValueChanges$ = toObservable(this.treeValue);

  readonly layoutOrientation = computed(() => this.prefs.prefs().layoutOrientation);

  readonly hasContent = computed(() => this.content().trim().length > 0);

  readonly dirty = computed(() => {
    const snapshot = this.loadedSnapshot();
    if (snapshot === null) {
      return this.content().length > 0 || this.title().length > 0 || this.highlights().length > 0;
    }
    return (
      this.content() !== snapshot.content ||
      this.title() !== snapshot.title ||
      this.isPublic() !== snapshot.isPublic ||
      !highlightsEqual(this.highlights(), snapshot.highlights)
    );
  });

  readonly isOwnedBlob = computed(() => {
    const blob = this.loadedBlob();
    if (!blob) return false;
    const user = this.auth.user();
    return !!user && user.id === blob.ownerId;
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

  readonly canSave = computed(
    () =>
      this.auth.isSignedIn() &&
      this.hasContent() &&
      (this.loadedBlob() === null || !this.isOwnedBlob() || this.dirty()),
  );

  readonly isBlobPublic = computed(() => this.loadedBlob() !== null && this.isPublic());

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
   * 4-state derived view of `paneVisibility` + `layoutOrientation`,
   * matching the segments of the toolbar's pane-layout segmented
   * control. Single-pane states ignore the orientation pref - it is
   * preserved untouched and re-applied when the user picks a `both-*`
   * segment again.
   */
  readonly paneLayout = computed<PaneLayout>(() => {
    const visibility = this.paneVisibility();
    if (visibility === 'editor-only') return 'editor-only';
    if (visibility === 'tree-only') return 'tree-only';
    return this.layoutOrientation() === 'vertical' ? 'both-vertical' : 'both-horizontal';
  });

  readonly splitStyle = computed(() => {
    const visibility = this.paneVisibility();
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
      const blob = this.loadedBlob();
      const title = this.title();
      const dirtyPrefix = this.dirty() ? '* ' : '';
      if (!blob) {
        this.titleService.setTitle(`${dirtyPrefix}${this.homepageTitle}`);
        this.seo.clearBlobTags();
        return;
      }
      const label =
        title.trim().length > 0 ? title.trim() : $localize`:@@app.title.untitled:Untitled`;
      this.titleService.setTitle(`${dirtyPrefix}${label} | JotJSON`);
      if (blob.isPublic) {
        this.seo.setOpenGraphForBlob(blob);
      } else {
        this.seo.clearBlobTags();
        this.seo.setNoindex(true);
      }
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

  private applyLoadedBlob(blob: JsonBlob): void {
    const snapshot = this.snapshotFromBlob(blob);
    this.loadedBlob.set(blob);
    this.replaceDocument(snapshot.content);
    this.title.set(snapshot.title);
    this.isPublic.set(snapshot.isPublic);
    this.highlights.set(snapshot.highlights);
    this.loadedSnapshot.set(snapshot);
    this.mutatedPaths.set(new Set<string>());
  }

  private applySavedBlobResponse(blob: JsonBlob, submitted: LoadedSnapshot): void {
    const snapshot = this.snapshotFromBlob(blob);
    this.loadedBlob.set(blob);
    if (this.content() === submitted.content && this.content() !== snapshot.content) {
      this.replaceDocument(snapshot.content);
    }
    if (this.title() === submitted.title) {
      this.title.set(snapshot.title);
    }
    if (this.isPublic() === submitted.isPublic) {
      this.isPublic.set(snapshot.isPublic);
    }
    if (highlightsEqual(this.highlights(), submitted.highlights)) {
      this.highlights.set(snapshot.highlights);
    }
    this.loadedSnapshot.set(snapshot);
    this.mutatedPaths.set(new Set<string>());
  }

  private snapshotFromBlob(blob: JsonBlob): LoadedSnapshot {
    return {
      content: blob.content,
      title: blob.title ?? '',
      isPublic: blob.isPublic,
      highlights: [...(blob.highlights ?? [])],
    };
  }

  private currentSnapshot(): LoadedSnapshot {
    return {
      content: this.content(),
      title: this.title(),
      isPublic: this.isPublic(),
      highlights: [...this.highlights()],
    };
  }

  private resetLoadedBlobState(): void {
    this.loadedBlob.set(null);
    this.isPublic.set(false);
    this.highlights.set([]);
    this.loadedSnapshot.set(null);
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
    if (this.loadedBlob() === null) {
      this.loadedSnapshot.set(null);
    }
  }

  __loadBlobForTesting(blob: JsonBlob): void {
    this.applyLoadedBlob(blob);
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

    const baseSnapshot = this.loadedSnapshot();
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
    const publicConflicts =
      localSnapshot.isPublic !== baseSnapshot.isPublic &&
      remoteSnapshot.isPublic !== baseSnapshot.isPublic &&
      localSnapshot.isPublic !== remoteSnapshot.isPublic;
    const replaceRemote =
      contentConflicts || titleConflicts || publicConflicts
        ? await this.promptConflictResolution()
        : false;

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
    const nextIsPublic = this.rebaseCoarseField(
      baseSnapshot.isPublic,
      localSnapshot.isPublic,
      remoteSnapshot.isPublic,
      publicConflicts,
      replaceRemote,
    );
    const nextHighlights = this.rebaseHighlights(
      remoteSnapshot.highlights,
      localSnapshot.highlights,
      this.mutatedPaths(),
    );

    this.loadedBlob.set(remoteBlob);
    this.loadedSnapshot.set(remoteSnapshot);
    if (this.content() !== nextContent) {
      this.replaceDocument(nextContent);
    }
    this.title.set(nextTitle);
    this.isPublic.set(nextIsPublic);
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
    const host = this.splitHost()?.nativeElement;
    if (!host) return;
    ev.preventDefault();
    const target = ev.currentTarget as HTMLElement;
    target.setPointerCapture(ev.pointerId);
    const vertical = this.layoutOrientation() === 'vertical';

    const move = (e: PointerEvent): void => {
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
   * editor based on `paneVisibility()` plus
   * `BeaconNavigationService.lastActivePane()` (the latter only used
   * when both panes are visible). Always emits
   * `beacons.crossPane.dispatched` telemetry with closed-enum props
   * (no paths, no key/value content).
   */
  private dispatchBeaconJump(request: BeaconJumpRequest): void {
    const paneVisibility = this.paneVisibility();
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

    let result: PatchResult;
    try {
      result = patchExtractedValue(this.content(), event.path, event.replacement);
    } catch (error) {
      this.logger.warn('tree.extract.applyFailed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
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
    this.setContent(result.patched);
    this.tree()?.expandNodeAtPath(event.path);
  }

  onToggleSelectionSync(): void {
    const next = !this.prefs.prefs().treeEditorSelectionSync;
    this.prefs.update({ treeEditorSelectionSync: next });
    // Clear any in-flight echo expectations so a cycle that survives
    // an OFF flip cannot suppress a real gesture once sync turns back
    // on (the next gesture re-engages cleanly).
    this.pendingEditorReveal = undefined;
    this.pendingTreeApply = undefined;
  }

  private syncEnabled(): boolean {
    return this.prefs.prefs().treeEditorSelectionSync;
  }

  /**
   * Resolves a Monaco editor offset to a tree path string. Returns
   * `null` when the cursor is in trailing whitespace, before the
   * document starts, or otherwise outside the parsed AST. Trailing
   * placeholder segments produced by `jsonc-parser`'s `getLocation`
   * (e.g. cursor in incomplete syntax) are trimmed by walking upward
   * until a path is known to the tree's `nodeIndex`. Falls back to
   * the document root `$` only when the offset lies inside the AST
   * AND the tree has a row at `$`.
   */
  private resolveTreePath(offset: number): string | null {
    const tree = this.tree();
    if (!tree) return null;
    const text = this.content();
    // Align Monaco's full-text offset with the parser's stripped-text
    // coordinate space (BOM-aware).
    const bomShift = this.bomShift(text);
    const adjusted = offset - bomShift;
    if (adjusted < 0) return null;
    const stripped = bomShift > 0 ? text.slice(bomShift) : text;
    const path = this.parser.locationAt(stripped, adjusted);

    for (let length = path.length; length > 0; length--) {
      const candidate = this.parser.pathToString(path.slice(0, length));
      if (tree.hasPath(candidate)) return candidate;
    }

    const ast = this.parseResult().ast;
    if (ast && adjusted >= ast.offset && adjusted <= ast.offset + ast.length && tree.hasPath('$')) {
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
      // structure rather than a single dense line (per issue #38).
      this.onFormat();
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
    const extracted = this.extractor.extractFromMixedText(this.content());
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
    if (event.postPasteParses) {
      this.replaceExtractedCandidate(null, null);
      return;
    }
    const extracted = this.extractor.extractFromMixedText(event.pastedText);
    if (extracted) {
      this.replaceExtractedCandidate(extracted, 'editor.paste');
    } else {
      this.replaceExtractedCandidate(null, null);
    }
  }

  onExtractAccept(): void {
    const candidate = this.extractedCandidate();
    if (!candidate) return;
    this.logger.event(
      'home.extract.banner.accept',
      { source: candidate.source },
      {
        blockCount: candidate.data.blockCount,
        preservesComments: candidate.data.preservesComments ? 1 : 0,
        hasComments: candidate.data.hasComments ? 1 : 0,
      },
    );
    // Clear the candidate FIRST so `setContent`'s banner-replace guard
    // does not additionally fire `home.extract.banner.dismiss` with
    // `reason='content.changed'` for the same candidate.
    this.extractedCandidate.set(null);
    this.replaceDocument(candidate.data.text);
    this.resetHighlightsForDocumentReplacement();
  }

  onExtractDismiss(): void {
    const candidate = this.extractedCandidate();
    if (candidate !== null) {
      this.logger.event(
        'home.extract.banner.dismiss',
        { source: candidate.source, reason: 'user.click' },
        { blockCount: candidate.data.blockCount },
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
    this.disposeDropHandler = this.dropController.registerEditorHandler((files) => {
      void this.onFilesReceived(files, 'drag');
    });
  }

  ngOnDestroy(): void {
    this.disposeDropHandler?.();
    this.disposeDropHandler = undefined;
  }

  async onUpload(file: File): Promise<void> {
    await this.onFilesReceived([file], 'pick');
  }

  private async onFilesReceived(files: readonly File[], source: UploadSource): Promise<void> {
    const handlerStartedAt = performance.now();
    const fileReadStartedAt = performance.now();
    const result = await validateAndReadSingleFile(files);
    const fileReadMs = this.durationSince(fileReadStartedAt);
    switch (result.kind) {
      case 'ok': {
        const filename = files[0]?.name ?? 'file';
        const sizeBytes = files[0]?.size ?? new Blob([result.text]).size;
        const parseStartedAt = performance.now();
        const { unescaped } = this.parser.tryUnescape(result.text);
        const parseMs = this.durationSince(parseStartedAt);
        this.replaceDocument(unescaped);
        this.resetHighlightsForDocumentReplacement();
        // M7p title-suggester: remember the source filename so the
        // wand button can offer it as a candidate. The UX rule is
        // "covers both upload-picker AND drag-drop"; this is the
        // shared chokepoint.
        this.lastFilename.set(filename);
        this.suggestedTitlesForMenu.set([]);
        this.runExtractorOnCurrentContent(source === 'pick' ? 'upload.pick' : 'upload.drag');
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
        this.snack.open(
          $localize`:@@home.upload.error.tooLarge:File too large - max 5 MB`,
          $localize`:@@common.dismiss:Dismiss`,
          { duration: 4000 },
        );
        return;
      case 'binary':
        this.logger.info('home.upload.binary', { filename: result.filename });
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
    this.setContent('');
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
        this.setContent(parsedSnapshot.content);
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
   * Save the current editor contents. If the loaded blob is owned by the
   * current user, update in place (same slug). Otherwise, create a new blob
   * (fork) with a fresh slug.
   */
  async onSave(): Promise<void> {
    if (!this.canSave() || this.saveInFlight()) return;
    const user = this.auth.user();
    if (!user) return;

    this.saveInFlight.set(true);
    this.saveError.set(null);

    const existing = this.loadedBlob();
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
              isPublic: submitted.isPublic,
              highlights: [...highlights],
            })
            .subscribe({ next: resolve, error: reject });
        });
        this.applySavedBlobResponse(updated, submitted);
      } else {
        const created = await new Promise<CreateBlobResponse>((resolve, reject) => {
          this.blobs
            .create(submitted.content, titlePatch, false, [...highlights])
            .subscribe({ next: resolve, error: reject });
        });
        this.logger.event(
          'share.created',
          { visibility: 'private' },
          { sizeBytes: new Blob([submitted.content]).size },
        );
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
    const edits = jsoncFormat(text, undefined, {
      tabSize: this.prefs.prefs().editorTabSize,
      insertSpaces: true,
      eol: '\n',
    });
    const next = applyEdits(text, edits);
    if (next !== text) this.setContent(next);
  }

  onMinify(): void {
    const parsed = this.parseResult();
    if (parsed.empty || parsed.errors.length > 0) return;
    try {
      this.setContent(JSON.stringify(parsed.value));
      // Minified output has no comments -> switch back to JSON mode.
      this.mode.set('json');
    } catch {
      /* ignore */
    }
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

  async onTogglePublic(): Promise<void> {
    const blob = this.loadedBlob();
    if (!blob) return;
    const user = this.auth.user();
    if (!user || user.id !== blob.ownerId) return;
    const next = !this.isPublic();
    try {
      const updated = await firstValueFrom(this.blobs.update(blob.id, { isPublic: next }));
      this.loadedBlob.set(updated);
      this.isPublic.set(updated.isPublic);
      this.loadedSnapshot.set(this.snapshotFromBlob(updated));
      this.logger.event(
        'share.visibility.changed',
        { newVisibility: updated.isPublic ? 'public' : 'private' },
        undefined,
      );
      const message = updated.isPublic
        ? $localize`:@@share.visibility.public:Blob is now public.`
        : $localize`:@@share.visibility.private:Blob is now private.`;
      this.snack.open(message, $localize`:@@common.dismiss:Dismiss`, { duration: 3000 });
    } catch (error) {
      const httpError = error as { status?: number };
      if (httpError.status === 412) {
        return;
      }
      this.logger.warn('share.visibility.failed');
      void error;
      this.snack.open(
        $localize`:@@share.visibility.failed:Failed to update visibility.`,
        $localize`:@@common.dismiss:Dismiss`,
        { duration: 4000 },
      );
    }
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
      this.setContent('');
      this.title.set('');
      this.resetLoadedBlobState();
      this.lastFilename.set(null);
      this.suggestedTitlesForMenu.set([]);
      this.snack.open(
        $localize`:@@share.delete.success:Blob deleted.`,
        $localize`:@@common.dismiss:Dismiss`,
        { duration: 3000 },
      );
      void this.router.navigate(['/']);
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
    // 3-state pane visibility toggle (issue #39) we skip the routing rather
    // than focusing a `display:none` input - the keypress falls through to
    // the browser default.
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'f') {
      const active = document.activeElement;
      const inEditor = active?.closest('.monaco-editor') != null;
      const treeHidden = this.paneVisibility() === 'editor-only';
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
