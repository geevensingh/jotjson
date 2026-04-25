import { Component, OnInit, inject, Injector } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit {
  readonly title = 'JotJSON';

  private readonly injector = inject(Injector);

  ngOnInit(): void {
    // Note: returning-redirect handling and `AuthService.userSignal`
    // hydration are driven from `provideAppInitializer` in `app.config.ts`
    // so the router waits for MSAL before activating routes (otherwise
    // resolvers race the bearer token).
    //
    // Lazy-load the SW update listener so Material snackbar + the
    // service-worker client runtime stay out of the initial bundle.
    // There is no user-visible work happening in the first few seconds
    // of a page load, so a deferred load is fine.
    void import('./core/update/app-update.service').then(({ AppUpdateService }) => {
      this.injector.get(AppUpdateService).initialize();
    });
  }
}

