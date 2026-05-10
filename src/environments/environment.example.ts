// Template for src/environments/environment.ts (gitignored).
// Copy to environment.ts and fill in real values for local development.
// Production builds use environment.prod.ts via Angular's fileReplacements;
// CI copies this file to environment.ts so the dev import resolves cleanly
// even though no real auth values are used at production build time.
import { Environment } from './environment.interface';

export const environment: Environment = {
  production: false,
  apiBaseUrl: '/api',
  auth: {
    clientId: '',
    authority: '',
    knownAuthorities: [],
    redirectUri: 'http://localhost:4200/',
    postLogoutRedirectUri: 'http://localhost:4200/',
    scopes: [],
  },
  appInsightsConnectionString: '',
  // Optional: local-only dev-auth bypass. Uncomment to skip MSAL on
  // localhost and impersonate a fake signed-in user. Pair with
  // `JOTJSON_DEV_AUTH_BYPASS=true` in `api/local.settings.json`. See
  // AGENTS.md "Local-only dev-auth bypass" for details.
  //
  // devAuth: {
  //   enabled: true,
  //   userId: 'dev-user-1',
  //   displayName: 'Dev User',
  //   email: 'dev-user-1@dev.local'
  // }
};
