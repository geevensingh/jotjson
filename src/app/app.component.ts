import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth/auth.service';
import { AppHeaderComponent } from './shared/components/app-header/app-header.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, AppHeaderComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit {
  readonly title = 'JotJSON';

  private readonly auth = inject(AuthService);

  ngOnInit(): void {
    // Process a returning sign-in redirect (if any) and prime the user
    // signal from the MSAL cache. Standalone Angular apps must do this
    // themselves - `MsalRedirectComponent` is an NgModule-era construct.
    void this.auth.initializeFromRedirect();
  }
}

