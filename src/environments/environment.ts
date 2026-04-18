import { Environment } from './environment.interface';

export const environment: Environment = {
  production: false,
  apiBaseUrl: '/api',
  b2c: {
    clientId: '',
    authority: '',
    knownAuthorities: [],
    redirectUri: 'http://localhost:4200/',
    scopes: []
  }
};
