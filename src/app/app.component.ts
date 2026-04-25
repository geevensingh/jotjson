import { Component, OnInit, inject, Injector } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth/auth.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit {
  readonly title = 'JotJSON';

  private readonly auth = inject(AuthService);
  private readonly injector = inject(Injector);

  ngOnInit(): void {
    // Process a returning sign-in redirect (if any) and prime the user
    // signal from the MSAL cache. Standalone Angular apps must do this
    // themselves - `MsalRedirectComponent` is an NgModule-era construct.
    void this.auth.initializeFromRedirect();
    // Lazy-load the SW update listener so Material snackbar + the
    // service-worker client runtime stay out of the initial bundle.
    // There is no user-visible work happening in the first few seconds
    // of a page load, so a deferred load is fine.
    void import('./core/update/app-update.service').then(({ AppUpdateService }) => {
      this.injector.get(AppUpdateService).initialize();
    });
  }
}

