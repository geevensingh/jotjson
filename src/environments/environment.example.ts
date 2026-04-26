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
    scopes: []
  },
  appInsightsConnectionString: ''
};
