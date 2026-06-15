/**
 * Value humanizers used by suggestion strategies.
 *
 * **English-only by design for v1.** The output of these helpers is
 * baked into suggestion candidates which can be persisted server-side
 * as blob titles. We do NOT derive locale from the app's runtime
 * locale because the same blob viewed by a different user (a public
 * share, an account migration, etc.) should not produce a different-
 * looking title.
 */

let regionNamesInstance: Intl.DisplayNames | null = null;
let regionNamesInitFailed = false;

function getRegionNames(): Intl.DisplayNames | null {
  if (regionNamesInstance !== null) return regionNamesInstance;
  if (regionNamesInitFailed) return null;
  try {
    regionNamesInstance = new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNamesInstance;
  } catch {
    regionNamesInitFailed = true;
    return null;
  }
}

const REGION_CODE_RE = /^[A-Za-z]{2,3}$/;

/**
 * Returns the English region name for an ISO-3166 alpha-2 / alpha-3
 * code (e.g. `"KW"` -> `"Kuwait"`), or the raw code on any failure.
 *
 * Defensive against:
 *  - `Intl.DisplayNames` constructor throwing (older Safari / Node)
 *  - `.of(code)` throwing or returning `undefined` (invalid code,
 *    locale-data gap)
 *  - non-string / wrong-shape inputs
 *
 * Note: the `TitleSuggesterService` does NOT catch per-strategy
 * exceptions, so one un-handled throw from a humanizer would break
 * every suggestion. Belt-and-braces.
 */
export function countryName(code: unknown): string {
  if (typeof code !== 'string') return '';
  const trimmed = code.trim();
  if (!REGION_CODE_RE.test(trimmed)) return trimmed;
  const upper = trimmed.toUpperCase();
  const names = getRegionNames();
  if (names === null) return upper;
  try {
    const resolved = names.of(upper);
    if (typeof resolved === 'string' && resolved.length > 0 && resolved !== upper) {
      return resolved;
    }
    return upper;
  } catch {
    return upper;
  }
}

/**
 * Splits camelCase / PascalCase into space-separated capitalized
 * words. Used to turn API-style identifiers like `chargeInvoiced`
 * into reading-order labels like `Charge Invoiced`.
 *
 * Already-spaced inputs and single-word inputs pass through with the
 * first letter capitalized.
 */
export function verbalize(value: string): string {
  if (value.length === 0) return value;
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const words = spaced.split(/\s+/).filter((w) => w.length > 0);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
