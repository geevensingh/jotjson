/// <reference types="@angular/localize" />

import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent, appConfig).catch((err: unknown) => {
  // Pre-Angular bootstrap failures land here. Persist a sanitized
  // record to sessionStorage so `LoggerService.connect()` can replay
  // it as a `boot.failed` exception once telemetry comes online -
  // assuming Angular itself eventually bootstraps. If it doesn't,
  // there is nothing else we can do from outside the framework.
  try {
    const name = err instanceof Error ? err.name || 'Error' : 'BootError';
    const message =
      err instanceof Error
        ? (err.message ?? '').slice(0, 500)
        : '<non-error thrown at bootstrap>';
    sessionStorage.setItem(
      'jotjson.bootErr',
      JSON.stringify({ name, message })
    );
  } catch {
    // sessionStorage may be unavailable (privacy mode); ignore.
  }
  // Always surface to DevTools so dev-time bootstrap failures are
  // discoverable without telemetry.
  // eslint-disable-next-line no-console
  console.error(err);
});
