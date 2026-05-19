import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { type EnvLabel, getEnvLabel, getPreviewPrNumber } from './env-label';

/**
 * Runtime environment label, used to distinguish nonprod / PR-preview
 * / dev tabs from production. The label drives:
 *
 *  - `EnvPrefixedTitleStrategy` (prefixes every route title with
 *    `[<label>] ` when not on prod, or `[pr-<number>] ` when the
 *    PR number could be extracted from a preview hostname).
 *  - The env-indicator APP_INITIALIZER (swaps favicon assets to the
 *    nonprod variant when not on prod).
 *  - The `envLabel` closed-enum dimension on the `app.boot`
 *    telemetry event.
 *
 * Server platform: returns `'prod'`. Static prerender runs against
 * production content at build time (the prerendered HTML is then
 * served by every SWA deployment); the inline pre-bootstrap script
 * in `src/index.html` re-classifies at runtime when the prerendered
 * HTML is served on a non-prod host.
 *
 * The classification is computed once at construction; hostname
 * doesn't change during a session.
 */
@Injectable({ providedIn: 'root' })
export class EnvLabelService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  readonly label: EnvLabel = this.isBrowser ? getEnvLabel(window.location.hostname) : 'prod';

  /**
   * PR number extracted from a SWA preview hostname slug, or `null`
   * when the env is not a numeric-slug preview. See
   * `getPreviewPrNumber` for the parse rules. Always `null` on the
   * server platform (prerender) and on every non-preview env.
   */
  readonly prNumber: number | null = this.isBrowser
    ? getPreviewPrNumber(window.location.hostname)
    : null;

  /**
   * Wraps a title string with the env-label prefix when not on prod.
   *
   * On prod, returns `title` unchanged (the indicator is the
   * "production" state and shouldn't add chrome). On preview with a
   * resolvable PR number, prepends `[pr-<number>] `. On every other
   * non-prod label, prepends a localized `[<label>] ` prefix. The
   * prefix is the outermost wrapper -- existing dirty markers and
   * brand suffixes stay adjacent to the title text.
   */
  withPrefix(title: string): string {
    if (this.label === 'preview' && this.prNumber != null) {
      const prNumber = this.prNumber;
      return $localize`:|"pr-" is GitHub PR shorthand (pull request); keep as a literal token, do not translate.@@app.envLabel.previewWithPr:[pr-${prNumber}:prNumber:] ${title}:title:`;
    }
    switch (this.label) {
      case 'prod':
        return title;
      case 'nonprod':
        return $localize`:@@app.envLabel.nonprod:[nonprod] ${title}:title:`;
      case 'preview':
        return $localize`:@@app.envLabel.preview:[preview] ${title}:title:`;
      case 'dev':
        return $localize`:@@app.envLabel.dev:[dev] ${title}:title:`;
      case 'unknown':
        return $localize`:@@app.envLabel.unknown:[unknown] ${title}:title:`;
    }
  }
}
