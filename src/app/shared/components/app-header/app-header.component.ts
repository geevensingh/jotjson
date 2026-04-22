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
 *  - Auth cluster on the right (user display name + sign-in/out button, or
 *    a disabled sign-in button when auth is not configured).
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

  onSignOut(): void {
    this.auth.signOut();
  }
}
