import { Environment } from './environment.interface';

export const environment: Environment = {
  production: true,
  apiBaseUrl: '/api',
  auth: {
    clientId: '',
    authority: '',
    knownAuthorities: [],
    redirectUri: 'https://jotjson.com/',
    postLogoutRedirectUri: 'https://jotjson.com/',
    scopes: []
  },
  appInsightsConnectionString: ''
};
