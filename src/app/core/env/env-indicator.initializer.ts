import { isPlatformBrowser } from '@angular/common';
import { PLATFORM_ID, inject, provideAppInitializer } from '@angular/core';
import { EnvLabelService } from './env-label.service';

/**
 * Browser-only `provideAppInitializer` that swaps the favicon
 * `<link>` href to the nonprod variant when the env label is not
 * `'prod'`. Registered BEFORE the auth initializer in `app.config.ts`
 * so MSAL's `handleRedirectPromise()` (which can take hundreds of
 * ms on a returning redirect) does not delay the visual indicator.
 *
 * Returns synchronously (no Promise) so it does not block Angular
 * bootstrap.
 *
 * Note: the inline boot script in `src/index.html` performs the
 * same swap pre-bootstrap so the indicator paints even before the
 * Angular bundle finishes loading. This initializer is the
 * Angular-side safety net (idempotent re-swap if the boot script
 * was skipped, e.g. during static prerender).
 *
 * The PWA manifest icons are intentionally NOT rewritten -- a
 * per-env manifest is a separate deploy-time concern (see plan.md
 * "Variants considered"). Installed PWAs continue to show the prod
 * icon on nonprod.
 */
export const provideEnvIndicatorInitializer = () =>
  provideAppInitializer(() => {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) return;
    const envLabel = inject(EnvLabelService);
    if (envLabel.label === 'prod') return;
    swapFaviconLinks();
  });

/** Selectors -> nonprod asset paths. Kept aligned with `src/index.html`. */
const FAVICON_TARGETS: ReadonlyArray<{ selector: string; nonprodHref: string }> = [
  { selector: 'link[rel="icon"][type="image/x-icon"]', nonprodHref: 'favicon-nonprod.ico' },
  { selector: 'link[rel="icon"][type="image/svg+xml"]', nonprodHref: 'icons/icon-nonprod.svg' },
  { selector: 'link[rel="apple-touch-icon"]', nonprodHref: 'icons/icon-nonprod-192.png' },
];

function swapFaviconLinks(): void {
  for (const { selector, nonprodHref } of FAVICON_TARGETS) {
    const link = document.querySelector<HTMLLinkElement>(selector);
    if (link && !link.href.endsWith(nonprodHref)) {
      link.href = nonprodHref;
    }
  }
}
