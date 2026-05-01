/// <reference types="@angular/localize" />

import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent, appConfig)
  .then(async () => {
    try {
      const { BUILD_INFO } = await import('./generated/build-info');
      const sha = BUILD_INFO.sha;
      const isDev = sha === 'dev';
      const shortSha = isDev ? 'dev' : sha.slice(0, 7);
      const url =
        isDev || !BUILD_INFO.repoUrl
          ? ''
          : ` ${BUILD_INFO.repoUrl}/commit/${sha}`;
      // eslint-disable-next-line no-console
      console.info(`JotJSON v${BUILD_INFO.version} (${shortSha})${url}`);
    } catch {
      // Banner emission is best-effort; never let a failure leak to the
      // bootstrap-error path below.
    }
  })
  .catch((error: unknown) => {
    // Pre-Angular bootstrap failures land here. Persist a sanitized
    // record to sessionStorage so `LoggerService.connect()` can replay
    // it as a `boot.failed` exception once telemetry comes online -
    // assuming Angular itself eventually bootstraps. If it doesn't,
    // there is nothing else we can do from outside the framework.
    try {
      const name = error instanceof Error ? error.name || 'Error' : 'BootError';
      const message =
        error instanceof Error
          ? (error.message ?? '').slice(0, 500)
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
    console.error(error);
  });
