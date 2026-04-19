import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { AuthService } from '../../core/auth/auth.service';
import { IconComponent } from '../../shared/components/icon/icon.component';

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [MatButtonModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './profile.component.html',
  styleUrl: './profile.component.scss'
})
export class ProfileComponent {
  private readonly auth = inject(AuthService);

  readonly user = this.auth.user;
  readonly isSignedIn = this.auth.isSignedIn;
  readonly isConfigured = this.auth.isConfigured;

  onSignIn(): void {
    this.auth.signIn();
  }

  onSignOut(): void {
    this.auth.signOut();
  }
}
