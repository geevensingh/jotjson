import { DOCUMENT, Injectable, NgZone, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs/operators';

/**
 * Programmatically moves keyboard / screen-reader focus to the new route's
 * `<main id="main-content">` landmark on every `NavigationEnd` after the
 * initial cold-boot navigation.
 *
 * **Why this exists** (M7g-3 / WCAG 2.4.3 + 4.1.3): in single-page apps,
 * router transitions do not fire a browser navigation, so focus stays on
 * whatever element triggered the navigation (a nav link, the back button
 * trigger, the resolver-driven redirect target). Screen-reader users hear
 * silence after the click; sighted keyboard users continue Tab from the
 * trigger as if the page never changed. Moving focus to `<main>` makes the
 * new page's heading the next thing a screen reader announces and the next
 * thing Tab navigates from.
 *
 * **First navigation skipped**: the initial bootstrap navigation arrives
 * with focus on `<body>` (browser default for a fresh page load). Moving
 * focus to `<main>` would steal focus from the browser address bar / tab
 * UI, which is unexpected. We let the browser keep its default and only
 * intervene on subsequent in-app transitions.
 *
 * **`tabindex="-1"` on `<main>`**: a non-interactive `<main>` element
 * cannot programmatically receive focus in some browsers without an
 * explicit tabindex. We add `tabindex="-1"` lazily here rather than
 * requiring every route template to remember it. The negative value keeps
 * `<main>` out of the Tab order while allowing `.focus()` to succeed.
 *
 * **`preventScroll: true`**: the router's own scroll behaviour
 * (`withInMemoryScrolling`) handles scroll position on navigation. We
 * focus without scrolling so we do not fight the scroller and bounce the
 * viewport.
 *
 * **Why a root singleton, not a per-component subscription**: the very
 * first NavigationEnd we want to observe is the one that lands the user
 * on the second route they ever visit, which can fire shortly after
 * bootstrap. A subscriber created inside a child component may not be
 * ready in time. The codebase already uses this pattern for
 * `NavigationProgressService` and the telemetry `RouteTracker`.
 *
 * **No `takeUntilDestroyed` / cleanup**: the service lives for the app
 * lifetime as a root singleton. The router is also a singleton. The
 * subscription is intentionally permanent.
 */
@Injectable({ providedIn: 'root' })
export class RouteFocusService {
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly zone = inject(NgZone);
  private firstNavigationDone = false;

  constructor() {
    this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe(() => {
        if (!this.firstNavigationDone) {
          this.firstNavigationDone = true;
          return;
        }
        this.scheduleFocus();
      });
  }

  private scheduleFocus(): void {
    // Defer one task so the new route's component finishes its initial
    // change-detection cycle and the `<main>` element exists in the DOM.
    // Run outside Angular so the resulting `focus()` does not schedule
    // a redundant change-detection pass.
    this.zone.runOutsideAngular(() => {
      setTimeout(() => this.focusMain(), 0);
    });
  }

  private focusMain(): void {
    const main = this.document.getElementById('main-content');
    if (!main) {
      return;
    }
    if (!main.hasAttribute('tabindex')) {
      main.setAttribute('tabindex', '-1');
    }
    main.focus({ preventScroll: true });
  }

  /**
   * Test seam: lets specs reset the "first navigation skipped" gate so
   * they can exercise the focus path deterministically without juggling
   * router events.
   */
  __resetFirstNavigationForTesting(): void {
    this.firstNavigationDone = false;
  }
}
