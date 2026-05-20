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
 * Escape regex metacharacters in `s` so it can be safely interpolated
 * into a `new RegExp(...)` pattern as a literal. Defends
 * `PREVIEW_PR_RE` against future drift in `NONPROD_SWA_STEM`: if
 * Azure ever recreates the SWA with a stem containing regex
 * metacharacters (e.g. `foo{3}` or `bar.baz`), the escaped form
 * matches the literal stem instead of silently corrupting the regex
 * grammar. The character class matches the canonical ECMA-262
 * metacharacter set (`. * + ? ^ $ { } ( ) | [ ] \`).
 *
 * Previous design used a load-time `REGEX_META_RE.test(...)` guard
 * that threw on metachar-bearing stems. That pattern is structurally
 * fragile -- its own implementation must enumerate every metachar
 * (and it missed `{` `}` until PR #340 review). Escaping at the
 * construction site eliminates the bug class.
 *
 * The inline boot-script mirror at `src/index.html:329` does NOT
 * yet have an equivalent escape; tracked as a separate follow-up
 * (the dual-source "keep in sync" contract at the top of this file).
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
const PREVIEW_PR_RE = new RegExp(`^${escapeRegex(NONPROD_SWA_STEM)}-(\\d+)\\.`);

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
 * Returns `null` when the hostname is not a preview hostname (i.e.
 * does not end with the SWA `.azurestaticapps.net` suffix), or when
 * the slug between the stem and the next `.` is not a single
 * positive integer. Callers should fall back to the plain
 * `[preview]` indicator in the null case.
 *
 * The function gates on `endsWith(SWA_HOSTNAME_SUFFIX)` before
 * matching the regex, mirroring the inline boot script at
 * `src/index.html` which has carried the same gate since the
 * indicator landed. Without the suffix gate, a hostname like
 * `calm-flower-01969880f-123.evil.example.com` would parse to
 * `123` and violate the documented contract -- even though the
 * only in-tree caller (`EnvLabelService`) already pre-gates via
 * `label === 'preview'`, the helper is an exported pure function
 * and a future caller could read it directly.
 *
 * The regex is intentionally strict (`^stem-(\d+)\.`): it rejects
 * non-numeric slugs (`-staging`), multi-segment slugs (`-1-2`),
 * the legacy `-pr-<n>` shape (older Azure SWA preview slots that
 * did not strip the `pr-` prefix), and cross-domain shapes that
 * use the same stem under a different apex. All four fall back
 * to the unprefixed `[preview]` indicator.
 */
export function getPreviewPrNumber(hostname: string): number | null {
  if (!hostname) return null;
  // Suffix gate -- keeps the helper's documented "non-preview
  // hostname -> null" contract honest. Mirrors the inline boot
  // script at `src/index.html`, which already gates the PR-number
  // regex behind the same `endsWith` check.
  if (!hostname.endsWith(SWA_HOSTNAME_SUFFIX)) return null;
  const match = PREVIEW_PR_RE.exec(hostname);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  // PR numbers cannot be 0; reject 0 / negative / NaN as corruption
  // and fall back to [preview]. Azure cannot emit 0 in the slug
  // because GitHub PR numbers start at 1, but defensive guard.
  return parsed > 0 ? parsed : null;
}
