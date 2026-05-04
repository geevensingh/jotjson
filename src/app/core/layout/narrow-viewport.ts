import { DestroyRef, inject, Signal, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { fromEvent } from 'rxjs';

/**
 * Width threshold (in CSS pixels) at and below which the Home page
 * collapses to a single visible pane (M7l). Mirrors
 * `$breakpoint-mobile` in `src/styles/_variables.scss` (768px) but as
 * an exclusive max via `767.98px` so the `<= 768px` SCSS media
 * queries and the JS `< 768px` check land on the same boundary.
 */
const NARROW_VIEWPORT_QUERY = '(max-width: 767.98px)';

/**
 * Returns a signal that is `true` when the viewport is narrow per the
 * M7l breakpoint, `false` otherwise. Seeded synchronously from
 * `MediaQueryList.matches` so the very first render already reflects
 * the correct branch (no flicker).
 *
 * Mirrors the SSR/no-window guard pattern in
 * `preferences.service.ts:90` - if `window` or `matchMedia` is
 * unavailable, returns a static `false` signal.
 *
 * Subscribers are cleaned up via `takeUntilDestroyed`, so this
 * factory must be invoked inside an injection context (a component or
 * service constructor / DI factory).
 */
export function createNarrowViewportSignal(): Signal<boolean> {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return signal(false).asReadonly();
  }

  const mql = window.matchMedia(NARROW_VIEWPORT_QUERY);
  const narrow = signal(mql.matches);
  const destroyRef = inject(DestroyRef);

  fromEvent<MediaQueryListEvent>(mql, 'change')
    .pipe(takeUntilDestroyed(destroyRef))
    .subscribe((event) => narrow.set(event.matches));

  return narrow.asReadonly();
}
