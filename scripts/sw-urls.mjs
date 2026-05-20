// scripts/sw-urls.mjs
//
// Node-script URL constants for the SW migration enforcement
// surface. NOT a true SSoT -- the same literals are duplicated
// in staticwebapp.config.json (JSON has no imports), in
// src/sw.worker.ts (the IDB DB name and store name), in
// src/app/core/telemetry/sw-registration.ts (the canonical URL
// used in register('/sw.js')), and in any Bicep files that
// reference the URLs. The duplicates are enforced by
// check-swa-config.mjs (asserts the JSON config matches these
// constants) and check-sw-shape.mjs (asserts the SW worker file
// and registration code use the canonical URLs).
//
// If you change a constant here, run `npm run lint:all` -- the
// linter will fail loudly until every duplicate is updated.
//
// See docs/sw-migration.md for the post-merge runbook and
// DESIGN_SPEC.md PWA section for the architectural decision.

export const SW_CANONICAL_URL = '/sw.js';

// Permanent passthrough alias. The pre-migration ngsw cohort is
// registered at this URL with scope `/`; the browser's periodic
// script-byte revalidation fires against this URL, so the new
// minimal SW MUST be served here too (byte-identical to
// SW_CANONICAL_URL) for the stuck cohort to ever unstick.
// Retirement is NOT planned -- see Phase 7 of the SW migration plan
// for the (deliberately narrow) forcing-function criteria.
export const SW_LEGACY_ALIAS_URLS = ['/ngsw-worker.js'];

// The pre-migration ngsw periodically polls this URL for a new
// manifest. After migration we serve an inert `{}` stub so the
// OLD ngsw concludes "no new version" instead of entering its
// `unrecoverable` state. The stub is a build-emitted file at
// `dist/jotjson/browser/ngsw.json` (NOT a route handler -- SWA
// routes cannot return JSON literal bodies).
export const NGSW_JSON_STUB_URL = '/ngsw.json';

// Per-deploy freshness marker emitted by
// `scripts/write-build-info-asset.mjs` (postbuild). The deployed
// file's payload is BYTEWISE-IDENTICAL to the SPA bundle's
// `BUILD_INFO` constant because postbuild reads back the prebuild-
// emitted `src/generated/build-info.ts` rather than recomputing.
// `scripts/check-deploy-freshness.mjs` polls this URL during the
// post-deploy gate and asserts `body.sha === expectedSha` to verify
// edge propagation is tied to the deployed commit (not merely
// byte-matching a SW source file that is locked to a constant SHA
// by `scripts/check-sw-shape.mjs`). MUST be served with
// `Cache-Control: no-store` -- asserted by
// `scripts/check-swa-config.mjs` against
// `staticwebapp.config.json`.
export const BUILD_INFO_ASSET_URL = '/build-info.json';

export const SW_ALL_URLS = [SW_CANONICAL_URL, ...SW_LEGACY_ALIAS_URLS];
