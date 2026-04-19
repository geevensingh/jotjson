export interface Environment {
  production: boolean;
  apiBaseUrl: string;
  auth: {
    /** Application (client) ID of the SPA app registration. */
    clientId: string;
    /** Authority URL (e.g. https://<subdomain>.ciamlogin.com/<tenantId>/). */
    authority: string;
    /** Known authorities; typically the bare host portion of `authority`. */
    knownAuthorities: string[];
    /** SPA redirect URI registered in Entra for this environment. */
    redirectUri: string;
    /** Where to return after sign-out. */
    postLogoutRedirectUri: string;
    /**
     * Scopes to request when acquiring an access token for the JotJSON API.
     * Typically `['api://<apiClientId>/access_as_user']`.
     */
    scopes: string[];
  };
}
