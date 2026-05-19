import { Injectable, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';
import { EnvLabelService } from './env-label.service';

/**
 * Custom `TitleStrategy` that wraps Angular's default route-title
 * behaviour with the env-label prefix from `EnvLabelService`.
 *
 * Without this strategy, only the home component's direct
 * `Title.setTitle()` calls would be prefixed -- every other route
 * (`/blobs`, `/history`, `/profile`, `/formatting-rules`, `/s/:slug`,
 * `/404`) declares its title in `app.routes.ts` and Angular's
 * `DefaultTitleStrategy` would set it unprefixed, making the
 * indicator vanish on those pages.
 *
 * The strategy follows the standard Angular pattern: read the
 * resolved title from the snapshot via `buildTitle`, defer to the
 * existing `Title` service for the DOM write, and short-circuit
 * when the route declares no title (leaves the document title
 * untouched, same as `DefaultTitleStrategy`).
 */
@Injectable({ providedIn: 'root' })
export class EnvPrefixedTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly envLabel = inject(EnvLabelService);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const resolvedTitle = this.buildTitle(snapshot);
    if (resolvedTitle === undefined) return;
    this.title.setTitle(this.envLabel.withPrefix(resolvedTitle));
  }
}
