import { inject } from '@angular/core';
import { Router, type ResolveFn } from '@angular/router';
import { Observable, catchError, of } from 'rxjs';
import { BlobService, type BlobFetchEvent } from '../../core/api/blob.service';
import type { JsonBlob } from '../../core/api/models';
import { LoadingSplashService } from '../../core/loading-splash/loading-splash.service';
import { LoggerService } from '../../core/telemetry/logger.service';

/**
 * Resolver for `/s/:slug`. Fetches the blob server-side before the component
 * is mounted so HomeComponent can hydrate from the resolved `initialBlob`
 * input (bound via `withComponentInputBinding()`).
 *
 * Drives the loading splash / route progress bar with determinate
 * progress: pushes `{loaded, total}` updates into
 * `LoadingSplashService.reportBlobProgress` as the body streams in,
 * and snaps the bar to `1.0` on the terminal event before the splash
 * hides. `total` is sourced from the server's `X-Jotjson-Body-Length`
 * header (see `BlobService.getWithProgress`).
 *
 * On 404 or network error, navigates to `/404` (replacing URL so back button
 * skips the share link) and passes the attempted slug through router state so
 * NotFoundComponent can surface it in the error copy.
 */
export const shareBlobResolver: ResolveFn<JsonBlob | null> = (route) => {
  const slug = route.paramMap.get('slug');
  const blobs = inject(BlobService);
  const router = inject(Router);
  const splash = inject(LoadingSplashService);
  const logger = inject(LoggerService);
  const goToNotFound = (attemptedSlug?: string): void => {
    void router.navigate(['/404'], {
      replaceUrl: true,
      state: attemptedSlug ? { attemptedSlug } : undefined,
    });
  };
  if (!slug) {
    goToNotFound();
    return of(null);
  }
  return new Observable<JsonBlob | null>((subscriber) => {
    let sawDeterminateTotal = false;
    let lastTotal: number | null = null;
    const inner = blobs.getWithProgress(slug).subscribe({
      next: (event: BlobFetchEvent) => {
        if (event.kind === 'progress') {
          if (event.total !== null) {
            sawDeterminateTotal = true;
            lastTotal = event.total;
          }
          splash.reportBlobProgress(event.loaded, event.total);
          return;
        }
        if (event.kind === 'bytesComplete') {
          // The body bytes have arrived; transition the splash to
          // "Rendering tree..." BEFORE the synchronous JSON.parse
          // runs in BlobService. For huge blobs this masks the
          // multi-second parse window, which would otherwise pin
          // the bar at 100% under "Downloading JSON...".
          splash.markBlobBytesComplete();
          return;
        }
        // Terminal blob event (event.kind === 'blob'). The
        // `bytesComplete` handler above already moved the splash to
        // render-pending and cleared progress, so this snap-to-1.0
        // is a no-op on the success path. Leave it as a defensive
        // last-resort completion for the (theoretical) case where
        // BlobService skips the bytesComplete event.
        if (lastTotal !== null) {
          splash.reportBlobProgress(lastTotal, lastTotal);
        }
        logger.event('blob.fetch.complete', { determinateProgress: sawDeterminateTotal });
        subscriber.next(event.blob);
        subscriber.complete();
      },
      error: () => {
        goToNotFound(slug);
        subscriber.next(null);
        subscriber.complete();
      },
    });
    return () => inner.unsubscribe();
  }).pipe(
    catchError(() => {
      goToNotFound(slug);
      return of(null);
    }),
  );
};
