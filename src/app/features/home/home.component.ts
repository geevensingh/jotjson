import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild
} from '@angular/core';
import { Router } from '@angular/router';
import { Title } from '@angular/platform-browser';
import {
  format as jsoncFormat,
  applyEdits,
  createScanner
} from 'jsonc-parser';

// SyntaxKind values inlined: jsonc-parser exports SyntaxKind as a `const enum`,
// which TypeScript cannot access under `isolatedModules`. See jsonc-parser
// main.d.ts: LineCommentTrivia=12, BlockCommentTrivia=13, EOF=17.
const SK_LINE_COMMENT = 12;
const SK_BLOCK_COMMENT = 13;
const SK_EOF = 17;
import { AuthService } from '../../core/auth/auth.service';
import { BlobService } from '../../core/api/blob.service';
import type { CreateBlobResponse, JsonBlob } from '../../core/api/models';
import { DraftService } from '../../core/preferences/draft.service';
import { LoggerService } from '../../core/telemetry/logger.service';
import { SeoService } from '../../core/seo/seo.service';
import { PreferencesService } from '../../core/preferences/preferences.service';
import { QuotaNotificationService } from '../../core/quota/quota-notification.service';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';
import {
  ConfirmDialogComponent,
  ConfirmDialogData
} from '../../shared/dialogs/confirm-dialog/confirm-dialog.component';
import {
  JsonParserService,
  JsonParseResult
} from '../../core/json/json-parser.service';
import { JsonEditorComponent } from '../../shared/components/json-editor/json-editor.component';
import { JsonTreeComponent } from '../../shared/components/json-tree/json-tree.component';
import { AppHeaderComponent } from '../../shared/components/app-header/app-header.component';
import {
  EditorMode,
  ToolbarComponent
} from '../../shared/components/toolbar/toolbar.component';
import { StatusBarComponent } from './status-bar/status-bar.component';
import { ClipboardPollingService } from '../../core/clipboard/clipboard-polling.service';
import { ClipboardBannerComponent } from './clipboard-banner/clipboard-banner.component';

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
    ClipboardBannerComponent
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss'
})
export class HomeComponent {
  private readonly draft = inject(DraftService);
  private readonly prefs = inject(PreferencesService);
  private readonly parser = inject(JsonParserService);
  private readonly auth = inject(AuthService);
  private readonly blobs = inject(BlobService);
  private readonly router = inject(Router);
  private readonly titleService = inject(Title);
  private readonly seo = inject(SeoService);
  private readonly quota = inject(QuotaNotificationService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  private readonly clipboard = inject(ClipboardPollingService);
  private readonly logger = inject(LoggerService);

  /**
   * Blob hydrated by the /s/:slug resolver. When present, the editor starts
   * from this blob's content and the title field reflects its title.
   */
  readonly initialBlob = input<JsonBlob | undefined>(undefined);

  readonly content = signal(this.draft.content());
  readonly mode = signal<EditorMode>(this.detectMode(this.draft.content()));
  readonly cursor = signal<{ line: number; column: number } | undefined>(undefined);

  /** The currently-loaded server blob, if any. Null when editing an anonymous draft. */
  readonly loadedBlob = signal<JsonBlob | null>(null);
  readonly title = signal<string>('');
  readonly saveInFlight = signal<boolean>(false);
  readonly saveError = signal<string | null>(null);

  /**
   * Tracks the id of the blob whose content we've most recently hydrated
   * the editor from. Used by the hydration effect to avoid re-hydrating
   * from an input that hasn't changed (even if the effect re-runs for
   * unrelated reasons).
   */
  private lastHydratedInputId: string | null = null;

  readonly parseResult = computed<JsonParseResult>(() =>
    this.parser.parse(this.content())
  );

  readonly errors = computed(() => this.parseResult().errors);

  readonly treeValue = computed<unknown>(() => {
    const r = this.parseResult();
    return r.empty ? undefined : r.value;
  });

  readonly layoutOrientation = computed(() => this.prefs.prefs().layoutOrientation);

  readonly hasContent = computed(() => this.content().trim().length > 0);

  readonly canSave = computed(() => this.auth.isSignedIn() && this.hasContent());

  readonly isOwnedBlob = computed(() => {
    const blob = this.loadedBlob();
    if (!blob) return false;
    const user = this.auth.user();
    return !!user && user.id === blob.ownerId;
  });

  readonly isBlobPublic = computed(() => !!this.loadedBlob()?.isPublic);

  readonly clipboardState = computed<
    'enabled-json' | 'enabled-empty' | 'denied' | 'fallback'
  >(() => {
    const state = this.clipboard.permissionState();
    if (state === 'denied') return 'denied';
    if (state === 'granted') {
      return this.clipboard.hasJson() ? 'enabled-json' : 'enabled-empty';
    }
    return 'fallback';
  });

  readonly clipboardPreview = computed(() => this.clipboard.preview());

  private readonly homepageTitle = $localize`:@@app.title.homepage:JotJSON - JSON viewer, formatter, and tree explorer`;

  readonly splitRatio = signal(this.loadSplitRatio());

  readonly splitStyle = computed(() => {
    const r = this.splitRatio();
    const a = `${(r * 100).toFixed(3)}%`;
    const b = `${((1 - r) * 100).toFixed(3)}%`;
    return this.layoutOrientation() === 'vertical'
      ? { 'grid-template-rows': `${a} var(--splitter-size) ${b}` }
      : { 'grid-template-columns': `${a} var(--splitter-size) ${b}` };
  });

  private readonly splitHost =
    viewChild<ElementRef<HTMLElement>>('splitHost');

  private readonly treeHost =
    viewChild<ElementRef<HTMLElement>>('treeHost');

  private readonly tree = viewChild(JsonTreeComponent);

  constructor() {
    // Persist edits to the draft.
    effect(() => {
      this.draft.set(this.content());
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
      this.loadedBlob.set(blob);
      this.content.set(blob.content);
      this.title.set(blob.title ?? '');
    });

    // Update the browser tab title whenever the loaded blob or local title
    // changes. Anonymous / unsaved editing falls back to the homepage title.
    effect(() => {
      const blob = this.loadedBlob();
      const title = this.title();
      if (!blob) {
        this.titleService.setTitle(this.homepageTitle);
        this.seo.clearBlobTags();
        return;
      }
      const label =
        title.trim().length > 0
          ? title.trim()
          : $localize`:@@app.title.untitled:Untitled`;
      this.titleService.setTitle(`${label} | JotJSON`);
      if (blob.isPublic) {
        this.seo.setOpenGraphForBlob(blob);
      } else {
        this.seo.clearBlobTags();
        this.seo.setNoindex(true);
      }
    });

    // Persist split ratio to localStorage under `jotjson.splitRatio.v1`.
    // Intentionally local-only (not part of UserPreferences / Cosmos roaming):
    // viewport-dependent, couples with layoutOrientation, transient UI state,
    // and updates on every pointermove during a drag. See DESIGN_SPEC.md
    // "UserPreferences -> Intentionally not roamed" for the full rationale.
    // If we ever roam this, it needs per-orientation (and ideally
    // per-viewport-class) storage plus a multi-second write debounce.
    effect(() => {
      const r = this.splitRatio();
      try {
        localStorage.setItem('jotjson.splitRatio.v1', String(r));
      } catch {
        /* storage unavailable */
      }
    });

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
    inject(DestroyRef).onDestroy(() => {
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

  private loadSplitRatio(): number {
    try {
      const raw = localStorage.getItem('jotjson.splitRatio.v1');
      if (!raw) return 0.5;
      const n = Number(raw);
      if (!Number.isFinite(n)) return 0.5;
      return Math.min(0.9, Math.max(0.1, n));
    } catch {
      return 0.5;
    }
  }

  onValueChange(next: string): void {
    this.content.set(next);
  }

  onCursorChange(pos: { line: number; column: number }): void {
    this.cursor.set(pos);
  }

  async onPaste(): Promise<void> {
    const text = await this.clipboard.readForPaste();
    if (!text || text.trim().length === 0) return;
    const { unescaped, changed } = this.parser.tryUnescape(text);
    this.content.set(unescaped);
    if (changed) {
      // Pretty-print the newly-unescaped payload so the user sees the real
      // structure rather than a single dense line (per issue #38).
      this.onFormat();
    }
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

  async onUpload(file: File): Promise<void> {
    const MAX = 5 * 1024 * 1024;
    if (file.size > MAX) {
      this.logger.warn('home.upload.tooLarge', { size: file.size });
      return;
    }
    const text = await file.text();
    this.content.set(text);
  }

  onDownload(): void {
    const text = this.content();
    const ext = this.mode() === 'jsonc' ? 'jsonc' : 'json';
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jotjson-untitled.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  onClear(): void {
    this.content.set('');
    this.title.set('');
    this.loadedBlob.set(null);
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
    const content = this.content();
    const trimmedTitle = this.title().trim();
    const titlePatch = trimmedTitle.length > 0 ? trimmedTitle : undefined;

    try {
      if (existing && existing.ownerId === user.id) {
        const updated = await new Promise<JsonBlob>((resolve, reject) => {
          this.blobs
            .update(existing.id, { content, title: titlePatch })
            .subscribe({ next: resolve, error: reject });
        });
        this.loadedBlob.set(updated);
        this.title.set(updated.title ?? '');
      } else {
        const created = await new Promise<CreateBlobResponse>((resolve, reject) => {
          this.blobs
            .create(content, titlePatch, false)
            .subscribe({ next: resolve, error: reject });
        });
        // Strip the auxiliary quota marker before we treat it as a JsonBlob
        // so loadedBlob stays clean.
        const { autoDeleted, ...blob } = created;
        this.loadedBlob.set(blob);
        this.title.set(blob.title ?? '');
        void this.router.navigate(['/s', blob.slug]);
        if (autoDeleted) {
          void this.quota.notifyAutoDeleted(autoDeleted);
        }
      }
    } catch (err) {
      const httpErr = err as { status?: number; error?: { code?: string } };
      if (httpErr.status === 409 && httpErr.error?.code === 'quota_exceeded') {
        void this.quota.notifyQuotaExceededManual();
        this.saveError.set(
          $localize`:@@save.error.quotaExceeded:Blob limit reached - delete one from your saved blobs to save a new blob.`
        );
        return;
      }
      const message = this.formatSaveError(err);
      this.saveError.set(message);
      this.logger.warn('home.save.failed');
      void err;
    } finally {
      this.saveInFlight.set(false);
    }
  }

  private formatSaveError(err: unknown): string {
    const httpErr = err as { status?: number; error?: { error?: string } };
    const body = httpErr.error?.error;
    if (body) return body;
    if (httpErr.status === 401) {
      return $localize`:@@save.error.signIn:Please sign in to save`;
    }
    if (httpErr.status === 403) {
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
      eol: '\n'
    });
    const next = applyEdits(text, edits);
    if (next !== text) this.content.set(next);
  }

  onMinify(): void {
    const parsed = this.parseResult();
    if (parsed.empty || parsed.errors.length > 0) return;
    try {
      this.content.set(JSON.stringify(parsed.value));
      // Minified output has no comments -> switch back to JSON mode.
      this.mode.set('json');
    } catch {
      /* ignore */
    }
  }

  onModeChange(mode: EditorMode): void {
    this.mode.set(mode);
  }

  onToggleLayout(): void {
    const next =
      this.prefs.prefs().layoutOrientation === 'horizontal' ? 'vertical' : 'horizontal';
    this.prefs.update({ layoutOrientation: next });
  }

  onToggleTheme(): void {
    // Three-state cycle driven by the raw preference: light -> dark -> system.
    // 'system' follows the OS's prefers-color-scheme setting.
    const current = this.prefs.prefs().theme;
    const next =
      current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light';
    this.prefs.update({ theme: next });
  }

  onCopyShareLink(): void {
    const blob = this.loadedBlob();
    if (!blob) return;
    const url = `${window.location.origin}/s/${blob.slug}`;
    const clipboard = navigator.clipboard;
    const dismiss = $localize`:@@common.dismiss:Dismiss`;
    if (!clipboard?.writeText) {
      this.snack.open(
        $localize`:@@share.copyLink.unsupported:Copy is not supported in this browser.`,
        dismiss,
        { duration: 4000 }
      );
      return;
    }
    clipboard.writeText(url).then(
      () => {
        this.snack.open(
          $localize`:@@share.copyLink.success:Share link copied to clipboard.`,
          dismiss,
          { duration: 3000 }
        );
      },
      () => {
        this.snack.open(
          $localize`:@@share.copyLink.failed:Failed to copy share link.`,
          dismiss,
          { duration: 4000 }
        );
      }
    );
  }

  async onTogglePublic(): Promise<void> {
    const blob = this.loadedBlob();
    if (!blob) return;
    const user = this.auth.user();
    if (!user || user.id !== blob.ownerId) return;
    const next = !blob.isPublic;
    try {
      const updated = await firstValueFrom(
        this.blobs.update(blob.id, { isPublic: next })
      );
      this.loadedBlob.set(updated);
      const message = updated.isPublic
        ? $localize`:@@share.visibility.public:Blob is now public.`
        : $localize`:@@share.visibility.private:Blob is now private.`;
      this.snack.open(message, $localize`:@@common.dismiss:Dismiss`, { duration: 3000 });
    } catch (err) {
      this.logger.warn('share.visibility.failed');
      void err;
      this.snack.open(
        $localize`:@@share.visibility.failed:Failed to update visibility.`,
        $localize`:@@common.dismiss:Dismiss`,
        { duration: 4000 }
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
      destructive: true
    };
    const ref = this.dialog.open<ConfirmDialogComponent, ConfirmDialogData, boolean>(
      ConfirmDialogComponent,
      { data, width: '420px', autoFocus: 'dialog' }
    );
    const confirmed = await firstValueFrom(ref.afterClosed());
    if (!confirmed) return;

    try {
      await firstValueFrom(this.blobs.delete(blob.id));
      this.loadedBlob.set(null);
      this.content.set('');
      this.title.set('');
      this.snack.open(
        $localize`:@@share.delete.success:Blob deleted.`,
        $localize`:@@common.dismiss:Dismiss`,
        { duration: 3000 }
      );
      void this.router.navigate(['/']);
    } catch (err) {
      this.logger.warn('share.delete.failed');
      void err;
      this.snack.open(
        $localize`:@@share.delete.failed:Failed to delete blob.`,
        $localize`:@@common.dismiss:Dismiss`,
        { duration: 4000 }
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
    // editor, Monaco's native find runs.
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'f') {
      const active = document.activeElement;
      const inEditor = active?.closest('.monaco-editor') != null;
      if (!inEditor) {
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
