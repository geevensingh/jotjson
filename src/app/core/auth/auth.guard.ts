import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * Functional route guard. Allows activation when the user is signed in;
 * otherwise redirects to the home page and fires an interactive sign-in.
 *
 * Not applied to any route in M3a - it lands ready for M3b's `/profile`
 * route and future protected areas.
 */
export const authGuard: CanActivateFn = (): boolean | UrlTree => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (auth.isSignedIn()) return true;
  auth.signIn();
  return router.createUrlTree(['/']);
};
