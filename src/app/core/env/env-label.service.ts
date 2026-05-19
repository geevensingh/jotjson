import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { type EnvLabel, getEnvLabel } from './env-label';

/**
 * Runtime environment label, used to distinguish nonprod / PR-preview
 * / dev tabs from production. The label drives:
 *
 *  - `EnvPrefixedTitleStrategy` (prefixes every route title with
 *    `[<label>] ` when not on prod).
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
   * Wraps a title string with the env-label prefix when not on prod.
   *
   * On prod, returns `title` unchanged (the indicator is the
   * "production" state and shouldn't add chrome). On every other
   * label, prepends a localized `[<label>] ` prefix. The prefix is
   * the outermost wrapper -- existing dirty markers and brand
   * suffixes stay adjacent to the title text.
   */
  withPrefix(title: string): string {
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
