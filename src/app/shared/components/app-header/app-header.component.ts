import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../../core/auth/auth.service';
import { IconComponent } from '../icon/icon.component';

/**
 * Persistent app-level header. Owns the two globally-consistent pieces of
 * chrome for every route:
 *  - Brand wordmark on the left, linking back to `/`.
 *  - Auth affordance on the right. When signed in, shows the user's display
 *    name as a link to `/profile` (where sign-out lives). When signed out,
 *    shows a sign-in button, or a disabled placeholder if auth is not
 *    configured.
 *
 * Feature pages project their own middle-slot controls via `<ng-content>`.
 * Centralizing brand + auth here prevents new routes from silently
 * forgetting either affordance.
 */
@Component({
  selector: 'jj-app-header',
  standalone: true,
  imports: [MatButtonModule, MatTooltipModule, RouterLink, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-header.component.html',
  styleUrl: './app-header.component.scss'
})
export class AppHeaderComponent {
  private readonly auth = inject(AuthService);

  readonly user = this.auth.user;
  readonly isSignedIn = this.auth.isSignedIn;
  readonly authConfigured = this.auth.isConfigured;

  onSignIn(): void {
    this.auth.signIn();
  }
}
