import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { from, switchMap } from 'rxjs';
import { AuthService } from '../auth/auth.service';

/**
 * Adds an `Authorization: Bearer` header to same-origin `/api/*` calls when
 * an access token is silently available.
 *
 * Intentionally conservative:
 * - Never triggers an interactive sign-in. Public endpoints keep working
 *   anonymously; protected endpoints will 401, which the caller can surface
 *   and/or trigger a user-initiated sign-in from.
 * - Only matches relative `/api/*` URLs. Absolute URLs (including
 *   same-origin absolute URLs that happen to start with /api) are passed
 *   through unmodified to avoid surprising behavior with cross-service
 *   calls added later.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api/') && req.url !== '/api') {
    return next(req);
  }
  const auth = inject(AuthService);
  if (!auth.isSignedIn()) {
    return next(req);
  }
  return from(auth.acquireTokenSilent()).pipe(
    switchMap((token) => {
      if (!token) return next(req);
      const authed = req.clone({
        setHeaders: { Authorization: `Bearer ${token}` }
      });
      return next(authed);
    })
  );
};
