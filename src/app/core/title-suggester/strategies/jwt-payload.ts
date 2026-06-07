import type { SuggestionStrategy } from '../types';
import { isPlainObject, readString } from './helpers';

/**
 * JWT payload strategy (confidence 90).
 *
 * Detects a decoded JWT payload by looking for `iss` (issuer) plus
 * at least 2 **plausibly typed** supporting registered claims
 * `{ aud, exp, iat, nbf }`. An `iss`-only object is too weak a
 * fingerprint -- random API responses often have an `iss` field for
 * unrelated reasons -- and presence-only counting over-fires on
 * skeleton objects like `{iss:"x",exp:null,iat:null}` whose claim
 * slots are nulled-out placeholders.
 *
 * Plausibility rules (per RFC 7519):
 *  - `aud`: a non-empty string OR a non-empty array of non-empty
 *    strings (StringOrURI / array thereof).
 *  - `exp` / `iat` / `nbf`: a finite number (NumericDate, seconds
 *    since the Unix epoch).
 *
 * Output:
 *  - `"JWT: {iss}"` when `iss` is a short (<= 40 chars) human-friendly
 *    string with at least one non-hex character (matches issuers
 *    like `"https://accounts.google.com"`, `"microsoft-online"`).
 *  - The generic `"JWT payload"` otherwise.
 *
 * **Never falls back to `sub`.** `sub` is typically a stable user /
 * principal identifier. Titles are persisted server-side as blob
 * metadata, so leaking principal IDs into titles is a privacy issue.
 */
const SUPPORTING_REGISTERED_CLAIMS = ['aud', 'exp', 'iat', 'nbf'] as const;
type SupportingRegisteredClaim = (typeof SUPPORTING_REGISTERED_CLAIMS)[number];
const NON_HEX_RE = /[^0-9a-f]/i;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasPlausibleSupportingClaim(
  obj: Record<string, unknown>,
  claim: SupportingRegisteredClaim,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(obj, claim)) return false;
  const value = obj[claim];
  switch (claim) {
    case 'aud':
      if (isNonEmptyString(value)) return true;
      return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
    case 'exp':
    case 'iat':
    case 'nbf':
      return typeof value === 'number' && Number.isFinite(value);
  }
}

export const jwtPayloadStrategy: SuggestionStrategy = (input) => {
  if (!isPlainObject(input.parsed)) return null;
  const obj = input.parsed;
  const iss = readString(obj, 'iss');
  if (iss === null) return null;

  let supportingHits = 0;
  for (const claim of SUPPORTING_REGISTERED_CLAIMS) {
    if (hasPlausibleSupportingClaim(obj, claim)) supportingHits++;
  }
  if (supportingHits < 2) return null;

  const issuerIsHumanFriendly = iss.length <= 40 && NON_HEX_RE.test(iss);
  const value = issuerIsHumanFriendly
    ? $localize`:@@toolbar.titleSuggestion.jwt.withIssuer:JWT: ${iss}:issuer:`
    : $localize`:@@toolbar.titleSuggestion.jwt.generic:JWT payload`;

  return { value, source: 'jwtPayload', confidence: 90 };
};
