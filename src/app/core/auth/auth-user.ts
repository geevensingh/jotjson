/**
 * Normalized view of an authenticated user, derived from the MSAL
 * `AccountInfo` + ID token claims. Kept small and UI-friendly: components
 * should not have to reach into MSAL types directly.
 */
export interface AuthUser {
  /** Stable Entra object id - `oid` claim, falling back to `sub`. */
  id: string;
  /** Display name - `name` claim, falling back to the account `username`. */
  displayName: string;
  /**
   * Email address if the IdP released one. Not guaranteed: social providers
   * may omit it and the user may not have granted the email scope. UI that
   * shows the email must handle the missing case.
   */
  email?: string;
}
