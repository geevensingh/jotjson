/// <reference types="@angular/localize" />

import { BootstrapContext, bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { config } from './app/app.config.server';

/**
 * Server bootstrap entry. Used by `@angular/ssr` during static
 * prerender (configured via `outputMode: "static"` and per-route
 * render modes in `src/app/app.routes.server.ts`). Each prerendered
 * route (`/`, `/404` for M7h) bootstraps a fresh AppComponent in
 * Node, walks the route tree, and emits the resulting HTML to disk.
 *
 * The browser bootstrap entry (`src/main.ts`) is unchanged and
 * continues to be the runtime bootstrap for the SPA. Both share the
 * platform-agnostic providers in `sharedProviders` (see
 * `app.config.ts`); each adds its own platform-specific tail (real
 * MSAL + service worker + AuthService initializer in the browser;
 * MSAL stubs only on the server).
 *
 * The `BootstrapContext` argument is required by `@angular/ssr`
 * (Angular 21+); without it `bootstrapApplication` throws
 * `NG0401: Missing Platform` because the SSR pipeline expects to
 * supply the platform-server platform via the context.
 */
const bootstrap = (context: BootstrapContext): Promise<unknown> =>
  bootstrapApplication(AppComponent, config, context);

export default bootstrap;
