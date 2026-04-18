import { Environment } from './environment.interface';

export const environment: Environment = {
  production: true,
  apiBaseUrl: '/api',
  b2c: {
    clientId: '',
    authority: '',
    knownAuthorities: [],
    redirectUri: 'https://jotjson.com/',
    scopes: []
  }
};
