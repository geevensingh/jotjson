import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { from, switchMap } from 'rxjs';
import { AuthService } from '../auth/auth.service';

/**
 * Adds the bearer token to same-origin `/api/*` calls when an access token
 * is silently available.
 *
 * NOTE: We send the token under the custom `X-Jotjson-Authorization` header
 * rather than the standard `Authorization` header. Azure Static Web Apps'
 * managed-Functions runtime strips the incoming `Authorization` header and
 * replaces it with its own internal HS256 JWT before forwarding the request
 * to the Functions host, which would cause every request to fail JWT
 * validation. Custom headers are passed through untouched.
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
        setHeaders: { 'X-Jotjson-Authorization': `Bearer ${token}` }
      });
      return next(authed);
    })
  );
};
