import { inject } from '@angular/core';
import { Router, type ResolveFn } from '@angular/router';
import { Observable, catchError, of } from 'rxjs';
import { BlobService, type BlobFetchEvent } from '../../core/api/blob.service';
import type { JsonBlob } from '../../core/api/models';
import { LoggerService } from '../../core/telemetry/logger.service';
import { LoadingSplashService } from '../../core/loading-splash/loading-splash.service';

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
        // Terminal blob event: snap the bar to 1.0 so the determinate
        // fill visually completes before the splash hides. Without
        // this, a final chunk that arrives in one large jump can race
        // with the Response event and leave the bar stuck around 97%.
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
