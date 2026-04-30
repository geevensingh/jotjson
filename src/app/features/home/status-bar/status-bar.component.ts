import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { JsonParseResult } from '../../../core/json/json-parser.service';
import { EditorMode } from '../../../shared/components/toolbar/toolbar.component';
import { BUILD_INFO } from '../../../../generated/build-info';
import { computeTextStats, computeTreeStats, formatBytes } from './stats';

/**
 * Home page status bar (M7m). Purely informational row showing text and tree
 * stats. Read-only; no interactivity in v1. Responsive collapsing is deferred
 * to M7l per DESIGN_SPEC.md.
 */
@Component({
  selector: 'jj-status-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './status-bar.component.html',
  styleUrl: './status-bar.component.scss'
})
export class StatusBarComponent {
  readonly text = input<string>('');
  readonly mode = input<EditorMode>('json');
  readonly parseResult = input<JsonParseResult | undefined>(undefined);
  readonly cursor = input<{ line: number; column: number } | undefined>(undefined);

  readonly textStats = computed(() => computeTextStats(this.text()));

  readonly bytesLabel = computed(() => formatBytes(this.textStats().bytes));

  /** Tree stats are undefined when the document failed to parse or is empty. */
  readonly treeStats = computed(() => {
    const pr = this.parseResult();
    if (!pr || pr.empty || pr.errors.length > 0) return undefined;
    return computeTreeStats(pr.ast);
  });

  readonly cursorLabel = computed(() => {
    const position = this.cursor();
    const line = position?.line ?? 1;
    const col = position?.column ?? 1;
    return { line, col };
  });

  readonly modeLabel = computed(() => (this.mode() === 'jsonc' ? 'JSONC' : 'JSON'));

  readonly placeholder = '-';

  // Short-term build info (pre-M7n): displays the local-git commit SHA so
  // users can report exactly what they were running. M7n will replace this
  // with a CI-authoritative version + SHA pair.
  readonly buildSha = BUILD_INFO.sha + (BUILD_INFO.dirty ? '*' : '');
  readonly buildTitle =
    `JotJSON v${BUILD_INFO.version}` +
    (BUILD_INFO.branch ? ` (${BUILD_INFO.branch})` : '') +
    `\nbuilt ${BUILD_INFO.builtAt}` +
    (BUILD_INFO.dirty ? ' (working tree dirty)' : '');
}
