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
  }
};
