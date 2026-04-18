export interface Environment {
  production: boolean;
  apiBaseUrl: string;
  b2c: {
    clientId: string;
    authority: string;
    knownAuthorities: string[];
    redirectUri: string;
    scopes: string[];
  };
}
