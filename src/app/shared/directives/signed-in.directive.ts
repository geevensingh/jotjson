import { Directive, TemplateRef, ViewContainerRef, effect, inject } from '@angular/core';
import { AuthService } from '../../core/auth/auth.service';

/**
 * Structural directive that renders its template only when auth is configured
 * AND the current user is signed in. Call sites avoid duplicating the
 * `authConfigured && isSignedIn()` check and no longer need to inject
 * `AuthService` themselves.
 *
 * Usage:
 *   <a *jjSignedIn routerLink="/blobs">Blobs</a>
 *   <ng-container *jjSignedIn>
 *     <input class="title-field" ... />
 *     <button mat-icon-button ...>Save</button>
 *   </ng-container>
 *
 * DOM-level hiding (not CSS) keeps the a11y tree and tab order correct for
 * anonymous users.
 */
@Directive({
  selector: '[jjSignedIn]',
  standalone: true,
})
export class SignedInDirective {
  private readonly template = inject(TemplateRef<unknown>);
  private readonly viewContainer = inject(ViewContainerRef);
  private readonly auth = inject(AuthService);

  private mounted = false;

  constructor() {
    effect(() => {
      const show = this.auth.isConfigured && this.auth.isSignedIn();
      if (show && !this.mounted) {
        this.viewContainer.createEmbeddedView(this.template);
        this.mounted = true;
      } else if (!show && this.mounted) {
        this.viewContainer.clear();
        this.mounted = false;
      }
    });
  }
}
