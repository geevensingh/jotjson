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
 * On 404 or network error, redirects to `/` so we never render a broken share
 * page. Full friendly-404 UX is deferred to M4c.
 */
export const shareBlobResolver: ResolveFn<JsonBlob | null> = (route) => {
  const slug = route.paramMap.get('slug');
  const blobs = inject(BlobService);
  const router = inject(Router);
  if (!slug) {
    void router.navigate(['/']);
    return of(null);
  }
  return blobs.get(slug).pipe(
    catchError(() => {
      void router.navigate(['/']);
      return of(null);
    })
  );
};
