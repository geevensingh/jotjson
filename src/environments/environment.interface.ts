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
  /**
   * Application Insights connection string. When empty, telemetry is
   * disabled (typical for local development and CI). Production builds
   * receive this via CD secret substitution into `environment.prod.ts`.
   */
  appInsightsConnectionString?: string;
  /**
   * Local-only dev-auth bypass. When `enabled`, the SPA short-circuits
   * MSAL entirely - the Sign in / Sign out buttons toggle between the
   * configured fake persona and anonymous via a `localStorage` flag,
   * and the auth interceptor sends `Bearer dev:<userId>` instead of a
   * real access token. The backend honors the synthetic token only
   * when `JOTJSON_DEV_AUTH_BYPASS=true` AND it is not running in
   * Azure (no `WEBSITE_INSTANCE_ID` / `WEBSITE_HOSTNAME`).
   *
   * Never set in production builds. The `userId` must match the
   * backend validator regex `^[a-z0-9_-]{1,64}$`; otherwise dev-auth
   * fails closed and falls back to MSAL-only behavior.
   */
  devAuth?: {
    enabled: boolean;
    userId: string;
    displayName: string;
    email?: string;
  };
}
