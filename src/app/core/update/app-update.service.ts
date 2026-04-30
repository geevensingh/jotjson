import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs/operators';
import { LoggerService } from '../telemetry/logger.service';
import { TelemetryService } from '../telemetry/telemetry.service';

/**
 * Reacts to Angular service worker events so that a deploy-in-progress
 * never leaves the user on a broken page:
 *
 * - `versionUpdates` -> when a fresh build has been downloaded
 *   (`VERSION_READY`), show a non-blocking snackbar offering to reload.
 *   Users can keep working; the next reload activates the new version.
 *
 * - `unrecoverable` -> the SW detected that its cached manifest refers
 *   to files the origin no longer serves (typical mid-deploy CDN race).
 *   Hard-reload with a cache-busting query so the browser bypasses any
 *   cached shell and the SW re-registers against the current build.
 *
 * The service is a no-op when the SW is disabled (dev mode, or browsers
 * without SW support) so unit/integration tests don't need extra wiring.
 *
 * See `DESIGN_SPEC.md` -> Progressive Web App -> Update prompt.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  private readonly swUpdate = inject(SwUpdate);
  private readonly snack = inject(MatSnackBar);
  private readonly logger = inject(LoggerService);
  private readonly telemetry = inject(TelemetryService);
  private initialized = false;

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.swUpdate.isEnabled) return;

    this.swUpdate.versionUpdates
      .pipe(
        filter(
          (evt): evt is VersionReadyEvent => evt.type === 'VERSION_READY'
        )
      )
      .subscribe(() => this.promptReload());

    this.swUpdate.unrecoverable.subscribe((event) => {
      this.logger.warn('update.unrecoverable', { reason: event.reason });
      this.hardReload();
    });
  }

  private promptReload(): void {
    const ref = this.snack.open(
      $localize`:@@update.available.message:A new version of JotJSON is available.`,
      $localize`:@@update.available.action:Reload`,
      { duration: 0 }
    );
    ref.onAction().subscribe(() => {
      void this.activateAndReload();
    });
  }

  private async activateAndReload(): Promise<void> {
    try {
      await this.swUpdate.activateUpdate();
    } catch (error) {
      // Reload anyway - the fresh fetch will re-run the install flow and
      // any partial cache will be discarded.
      this.logger.warn('update.activate.failed');
      void error;
      this.reload();
      return;
    }
    this.logger.event('update.applied', undefined, undefined);
    await this.telemetry.flush();
    this.reload();
  }

  private hardReload(): void {
    // Cache-busting query forces the browser to bypass any cached shell
    // and re-register the SW against the current build.
    const url = new URL(window.location.href);
    url.searchParams.set('_swreload', Date.now().toString(36));
    this.replaceLocation(url.toString());
  }

  /** Wrapped for tests. */
  protected reload(): void {
    window.location.reload();
  }

  /** Wrapped for tests. */
  protected replaceLocation(url: string): void {
    window.location.replace(url);
  }
}
