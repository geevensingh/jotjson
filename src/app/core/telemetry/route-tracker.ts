import { Injectable, inject } from '@angular/core';
import {
  ActivatedRouteSnapshot,
  NavigationEnd,
  Router
} from '@angular/router';
import { filter } from 'rxjs/operators';
import { TelemetryService } from './telemetry.service';

/**
 * Manual page-view tracker.
 *
 * Subscribes to the router and emits `trackPageView` calls using the
 * matched route's `path` template (e.g. `s/:slug`) instead of the raw
 * URL - this prevents the telemetry stream from fragmenting into one
 * series per blob slug.
 *
 * Because telemetry is connected lazily from `AppComponent.ngOnInit`,
 * the very first `NavigationEnd` may fire before `TelemetryService`
 * has loaded the SDK. We stash the most recent route in a single-slot
 * field; when telemetry becomes ready, the next call to `flushPending`
 * (invoked from `LoggerService.connect`) emits a bootstrap pageView
 * for the captured route.
 */
@Injectable({ providedIn: 'root' })
export class RouteTracker {
  private readonly router = inject(Router);
  private readonly telemetry = inject(TelemetryService);
  private pending: { name: string; uri: string } | null = null;
  private started = false;

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((evt) => this.handleNavigation(evt));
  }

  /**
   * Emit any pending pageView captured before telemetry was connected.
   * Safe to call multiple times.
   */
  flushPending(): void {
    if (!this.telemetry.isConnected || !this.pending) {
      return;
    }
    const { name, uri } = this.pending;
    this.pending = null;
    this.telemetry.trackPageView(name, uri);
  }

  private handleNavigation(evt: NavigationEnd): void {
    const uri = this.stripQuery(evt.urlAfterRedirects);
    const name = this.routeTemplate(this.router.routerState.snapshot.root) ?? uri;
    if (this.telemetry.isConnected) {
      this.telemetry.trackPageView(name, uri);
    } else {
      this.pending = { name, uri };
    }
  }

  private stripQuery(url: string): string {
    const queryIdx = url.indexOf('?');
    const hashIdx = url.indexOf('#');
    let end = url.length;
    if (queryIdx >= 0) end = Math.min(end, queryIdx);
    if (hashIdx >= 0) end = Math.min(end, hashIdx);
    return url.slice(0, end);
  }

  /**
   * Walk the activated-route tree and reassemble the matched template
   * (e.g. `/s/:slug`). Returns `undefined` when no template segments
   * are present (root navigation).
   */
  private routeTemplate(root: ActivatedRouteSnapshot): string | undefined {
    const segments: string[] = [];
    let cursor: ActivatedRouteSnapshot | null = root;
    while (cursor) {
      const path = cursor.routeConfig?.path;
      if (path !== undefined && path !== '') {
        segments.push(path);
      }
      cursor = cursor.firstChild;
    }
    if (segments.length === 0) {
      return '/';
    }
    return '/' + segments.join('/');
  }
}
