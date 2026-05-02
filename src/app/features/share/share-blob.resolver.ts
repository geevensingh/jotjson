import { inject } from '@angular/core';
import { Router, type ResolveFn } from '@angular/router';
import { catchError, of } from 'rxjs';
import { BlobService } from '../../core/api/blob.service';
import type { JsonBlob } from '../../core/api/models';

/**
 * Resolver for `/s/:slug`. Fetches the blob server-side before the component
 * is mounted so HomeComponent can hydrate from the resolved `initialBlob`
 * input (bound via `withComponentInputBinding()`).
 *
 * On 404 or network error, navigates to `/404` (replacing URL so back button
 * skips the share link) and passes the attempted slug through router state so
 * NotFoundComponent can surface it in the error copy.
 */
export const shareBlobResolver: ResolveFn<JsonBlob | null> = (route) => {
  const slug = route.paramMap.get('slug');
  const blobs = inject(BlobService);
  const router = inject(Router);
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
  return blobs.get(slug).pipe(
    catchError(() => {
      goToNotFound(slug);
      return of(null);
    }),
  );
};
