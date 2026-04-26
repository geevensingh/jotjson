/**
 * PII redaction helpers for telemetry.
 *
 * The JotJSON privacy stance forbids transmitting user emails, UPNs, or
 * other personally identifying strings. MSAL error messages and stack
 * traces can include these incidentally; this module scrubs them before
 * any string is forwarded to App Insights.
 *
 * GUIDs are intentionally NOT redacted - they are the opaque identifiers
 * we rely on (e.g. Entra `oid` for `setUser`, AAD correlation IDs).
 */

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// AAD UPN-style identifiers can also appear as `user@tenant.onmicrosoft.com`
// which the email regex already catches. Add a bare-UPN pattern for cases
// where the host portion was already replaced or where MSAL emits the
// `name@host` shape inside structured strings.
const UPN_PATTERN = /(^|[\s'"<(])([a-zA-Z0-9._-]+)@(?=[a-zA-Z0-9.-]*\.)/g;

const AADSTS_PATTERN = /AADSTS\d{4,}/;

/**
 * Replace email/UPN substrings with `<email>`. Idempotent - calling on an
 * already-redacted string is a no-op for the redacted spans.
 */
export function redactPii(input: string): string {
  if (!input) {
    return input;
  }
  return input
    .replace(EMAIL_PATTERN, '<email>')
    .replace(UPN_PATTERN, (_match, prefix) => `${prefix}<user>@`);
}

/**
 * Extract the first `AADSTS\d+` code from a string, if present. Useful for
 * routing MSAL telemetry into a structured `props.aadCode` field.
 */
export function extractAadCode(input: string): string | undefined {
  const match = AADSTS_PATTERN.exec(input);
  return match ? match[0] : undefined;
}

/** Truncate a string to at most `max` characters; appends an ellipsis. */
export function truncate(input: string, max: number): string {
  if (!input) {
    return input;
  }
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, max - 1)}\u2026`;
}
