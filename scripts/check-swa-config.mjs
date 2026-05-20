#!/usr/bin/env node
// Validates structural assertions on `staticwebapp.config.json` beyond the
// CSP scope of `scripts/check-csp-hashes.mjs`. Catches regression classes
// like the `5c4c937` `X-Frame-Options` drift that shipped to prod and
// broke MSAL silent SSO, plus the stale-SW class from #167 (someone
// dropping or weakening a required Cache-Control route rule).
//
// Tracks issue #134's Option 3. The structural ceiling of this gate is
// "what the config file says," not "what the deployed CDN serves" -
// Front Door compression can strip `Content-Length`, the SWA platform
// can misinterpret a directive, etc. Catching those classes is what
// preview environments (#179) are for; this gate is the lint-time
// always-on defense in depth below preview envs.
//
// Runs with zero dependencies on Node 24+. Invoke directly or via:
//   npm run lint:swa-config
//   node scripts/check-swa-config.mjs
//
// Sibling to `check-csp-hashes.mjs` rather than an extension because the
// failure-message UX (header value drift vs CSP-hash drift) is different
// enough that combining them would muddy the per-gate fix command in
// CI's Lint summary rollup.

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { BUILD_INFO_ASSET_URL } from './sw-urls.mjs';

export const SWA_CONFIG = 'staticwebapp.config.json';

// ---------------------------------------------------------------------------
// Required values
// ---------------------------------------------------------------------------

// Drift in either direction is a regression: `DENY` re-breaks MSAL silent
// SSO (the original `5c4c937` fix went `DENY` -> `SAMEORIGIN` for exactly
// that reason); a permissive value re-opens same-origin-clickjacking
// protection. See DESIGN_SPEC.md Security -> Global response headers.
export const REQUIRED_X_FRAME_OPTIONS = 'SAMEORIGIN';

export const REQUIRED_X_CONTENT_TYPE_OPTIONS = 'nosniff';

// One year. RFC 6797 floor for a meaningful HSTS commitment; matches the
// value documented in the spec and shipped today.
export const REQUIRED_HSTS_MIN_MAX_AGE = 31536000;

export const REQUIRED_REFERRER_POLICY = 'strict-origin-when-cross-origin';

// Exact-byte match against the form documented in DESIGN_SPEC.md:1194.
// Avoids substring-match brittleness against the two valid RFC 8941
// structured-field forms (`(self)` vs `("self")`); the spec form is what
// we commit to.
export const REQUIRED_PERMISSIONS_POLICY = 'clipboard-read=(self), clipboard-write=(self)';

// Prerender-aware split (AGENTS.md "Server-platform safety"). Breaking this
// dumps SPA users onto the prerendered `index.html` shell, killing all
// client routing.
export const REQUIRED_NAVIGATION_REWRITE = '/shell.html';

// `/api/*` must be excluded from the SPA navigation fallback or every API
// call gets rewritten to the shell.
export const REQUIRED_API_EXCLUDE = '/api/*';

// Extensions covered by `navigationFallback.exclude` so a missing
// file 404s at the edge instead of returning the SPA shell. Originally
// scoped to SW-prefetched assets, but the same exclusion is what
// keeps a missing `/build-info.json` (per-deploy SHA marker emitted by
// scripts/write-build-info-asset.mjs) surfacing as a clear 404 rather
// than a confusing "SHA mismatch: got `<!DOCTYPE html>`..." failure
// in the freshness gate.
export const REQUIRED_ASSET_EXTENSIONS = Object.freeze([
  'js',
  'css',
  'map',
  'svg',
  'ico',
  'png',
  'jpg',
  'webp',
  'woff',
  'woff2',
  'webmanifest',
  'json',
]);

// Service worker gateway: the manifest plus the canonical and legacy
// worker scripts. These MUST be `no-store` (not `no-cache,
// must-revalidate`) because Azure SWA returns a stuck ETag
// ("20260402") that makes conditional GETs perpetually return 304,
// freezing the service-worker update flow. See issue #167 and
// DESIGN_SPEC.md cache-header rationale.
//
// `/sw.js` is the canonical URL the new minimal SW registers at.
// `/ngsw-worker.js` is the permanent passthrough alias - the URL
// the OLD `@angular/service-worker` cohort is registered on; the
// browser's 24h byte-revalidation against this URL delivers the new
// minimal SW bytes (byte-identical to `/sw.js` per `scripts/
// build-sw.mjs`) so stuck users unstick. `/ngsw.json` is a
// build-emitted `{}` stub kept alive so the OLD ngsw's periodic
// poll returns 200 with an inert manifest rather than entering the
// `unrecoverable` failure state mid-migration.
export const SW_GATEWAY_PATHS = Object.freeze(['/sw.js', '/ngsw-worker.js', '/ngsw.json']);

export const SW_GATEWAY_CACHE_CONTROL = 'no-store';

// Hashed-asset immutable cache rules. Angular emits hashed filenames
// like `main-A1B2C3D4.js` directly in `dist/jotjson/browser/`; serving
// them with `Cache-Control: public, max-age=31536000, immutable`
// closes the gap between losing ngsw's cached-asset story and the
// previous "fresh-from-network on every visit" SWA default
// (`must-revalidate, max-age=30`). CRITICAL ORDERING: these rules
// MUST come AFTER all `SW_GATEWAY_PATHS` and `SHELL_PATHS` entries in
// `staticwebapp.config.json`. SWA processes routes top-to-bottom; if
// `/*.js` preceded `/sw.js`, the SW gateway would get `immutable`
// headers and the 24h byte-revalidation could not see new bytes for
// a year - bricking the whole migration mechanism. The
// route-order assertion in `checkRoutes` catches this drift.
export const IMMUTABLE_ASSET_PATHS = Object.freeze(['/*.js', '/*.css', '/*.woff2']);

export const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

// HTML shell paths: must revalidate but stay on `no-cache, must-revalidate`
// (not `no-store`) to preserve bfcache eligibility on the prerendered `/`
// route. The shells are downstream of the SW manifest decision -- if the
// manifest is fresh, the shell choice is moot; if the manifest is stale,
// no shell header can fix it.
export const SHELL_PATHS = Object.freeze(['/index.html', '/shell.html', '/404/index.html']);

export const SHELL_CACHE_CONTROL = 'no-cache, must-revalidate';

// Allowlist (not a regex floor) because SWA's supported Functions runtime
// set is small and explicit. A regex like `^node:\d+$` would silently
// accept `node:14` or `node:16` (both EOL on Azure).
export const SUPPORTED_API_RUNTIMES = Object.freeze(['node:20', 'node:22']);

// PWA install requires this exact MIME for `.webmanifest` files.
export const REQUIRED_WEBMANIFEST_MIME = 'application/manifest+json';

// Other MIME entries we depend on. Asserting them keeps a future
// contributor from silently dropping them.
export const REQUIRED_MIME_TYPES = Object.freeze({
  '.webmanifest': REQUIRED_WEBMANIFEST_MIME,
  '.json': 'application/json',
  '.map': 'application/json',
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function readConfig(configPath = SWA_CONFIG) {
  const raw = readFileSync(configPath, 'utf8');
  return JSON.parse(raw);
}

// Expands brace patterns like `*.{js,css}` into `['*.js', '*.css']`.
// Handles a single brace group per pattern (the only shape used in our
// config today); recurses to support multiple groups should they appear.
// Entries without braces pass through unchanged.
export function expandBraceGlob(pattern) {
  const open = pattern.indexOf('{');
  if (open < 0) return [pattern];
  const close = pattern.indexOf('}', open);
  if (close < 0) return [pattern];
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const options = pattern.slice(open + 1, close).split(',');
  const out = [];
  for (const option of options) {
    const expanded = `${prefix}${option}${suffix}`;
    for (const further of expandBraceGlob(expanded)) {
      out.push(further);
    }
  }
  return out;
}

// Given an array of `navigationFallback.exclude` entries, returns the set
// of extensions that any entry of the form `*.EXT` (or via brace
// expansion) covers. Used to assert the canonical static-asset set is
// excluded, regardless of how a contributor splits the brace list.
export function getExcludedExtensions(excludeEntries) {
  const extensions = new Set();
  for (const entry of excludeEntries) {
    for (const expanded of expandBraceGlob(entry)) {
      const match = /^\/?\*\.([a-zA-Z0-9]+)$/.exec(expanded);
      if (match) {
        extensions.add(match[1].toLowerCase());
      }
    }
  }
  return extensions;
}

// Converts a SWA route pattern to a regex. `**` matches across segments,
// Convert a SWA route pattern to a regex anchored at start/end. SWA
// wildcard syntax (https://learn.microsoft.com/en-us/azure/static-web-apps/configuration#wildcard-pattern):
//   - `*` is only valid at the END of a route pattern.
//   - `*` matches any characters, INCLUDING slashes (multi-segment).
//   - `*.{ext1,ext2,...}` at the end filters by one of several extensions.
//   - `*.ext` at the end filters by a single extension.
// SWA does NOT define `**`. Defensively we collapse any `**+` run to a
// single `*` so a contributor writing `/**` cannot silently bypass the
// route-order shadowing check by leaning on a non-SWA token.
// Other regex metacharacters in the literal prefix are escaped. Used to
// detect whether a wildcard route preceding the exact cache-controlled
// paths would shadow them.
export function routePatternToRegex(pattern) {
  const collapsed = pattern.replace(/\*\*+/g, '*');
  const trailing = /\*(?:\.\{([^}]+)\}|\.([A-Za-z0-9]+))?$/.exec(collapsed);

  if (!trailing) {
    const escaped = collapsed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped}$`);
  }

  const prefix = collapsed.slice(0, trailing.index);
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (trailing[1] !== undefined) {
    const exts = trailing[1]
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`^${escapedPrefix}.*\\.(?:${exts.join('|')})$`);
  }

  if (trailing[2] !== undefined) {
    const ext = trailing[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escapedPrefix}.*\\.${ext}$`);
  }

  return new RegExp(`^${escapedPrefix}.*$`);
}

export function routeMatchesPath(routePattern, path) {
  return routePatternToRegex(routePattern).test(path);
}

// ---------------------------------------------------------------------------
// Assertion blocks (pure, each returns string[] of errors)
// ---------------------------------------------------------------------------

// NOTE: When adding, removing, or renaming a header in
// `staticwebapp.config.json` `globalHeaders`, three places must be kept in
// sync (per Phase 2 cleanup #220):
//   1. `staticwebapp.config.json` `globalHeaders` (the source of truth).
//   2. `checkGlobalHeaders()` below (this source-level lint).
//   3. `e2e/preview/security-headers.spec.ts` (deployed-response check
//      against an Azure SWA preview host; runs only when
//      `PLAYWRIGHT_BASE_URL` is set).
// The source lint asserts the config file declares the header; the
// deployed-response spec proves no platform/edge layer strips or
// rewrites it between SWA and the browser. Both gates are needed.
export function checkGlobalHeaders(config) {
  const errors = [];
  const headers = config?.globalHeaders ?? {};

  if (headers['X-Frame-Options'] !== REQUIRED_X_FRAME_OPTIONS) {
    errors.push(
      `globalHeaders['X-Frame-Options'] must be '${REQUIRED_X_FRAME_OPTIONS}' ` +
        `(got: ${JSON.stringify(headers['X-Frame-Options'])}). ` +
        `Drift to 'DENY' re-breaks MSAL silent SSO; drift to a permissive ` +
        `value re-opens same-origin-clickjacking protection.`,
    );
  }

  if (headers['X-Content-Type-Options'] !== REQUIRED_X_CONTENT_TYPE_OPTIONS) {
    errors.push(
      `globalHeaders['X-Content-Type-Options'] must be '${REQUIRED_X_CONTENT_TYPE_OPTIONS}' ` +
        `(got: ${JSON.stringify(headers['X-Content-Type-Options'])}).`,
    );
  }

  const hsts = headers['Strict-Transport-Security'];
  if (typeof hsts !== 'string') {
    errors.push(`globalHeaders['Strict-Transport-Security'] is missing.`);
  } else {
    const maxAgeMatch = /(?:^|;|\s)\s*max-age\s*=\s*(\d+)/i.exec(hsts);
    if (!maxAgeMatch) {
      errors.push(
        `globalHeaders['Strict-Transport-Security'] is missing 'max-age=...' (got: ${JSON.stringify(hsts)}).`,
      );
    } else if (Number(maxAgeMatch[1]) < REQUIRED_HSTS_MIN_MAX_AGE) {
      errors.push(
        `globalHeaders['Strict-Transport-Security'] max-age=${maxAgeMatch[1]} ` +
          `is below the required floor of ${REQUIRED_HSTS_MIN_MAX_AGE} (1 year).`,
      );
    }
    if (!/(?:^|;|\s)\s*includeSubDomains\b/i.test(hsts)) {
      errors.push(
        `globalHeaders['Strict-Transport-Security'] is missing 'includeSubDomains' ` +
          `(got: ${JSON.stringify(hsts)}).`,
      );
    }
  }

  if (headers['Referrer-Policy'] !== REQUIRED_REFERRER_POLICY) {
    errors.push(
      `globalHeaders['Referrer-Policy'] must be '${REQUIRED_REFERRER_POLICY}' ` +
        `(got: ${JSON.stringify(headers['Referrer-Policy'])}).`,
    );
  }

  if (headers['Permissions-Policy'] !== REQUIRED_PERMISSIONS_POLICY) {
    errors.push(
      `globalHeaders['Permissions-Policy'] must be exactly '${REQUIRED_PERMISSIONS_POLICY}' ` +
        `(got: ${JSON.stringify(headers['Permissions-Policy'])}). ` +
        `Asserting byte-equality against the spec form rather than substring-matching ` +
        `keeps the gate robust to RFC 8941 structured-field reformats.`,
    );
  }

  if (
    typeof headers['Content-Security-Policy'] !== 'string' ||
    !headers['Content-Security-Policy']
  ) {
    errors.push(
      `globalHeaders['Content-Security-Policy'] is missing. ` +
        `Detailed CSP-shape checks are delegated to check-csp-hashes.mjs; this gate ` +
        `only asserts the header exists at all.`,
    );
  }

  return errors;
}

export function checkNavigationFallback(config) {
  const errors = [];
  const fallback = config?.navigationFallback;
  if (!fallback || typeof fallback !== 'object') {
    errors.push(`navigationFallback is missing or not an object.`);
    return errors;
  }
  if (fallback.rewrite !== REQUIRED_NAVIGATION_REWRITE) {
    errors.push(
      `navigationFallback.rewrite must be '${REQUIRED_NAVIGATION_REWRITE}' ` +
        `(got: ${JSON.stringify(fallback.rewrite)}). The prerender-aware split ` +
        `(AGENTS.md Server-platform safety) depends on /shell.html being the SPA fallback.`,
    );
  }
  const excludeEntries = Array.isArray(fallback.exclude) ? fallback.exclude : [];
  if (!excludeEntries.includes(REQUIRED_API_EXCLUDE)) {
    errors.push(
      `navigationFallback.exclude must include '${REQUIRED_API_EXCLUDE}'. Otherwise ` +
        `API calls get rewritten to ${REQUIRED_NAVIGATION_REWRITE}.`,
    );
  }
  const covered = getExcludedExtensions(excludeEntries);
  const missing = REQUIRED_ASSET_EXTENSIONS.filter((ext) => !covered.has(ext));
  if (missing.length) {
    errors.push(
      `navigationFallback.exclude does not cover required static-asset extensions: ` +
        `${missing.join(', ')}. Service-worker asset prefetch breaks if any get rewritten ` +
        `to ${REQUIRED_NAVIGATION_REWRITE}.`,
    );
  }
  return errors;
}

export function checkRoutes(config) {
  const errors = [];
  const routes = Array.isArray(config?.routes) ? config.routes : null;
  if (!routes) {
    errors.push(`routes is missing or not an array.`);
    return errors;
  }

  const apiRoute = routes.find((route) => route?.route === '/api/*');
  if (!apiRoute) {
    errors.push(`routes is missing the '/api/*' entry.`);
  } else {
    const allowedRoles = Array.isArray(apiRoute.allowedRoles) ? apiRoute.allowedRoles : [];
    if (!allowedRoles.includes('anonymous')) {
      errors.push(
        `routes['/api/*'].allowedRoles must include 'anonymous'. ` +
          `SWA treats 'anonymous' as 'all users including authenticated', so this is the ` +
          `minimum required to preserve the public blob read path documented in ` +
          `DESIGN_SPEC.md Security. (Listing 'authenticated' alongside 'anonymous' is ` +
          `redundant and intentionally not required.)`,
      );
    }
  }

  const cacheControlRouteGroups = [
    {
      groupName: 'service worker gateway',
      paths: SW_GATEWAY_PATHS,
      requiredCacheControl: SW_GATEWAY_CACHE_CONTROL,
    },
    {
      groupName: 'HTML shell',
      paths: SHELL_PATHS,
      requiredCacheControl: SHELL_CACHE_CONTROL,
    },
    {
      // Per-deploy SHA marker emitted by scripts/write-build-info-asset.mjs.
      // `no-store` is required so the post-deploy freshness gate's
      // canonical-URL assertion (assertBuildInfoJson) can rely on the edge
      // serving the latest deploy's marker without any intermediate cache
      // pinning a stale value. See issue #336.
      groupName: 'build-info marker',
      paths: [BUILD_INFO_ASSET_URL],
      requiredCacheControl: 'no-store',
    },
  ];

  // Route-order shadowing: any wildcard route that precedes one of the
  // exact cache-controlled paths AND whose pattern matches that path would
  // hijack the Cache-Control header for that path without deleting the
  // explicit rule. Catch the bug class even when the rules themselves
  // are still in the file.
  const cacheControlledRouteEntries = new Map();
  for (const group of cacheControlRouteGroups) {
    for (const path of group.paths) {
      const routeIndex = routes.findIndex((route) => route?.route === path);
      if (routeIndex >= 0) {
        cacheControlledRouteEntries.set(path, {
          groupName: group.groupName,
          routeIndex,
        });
      }
    }
  }
  for (const [path, routeEntry] of cacheControlledRouteEntries) {
    for (let priorIndex = 0; priorIndex < routeEntry.routeIndex; priorIndex++) {
      const priorRoute = routes[priorIndex]?.route;
      if (typeof priorRoute !== 'string') continue;
      if (priorRoute === path) continue;
      if (!priorRoute.includes('*')) continue;
      if (routeMatchesPath(priorRoute, path)) {
        errors.push(
          `routes[${priorIndex}].route '${priorRoute}' precedes the ${routeEntry.groupName} ` +
            `Cache-Control rule at routes[${routeEntry.routeIndex}] for '${path}' and its ` +
            `pattern matches that path. SWA processes routes top-to-bottom, so the wildcard ` +
            `would shadow the Cache-Control header on '${path}' and re-open the stale-SW ` +
            `class tracked in issue #167.`,
        );
      }
    }
  }

  for (const group of cacheControlRouteGroups) {
    for (const path of group.paths) {
      const route = routes.find((entry) => entry?.route === path);
      if (!route) {
        errors.push(
          `routes is missing the '${path}' ${group.groupName} Cache-Control rule. ` +
            `The issue #167 cache-header split requires this path to be present.`,
        );
        continue;
      }
      const cacheControl = route?.headers?.['Cache-Control'];
      if (cacheControl !== group.requiredCacheControl) {
        errors.push(
          `routes['${path}'].headers['Cache-Control'] must be '${group.requiredCacheControl}' ` +
            `for ${group.groupName} paths (got: ${JSON.stringify(cacheControl)}). ` +
            `Drift re-opens the stale-SW class tracked in issue #167.`,
        );
      }
    }
  }

  return errors;
}

export function checkPlatform(config) {
  const errors = [];
  const apiRuntime = config?.platform?.apiRuntime;
  if (!SUPPORTED_API_RUNTIMES.includes(apiRuntime)) {
    errors.push(
      `platform.apiRuntime must be one of ${JSON.stringify(SUPPORTED_API_RUNTIMES)} ` +
        `(got: ${JSON.stringify(apiRuntime)}). Allowlist rather than a regex floor: ` +
        `a regex like ^node:\\d+$ would silently accept EOL runtimes like node:14 / node:16.`,
    );
  }
  return errors;
}

export function checkMimeTypes(config) {
  const errors = [];
  const mimeTypes = config?.mimeTypes ?? {};
  for (const [key, expected] of Object.entries(REQUIRED_MIME_TYPES)) {
    if (mimeTypes[key] !== expected) {
      errors.push(
        `mimeTypes['${key}'] must be '${expected}' ` +
          `(got: ${JSON.stringify(mimeTypes[key])}). The dot-prefixed key is intentional; ` +
          `SWA matches file extensions including the leading dot.`,
      );
    }
  }
  return errors;
}

export function checkImmutableAssets(config) {
  const errors = [];
  const routes = Array.isArray(config?.routes) ? config.routes : [];
  if (routes.length === 0) {
    // checkRoutes already reports the missing-routes case.
    return errors;
  }
  for (const path of IMMUTABLE_ASSET_PATHS) {
    const route = routes.find((entry) => entry?.route === path);
    if (!route) {
      errors.push(
        `routes is missing the '${path}' immutable-asset Cache-Control rule. ` +
          `Hashed Angular asset filenames rely on this rule for repeat-visit ` +
          `speed; without it, SWA's default (must-revalidate, max-age=30) ` +
          `removes the perf benefit ngsw's cached-asset story used to provide.`,
      );
      continue;
    }
    const cacheControl = route?.headers?.['Cache-Control'];
    if (cacheControl !== IMMUTABLE_ASSET_CACHE_CONTROL) {
      errors.push(
        `routes['${path}'].headers['Cache-Control'] must be ` +
          `'${IMMUTABLE_ASSET_CACHE_CONTROL}' for immutable hashed assets ` +
          `(got: ${JSON.stringify(cacheControl)}).`,
      );
    }
    const methods = Array.isArray(route?.methods) ? route.methods : null;
    if (!methods || !methods.includes('GET')) {
      errors.push(
        `routes['${path}'].methods must include 'GET' so only safe reads ` +
          `pick up the immutable header (got: ${JSON.stringify(methods)}).`,
      );
    }
  }
  return errors;
}

// Aggregates all assertion blocks. Returns { ok, errors }.
export function checkConfig(config) {
  const errors = [
    ...checkGlobalHeaders(config),
    ...checkNavigationFallback(config),
    ...checkRoutes(config),
    ...checkImmutableAssets(config),
    ...checkPlatform(config),
    ...checkMimeTypes(config),
  ];
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  let config;
  try {
    config = readConfig();
  } catch (err) {
    console.error(`check-swa-config: failed to read ${SWA_CONFIG}: ${err.message}`);
    process.exit(2);
  }

  const result = checkConfig(config);
  if (result.ok) {
    console.log(`check-swa-config: OK (${SWA_CONFIG})`);
    return;
  }

  console.error(`check-swa-config: ${result.errors.length} assertion(s) failed in ${SWA_CONFIG}`);
  console.error('');
  for (const message of result.errors) {
    console.error(`  - ${message}`);
  }
  process.exit(1);
}

// Only invoke main() when this file is executed directly. Importers (the
// test file) load the module solely for its exports; they must not trigger
// the CLI side effects (fs reading, process.exit).
const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main();
}
