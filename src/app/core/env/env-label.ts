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
