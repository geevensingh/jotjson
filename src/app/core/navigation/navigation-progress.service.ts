import { Injectable, Signal, computed, inject, signal } from '@angular/core';
import {
  Event as RouterEvent,
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  NavigationStart,
  Router,
} from '@angular/router';

/**
 * Tracks in-flight navigations so the route progress bar knows when to render.
 *
 * **Why a root singleton, not a per-component subscription**: the first
 * `NavigationStart` for a deep-link to `/s/:slug` fires very early in app
 * bootstrap. A subscriber created inside a child component may not be ready
 * in time and would miss it - which would defeat the entire purpose of the
 * route progress bar (the resolver wait on a cold deep-link IS the user's
 * primary pain point). The codebase already has the same workaround for
 * telemetry's `RouteTracker` (see `core/telemetry/route-tracker.ts`).
 *
 * **Why a Set of nav IDs, not a boolean**: navigations can overlap. The
 * canonical example in this codebase is `shareBlobResolver`, which on a 404
 * calls `router.navigate(['/404'])` *during* the in-flight navigation. That
 * produces a sequence like `NavigationStart(1) -> NavigationCancel(1) ->
 * NavigationStart(2) -> NavigationEnd(2)`. With a boolean we would flicker
 * the bar off between Cancel(1) and Start(2). With a Set we keep the bar
 * visible whenever ANY navigation is still in flight.
 *
 * **NavigationSkipped is treated as terminal** so same-URL or
 * onSameUrlNavigation='ignore' sequences (which fire Start without End)
 * cannot leave the Set permanently populated.
 *
 * **No `takeUntilDestroyed` / cleanup**: this service lives for the app
 * lifetime as a root singleton. The router is also a singleton. The
 * subscription is intentionally permanent.
 */
@Injectable({ providedIn: 'root' })
export class NavigationProgressService {
  private readonly inFlightCount = signal<number>(0);
  private readonly inFlight = new Set<number>();

  readonly pending: Signal<boolean> = computed(() => this.inFlightCount() > 0);

  constructor() {
    const router = inject(Router);
    router.events.subscribe((event) => this.handle(event));
  }

  private handle(event: RouterEvent): void {
    if (event instanceof NavigationStart) {
      if (!this.inFlight.has(event.id)) {
        this.inFlight.add(event.id);
        this.inFlightCount.set(this.inFlight.size);
      }
      return;
    }
    if (
      event instanceof NavigationEnd ||
      event instanceof NavigationCancel ||
      event instanceof NavigationError ||
      event instanceof NavigationSkipped
    ) {
      if (this.inFlight.delete(event.id)) {
        this.inFlightCount.set(this.inFlight.size);
      }
    }
  }
}
