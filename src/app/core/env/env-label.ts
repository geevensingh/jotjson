/**
 * Pure environment-label classification from a hostname.
 *
 * Used by:
 *  - `EnvLabelService` (post-bootstrap Angular code) for the
 *    `EnvPrefixedTitleStrategy` and the favicon-swap initializer.
 *  - A duplicate inline copy in `src/index.html` (pre-bootstrap) so
 *    the indicator paints before Angular hydrates. The dual-source
 *    pattern mirrors `core/boot/resolve-boot-theme.ts`; keep the two
 *    in sync.
 *
 * The label is intentionally hostname-driven (not baked into
 * `environment.prod.ts`) so the same production bundle works
 * unmodified on prod, nonprod, and PR-preview slots.
 */

export type EnvLabel = 'prod' | 'nonprod' | 'preview' | 'dev' | 'unknown';

const PROD_HOSTNAMES: ReadonlySet<string> = new Set(['jotjson.com', 'www.jotjson.com']);

const DEV_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * SWA hostname stem for the nonprod Static Web App.
 *
 * Source of truth: `infra/README.md` (SWA hostname row for the
 * `swa-jotjson-nonprod` resource). The full nonprod hostname is
 * `${NONPROD_SWA_STEM}.<region>.azurestaticapps.net`, where the
 * `<region>` segment can change without notice per Azure (see
 * `infra/README.md` "preview URL" note). We therefore match by
 * stem + `.azurestaticapps.net` suffix only.
 *
 * SWA preview slots inject a slug between the stem and the dot:
 * `${NONPROD_SWA_STEM}-<previewname>.<region>.azurestaticapps.net`.
 *
 * If this constant ever drifts, `env-label.spec.ts` asserts it
 * against the documented stem so CI fails loudly.
 */
export const NONPROD_SWA_STEM = 'calm-flower-01969880f';

const SWA_HOSTNAME_SUFFIX = '.azurestaticapps.net';

// Static load-time assertion that `NONPROD_SWA_STEM` contains no regex
// metacharacters. `PREVIEW_PR_RE` below interpolates the stem unescaped;
// if Azure ever recreates the SWA with a stem containing `.+*?()[]\^$|`,
// the regex would silently match the wrong thing. Fails loud at module
// load so a future stem change cannot quietly corrupt the indicator.
const REGEX_META_RE = /[.+*?()[\]\\^$|]/;
if (REGEX_META_RE.test(NONPROD_SWA_STEM)) {
  throw new Error(
    `NONPROD_SWA_STEM contains a regex metacharacter and would corrupt PREVIEW_PR_RE: ` +
      `${NONPROD_SWA_STEM}. Escape the stem before interpolation in env-label.ts.`,
  );
}

/**
 * Matches SWA preview hostnames that carry a PR number in the slug.
 *
 * Azure SWA emits preview URLs as
 * `${NONPROD_SWA_STEM}-<previewname>.<region>.azurestaticapps.net`,
 * stripping the `pr-` prefix from cd-preview.yml's `PREVIEW_ENV`
 * (`pr-${{ pull_request.number }}` at
 * `.github/workflows/cd-preview.yml:95`). The capture group is the
 * PR number; non-numeric slugs (e.g. `-staging`) and multi-segment
 * slugs (e.g. `-1-2`) deliberately fail to match and fall back to
 * the plain `[preview]` indicator.
 */
const PREVIEW_PR_RE = new RegExp(`^${NONPROD_SWA_STEM}-(\\d+)\\.`);

/**
 * Classify a hostname into a coarse environment label.
 *
 * Returns `'unknown'` for empty / unrecognized hostnames so the
 * indicator fails noisy (a misclassified prod alias shows
 * `[unknown]` rather than silently looking like prod). The
 * `envLabel` telemetry dimension on `app.boot` catches it in
 * App Insights too.
 */
export function getEnvLabel(hostname: string): EnvLabel {
  if (!hostname) return 'unknown';
  if (PROD_HOSTNAMES.has(hostname)) return 'prod';
  if (DEV_HOSTNAMES.has(hostname)) return 'dev';
  if (hostname.endsWith(SWA_HOSTNAME_SUFFIX)) {
    const stem = hostname.slice(0, hostname.length - SWA_HOSTNAME_SUFFIX.length);
    if (stem.startsWith(`${NONPROD_SWA_STEM}.`)) return 'nonprod';
    if (stem.startsWith(`${NONPROD_SWA_STEM}-`)) return 'preview';
  }
  return 'unknown';
}

/**
 * Extract the PR number from a SWA preview hostname.
 *
 * Returns `null` when the hostname is not a preview hostname, or
 * when the slug between the stem and the next `.` is not a single
 * positive integer. Callers should fall back to the plain
 * `[preview]` indicator in the null case.
 *
 * The regex is intentionally strict (`^stem-(\d+)\.`): it rejects
 * non-numeric slugs (`-staging`), multi-segment slugs (`-1-2`),
 * and the legacy `-pr-<n>` shape (older Azure SWA preview slots
 * that did not strip the `pr-` prefix). All three fall back to
 * the unprefixed `[preview]` indicator.
 */
export function getPreviewPrNumber(hostname: string): number | null {
  if (!hostname) return null;
  const match = PREVIEW_PR_RE.exec(hostname);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  // PR numbers cannot be 0; reject 0 / negative / NaN as corruption
  // and fall back to [preview]. Azure cannot emit 0 in the slug
  // because GitHub PR numbers start at 1, but defensive guard.
  return parsed > 0 ? parsed : null;
}
