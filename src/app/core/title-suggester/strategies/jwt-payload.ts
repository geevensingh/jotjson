import type { SuggestionStrategy } from '../types';
import { isPlainObject, readString } from './helpers';

/**
 * JWT payload strategy (confidence 90).
 *
 * Detects a decoded JWT payload by looking for `iss` (issuer) plus
 * at least 2 of the registered claims `{ aud, exp, iat, nbf }`. An
 * `iss`-only object is too weak a fingerprint -- random API
 * responses often have an `iss` field for unrelated reasons.
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
const REGISTERED_TIME_CLAIMS = ['aud', 'exp', 'iat', 'nbf'] as const;
const NON_HEX_RE = /[^0-9a-f]/i;

export const jwtPayloadStrategy: SuggestionStrategy = (input) => {
  if (!isPlainObject(input.parsed)) return null;
  const obj = input.parsed;
  const iss = readString(obj, 'iss');
  if (iss === null) return null;

  let supportingHits = 0;
  for (const claim of REGISTERED_TIME_CLAIMS) {
    if (Object.prototype.hasOwnProperty.call(obj, claim)) supportingHits++;
  }
  if (supportingHits < 2) return null;

  const issuerIsHumanFriendly = iss.length <= 40 && NON_HEX_RE.test(iss);
  const value = issuerIsHumanFriendly
    ? $localize`:@@toolbar.titleSuggestion.jwt.withIssuer:JWT: ${iss}:issuer:`
    : $localize`:@@toolbar.titleSuggestion.jwt.generic:JWT payload`;

  return { value, source: 'jwtPayload', confidence: 90 };
};
