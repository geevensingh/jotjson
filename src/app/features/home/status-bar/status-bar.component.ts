import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { BUILD_INFO_TOKEN } from '../../../core/build/build-info.token';
import { ClipboardCopyService } from '../../../core/clipboard/clipboard-copy.service';
import { JsonParseResult } from '../../../core/json/json-parser.service';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { EditorMode } from '../editor-mode';
import { computeMinifiedChars, computeTextStats, computeTreeStats, formatBytes } from './stats';

/**
 * Home page status bar (M7m). Purely informational row showing text and tree
 * stats. Read-only; no interactivity in v1. On narrow viewports the bar
 * collapses via CSS to a single line keeping only Lines, Size, and the Mode
 * badge (M7l - see status-bar.component.scss).
 */
@Component({
  selector: 'jj-status-bar',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './status-bar.component.html',
  styleUrl: './status-bar.component.scss',
})
export class StatusBarComponent {
  readonly text = input<string>('');
  readonly mode = input<EditorMode>('json');
  readonly parseResult = input<JsonParseResult | undefined>(undefined);
  readonly cursor = input<{ line: number; column: number } | undefined>(undefined);

  /**
   * Display name of the local file the document is bound to via the
   * M-PWA-write-back flow (`DocumentBacking` kind === 'file'). When
   * non-null, the status bar surfaces this as a left-side stat so
   * multi-window PWA users can distinguish their tabs at a glance
   * (complements the browser tab title which also carries the
   * filename for file-backed docs - see `HomeComponent`'s title
   * effect). `null` for draft + blob-backed documents.
   */
  readonly filename = input<string | null>(null);

  readonly textStats = computed(() => computeTextStats(this.text()));

  /**
   * "Meaningful character" count surfaced as the Chars stat (issue #103):
   * the source character count after whitespace and comments are stripped.
   * Driven off `text()` (lexical, not semantic) so the count is computable
   * for any input, including partial / parse-error documents.
   */
  readonly meaningfulChars = computed(() => computeMinifiedChars(this.text()));

  readonly bytesLabel = computed(() => formatBytes(this.textStats().bytes));

  /** Tree stats are undefined when the document failed to parse or is empty. */
  readonly treeStats = computed(() => {
    const pr = this.parseResult();
    if (!pr || pr.empty || pr.errors.length > 0) return undefined;
    return computeTreeStats(pr.ast);
  });

  /**
   * The Comments stat mirrors `treeStats()` gating (hidden when the
   * document is empty or parse-failed) AND requires `commentCount > 0`
   * so the chip never appears as "Comments 0" on commentless docs.
   * Visibility is content-driven, not mode-driven: the parser allows
   * comments regardless of the editor `mode` (`disallowComments: false`
   * in JsonParserService), so a JSON-mode document with pasted comments
   * still surfaces the count.
   */
  readonly showComments = computed(() => {
    const pr = this.parseResult();
    if (!pr || pr.empty || pr.errors.length > 0) return false;
    return pr.commentCount > 0;
  });

  readonly commentCount = computed(() => this.parseResult()?.commentCount ?? 0);

  readonly cursorLabel = computed(() => {
    const position = this.cursor();
    const line = position?.line ?? 1;
    const col = position?.column ?? 1;
    return { line, col };
  });

  readonly modeLabel = computed(() => (this.mode() === 'jsonc' ? 'JSONC' : 'JSON'));

  readonly placeholder = '-';

  private readonly buildInfo = inject(BUILD_INFO_TOKEN);
  private readonly clipboardCopy = inject(ClipboardCopyService);

  readonly buildVersion = this.buildInfo.version;
  readonly buildSha = this.buildInfo.sha;
  readonly isDevBuild = this.buildSha === 'dev';
  readonly shortSha = this.isDevBuild ? 'dev' : this.buildSha.slice(0, 7);
  readonly hasCommitLink = !this.isDevBuild && this.buildInfo.repoUrl !== '';
  readonly commitUrl = this.hasCommitLink
    ? `${this.buildInfo.repoUrl}/commit/${this.buildSha}`
    : '';
  readonly buildNumber = this.buildInfo.buildNumber;
  readonly hasKnownBuildNumber = this.buildNumber !== 'unknown';
  // Show the build counter in the tooltip only when it is both known and
  // came from a real CI build (sha != 'dev'). Mixing a real-looking
  // `build 391` with a `dev` SHA is a confusing signal; better to keep the
  // dev tooltip flat and reserve the counter for shipped builds.
  readonly showBuildNumber = this.hasKnownBuildNumber && !this.isDevBuild;
  readonly buildTitle =
    `JotJSON v${this.buildInfo.version}` +
    (this.showBuildNumber ? ` (build ${this.buildNumber})` : '') +
    (this.buildInfo.branch ? ` (${this.buildInfo.branch})` : '') +
    `\nbuilt ${this.buildInfo.builtAt}`;
  readonly commitAriaLabel = $localize`:@@status.build.link.aria:Open commit ${
    this.shortSha
  }:shortSha: on GitHub`;

  copySha(): void {
    void this.clipboardCopy.copyWithToast(this.buildSha, {
      success: $localize`:@@status.build.copy.success:Copied commit SHA`,
      failed: $localize`:@@status.build.copy.failed:Failed to copy commit SHA`,
      unsupported: $localize`:@@status.build.copy.unsupported:Clipboard unavailable`,
    });
  }
}
