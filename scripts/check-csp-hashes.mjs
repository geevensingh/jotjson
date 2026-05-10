#!/usr/bin/env node
// Verifies that the CSP header in `staticwebapp.config.json` covers every
// inline `<script>` block AND every inline event-handler attribute (e.g.
// `onload="..."`) in the served HTML, that the policy retains the
// structural tokens our app needs (`'unsafe-hashes'`, the documented
// inline-handler hash literal, `data:` in `font-src`, no `script-src-attr`),
// and (in CI) that the runtime origins baked into the production bundle
// are covered by the CSP allowlist.
//
// Three modes:
//
//   --src         (default; runs in `npm run lint`)
//                 Hash inline scripts in `src/index.html` and verify that
//                 every hash is present in `script-src`. Also runs the
//                 policy-structure assertions. Catches policy/source drift
//                 in the inner loop.
//
//   --dist        (runs after `npm run build`)
//                 Same logic against ALL three production HTML files
//                 (`index.html`, `404/index.html`, `shell.html`) plus the
//                 inline event-handler hashes Angular emits. This is the
//                 authoritative gate: browsers hash whatever the file
//                 actually contains, and Angular's prod build (Beasties +
//                 esbuild) is allowed to mutate the served HTML. CI invokes
//                 this after the production build. Detects stale hashes in
//                 the policy too (so unused hashes do not bit-rot).
//
//   --ci-origins  (CI-only; runs when ENTRA_AUTHORITY and/or
//                 APP_INSIGHTS_CONNECTION_STRING are set)
//                 Asserts that the configured Entra authority host is
//                 covered by `connect-src` AND `frame-src`, and that the
//                 App Insights ingestion host (parsed from the connection
//                 string's IngestionEndpoint=...) is covered by
//                 `connect-src`, and that the AI config CDN host
//                 (`js.monitor.azure.com`, hardcoded in
//                 applicationinsights-web) is covered by `connect-src`.
//                 Skips silently when neither env var is set, so
//                 contributors without secrets are not blocked.
//
// Runs with zero dependencies on Node 24+. Invoke directly or via:
//   npm run lint:csp-hashes
//   node scripts/check-csp-hashes.mjs --dist
//   node scripts/check-csp-hashes.mjs --ci-origins

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SRC_INDEX = 'src/index.html';
export const DIST_INDEX = 'dist/jotjson/browser/index.html';
export const SWA_CONFIG = 'staticwebapp.config.json';

// All HTML files Azure Static Web Apps may serve under the configured CSP
// header. Browsers compute hashes against the served bytes for whichever of
// these the user lands on, so all three must be covered.
//   - index.html       prerendered home (M7h).
//   - 404/index.html   prerendered 404.
//   - shell.html       SPA navigation fallback (`navigationFallback.rewrite`
//                      in this very file). Served on every non-prerendered
//                      route -- the most-served HTML in deployment.
export const DIST_HTML_FILES = [
  'dist/jotjson/browser/index.html',
  'dist/jotjson/browser/404/index.html',
  'dist/jotjson/browser/shell.html',
];

// SHA-256 of the literal `this.media='all'` event-handler value Angular's
// build emits when `optimization.styles.inlineCritical: true` (default).
// Beasties rewrites `<link rel="stylesheet" href="...">` to a deferred
// `<link rel="preload" as="style" onload="this.media='all'">` print-CSS
// pattern. Browsers hash the HTML-decoded attribute value; this constant is
// what `script-src` must list (paired with `'unsafe-hashes'` to make hash
// matching apply to event-handler attributes).
//
// Reproduce via: `node scripts/print-csp-hash.mjs`.
export const INLINE_HANDLER_HASH = "'sha256-MhtPZXr7+LpJUY5qtMutB+qWfQtMaPccfe7QXtCcEYc='";

// Application Insights JS SDK fetches dynamic config (sampling, throttling,
// feature flags) from this CDN at SDK init. The host is hardcoded inside
// `@microsoft/applicationinsights-web` and is NOT represented in the
// APP_INSIGHTS_CONNECTION_STRING (which only carries IngestionEndpoint,
// LiveEndpoint, etc.). We require it explicitly in `connect-src` whenever
// the conn string is set, so a future SDK upgrade that adds another
// config host will be caught in observation, not in production.
export const AI_CONFIG_CDN_HOST = 'js.monitor.azure.com';

export function parseCspString(cspValue) {
  // Returns { directiveName: [tokens, ...] }. Directive names are
  // lowercased; tokens preserve case for hash literals.
  const directives = {};
  for (const chunk of cspValue.split(';')) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const name = parts[0].toLowerCase();
    directives[name] = parts.slice(1);
  }
  return directives;
}

export function readCsp(swaConfigPath = SWA_CONFIG) {
  const raw = readFileSync(swaConfigPath, 'utf8');
  const config = JSON.parse(raw);
  const headers = config.globalHeaders ?? {};
  const enforced = headers['Content-Security-Policy'];
  const reportOnly = headers['Content-Security-Policy-Report-Only'];
  if (enforced && reportOnly) {
    throw new Error(
      `${swaConfigPath} sets BOTH Content-Security-Policy and ` +
        `Content-Security-Policy-Report-Only. Pick exactly one.`,
    );
  }
  const value = enforced ?? reportOnly;
  if (!value) {
    return { value: null, headerName: null, directives: {} };
  }
  return {
    value,
    headerName: enforced ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only',
    directives: parseCspString(value),
  };
}

export function extractInlineScripts(html) {
  // Match <script ...>...</script> blocks that have NO `src=` attribute.
  // Capture the bytes between the tags exactly (including whitespace) so
  // SHA-256 matches the browser's CSP hashing rule.
  const re = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
  const out = [];
  let match;
  while ((match = re.exec(html)) !== null) {
    out.push(match[1]);
  }
  return out;
}

// Decodes the named and numeric HTML entities a tag-attribute parser would
// resolve before handing the value to the CSP hashing pass. Browsers hash
// the *decoded* attribute value, not the raw bytes, so callers must decode
// before computing `sha256Token`. Order matters: numeric refs first, then
// the four/five named refs HTML defines for attribute context, with `&amp;`
// last to avoid double-decoding sequences like `&amp;lt;`.
export function decodeHtmlEntities(text) {
  return text
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Returns the decoded value of every `on*=` event-handler attribute in the
// HTML. Supports double-quoted, single-quoted, and unquoted attribute
// values, and is case-insensitive on the attribute name (so `Onload`,
// `ONCLICK`, etc. all match). The leading `\s` anchor prevents false
// positives like `<a href="...?onload=1">` (no whitespace before "on"
// inside an already-quoted attribute value).
export function extractInlineEventHandlers(html) {
  const re = /\son[a-zA-Z]+\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  const out = [];
  let match;
  while ((match = re.exec(html)) !== null) {
    const raw = match[1] ?? match[2] ?? match[3] ?? '';
    out.push(decodeHtmlEntities(raw));
  }
  return out;
}

export function sha256Token(content) {
  // Normalize CRLF -> LF before hashing. Files checked out on Windows may
  // have CRLF locally while the production bundle (built and uploaded by
  // Linux CI) ships LF; both should agree on the same hash. Browsers hash
  // the served bytes, which on Azure SWA (Linux) are LF.
  const normalized = content.replace(/\r\n/g, '\n');
  const digest = createHash('sha256').update(normalized, 'utf8').digest('base64');
  return `'sha256-${digest}'`;
}

// Pure: given a list of HTML strings, returns the union of hashes the CSP
// `script-src` must cover (one per inline script body, one per distinct
// event-handler attribute value), plus per-source counts for the OK
// summary line.
export function computeExpectedHashes(htmlContents) {
  const expected = new Set();
  let scriptCount = 0;
  let handlerCount = 0;
  for (const html of htmlContents) {
    const scripts = extractInlineScripts(html);
    scriptCount += scripts.length;
    for (const body of scripts) expected.add(sha256Token(body));
    const handlers = extractInlineEventHandlers(html);
    handlerCount += handlers.length;
    for (const value of handlers) expected.add(sha256Token(value));
  }
  return { expected, scriptCount, handlerCount };
}

// Pure: structural assertions on the CSP value itself, independent of any
// HTML. Catches drift like "someone re-added `script-src-attr 'none'`",
// "the documented inline-handler hash got removed but the inline handler
// is still in the dist HTML", or "`data:` got dropped from `font-src` and
// Monaco codicons broke." Returns { ok, errors }.
export function checkPolicyStructure({ directives, headerName }) {
  const errors = [];
  if (!headerName) {
    errors.push(`${SWA_CONFIG} has no CSP header to check structure against.`);
    return { ok: false, errors };
  }

  const scriptSrc = directives['script-src'] ?? [];
  if (!scriptSrc.includes("'unsafe-hashes'")) {
    errors.push(
      `script-src is missing 'unsafe-hashes'. Required for hash matching ` +
        `to apply to inline event-handler attributes (Angular inlineCritical).`,
    );
  }
  if (!scriptSrc.includes(INLINE_HANDLER_HASH)) {
    errors.push(
      `script-src is missing the documented inline-handler hash ` +
        `${INLINE_HANDLER_HASH} (literal \`this.media='all'\` from Angular's ` +
        `inlineCritical print-CSS preload pattern).`,
    );
  }

  // Folding `'unsafe-hashes'` into `script-src` and dropping `script-src-attr`
  // entirely is a deliberate choice: per CSP3 section 6.1, browsers that do
  // not implement `script-src-attr` (older Safari/Firefox ESRs through late
  // 2023) fall back to `script-src`. Setting `script-src-attr 'none'` would
  // block the inline handler in modern browsers; setting it to anything
  // else requires duplicating the hash list. Cleanest is to omit the
  // directive and let the more-permissive `script-src` cover all browsers
  // uniformly.
  if ('script-src-attr' in directives) {
    errors.push(
      `script-src-attr is set; it should be omitted entirely so that ` +
        `legacy browsers fall back to script-src (which carries the ` +
        `'unsafe-hashes' + hash combination).`,
    );
  }

  const fontSrc = directives['font-src'] ?? [];
  if (!fontSrc.includes('data:')) {
    errors.push(
      `font-src is missing 'data:'. Required for Monaco codicons (the ` +
        `editor's icon font is shipped inline as a data: URL inside ` +
        `vs/editor/editor.main.css).`,
    );
  }

  return { ok: errors.length === 0, errors };
}

// Pure: combines hash coverage and policy-structure checks into a single
// boolean result with structured error sets, suitable for either CLI
// printing or test assertions.
export function checkHashesAndPolicy({
  expected,
  scriptCount,
  handlerCount,
  directives,
  headerName,
  mode,
}) {
  if (!headerName) {
    return {
      ok: false,
      headerName: null,
      scriptCount,
      handlerCount,
      structureErrors: [
        `${SWA_CONFIG} globalHeaders has no Content-Security-Policy ` +
          `or Content-Security-Policy-Report-Only.`,
      ],
      missing: [...expected],
      stale: [],
    };
  }

  const scriptSrc = directives['script-src'] ?? [];
  const policyHashes = new Set(
    scriptSrc.filter((token) => /^'sha256-[A-Za-z0-9+/=]+'$/.test(token)),
  );
  const missing = [...expected].filter((hash) => !policyHashes.has(hash));

  // Stale-hash detection only runs in --dist mode. The dist HTML is the
  // authoritative artifact (browsers hash these bytes), so any policy hash
  // not present in any dist HTML is genuinely unused. In --src mode the
  // source HTML does NOT contain the inlineCritical event handler (Angular
  // injects it during the build), so a stale check there would falsely
  // flag the documented INLINE_HANDLER_HASH constant as removable.
  const stale = mode === '--dist' ? [...policyHashes].filter((hash) => !expected.has(hash)) : [];

  const struct = checkPolicyStructure({ directives, headerName });

  return {
    ok: missing.length === 0 && stale.length === 0 && struct.ok,
    headerName,
    scriptCount,
    handlerCount,
    structureErrors: struct.errors,
    missing,
    stale,
  };
}

function readHtmlOrError(filePath, mode) {
  if (!existsSync(filePath)) {
    if (mode === '--dist') {
      console.error(
        `check-csp-hashes (${mode}): ${filePath} does not exist. ` + `Run \`npm run build\` first.`,
      );
    } else {
      console.error(`check-csp-hashes (${mode}): ${filePath} does not exist.`);
    }
    return null;
  }
  return readFileSync(filePath, 'utf8');
}

function checkHashes(mode) {
  const htmlPaths = mode === '--dist' ? DIST_HTML_FILES : [SRC_INDEX];
  const htmlContents = [];
  for (const path of htmlPaths) {
    const html = readHtmlOrError(path, mode);
    if (html === null) return false;
    htmlContents.push(html);
  }
  const { expected, scriptCount, handlerCount } = computeExpectedHashes(htmlContents);

  const { headerName, directives } = readCsp();
  const result = checkHashesAndPolicy({
    expected,
    scriptCount,
    handlerCount,
    directives,
    headerName,
    mode,
  });

  if (result.ok) {
    console.log(
      `check-csp-hashes (${mode}): OK ` +
        `(${result.scriptCount} inline script(s), ${result.handlerCount} inline event handler(s), ` +
        `${result.headerName})`,
    );
    return true;
  }

  const headerLabel = result.headerName ?? '(no header)';
  console.error(`check-csp-hashes (${mode}): mismatch in ${headerLabel}`);
  if (result.structureErrors.length) {
    console.error('');
    console.error('  Policy structure errors:');
    for (const message of result.structureErrors) console.error(`    ${message}`);
  }
  if (result.missing.length) {
    console.error('');
    console.error('  Missing from script-src in staticwebapp.config.json (paste these in):');
    for (const hash of result.missing) console.error(`    ${hash}`);
  }
  if (result.stale.length) {
    console.error('');
    console.error('  Stale in script-src in staticwebapp.config.json (remove these):');
    for (const hash of result.stale) console.error(`    ${hash}`);
  }
  return false;
}

export function hostFromUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function entryMatchesHost(host, entry) {
  // entry is a CSP source expression like "https://*.foo.com" or
  // "https://exact.host.com" (optionally with a port). Return true if the
  // entry covers `host`.
  const match = /^https:\/\/([^/]+)$/i.exec(entry);
  if (!match) return false;
  const pattern = match[1].toLowerCase();
  const target = host.toLowerCase();
  if (pattern === target) return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    // Per CSP, '*.suffix' matches subdomains of suffix but NOT suffix itself.
    return target.endsWith('.' + suffix) && target !== suffix;
  }
  return false;
}

// Pure variant: reads neither the environment nor the filesystem, never
// calls process.exit. Returns { ok, errors } where each error string is
// suitable for printing with a single prefix prepended by the caller.
// Used directly by tests, and via `checkOriginsFromEnv` for the CLI path.
export function checkOrigins({ authority, aiConnection, headerName, directives }) {
  const errors = [];
  if (!headerName) {
    errors.push(`${SWA_CONFIG} has no CSP header to check origins against.`);
    return { ok: false, errors };
  }
  const connectSrc = directives['connect-src'] ?? [];
  const frameSrc = directives['frame-src'] ?? [];

  if (authority) {
    const host = hostFromUrl(authority);
    if (!host) {
      errors.push(`ENTRA_AUTHORITY is not a valid URL: ${authority}`);
    } else {
      if (!connectSrc.some((entry) => entryMatchesHost(host, entry))) {
        errors.push(
          `ENTRA_AUTHORITY host '${host}' is not covered by connect-src in ${headerName}.`,
        );
      }
      if (!frameSrc.some((entry) => entryMatchesHost(host, entry))) {
        errors.push(
          `ENTRA_AUTHORITY host '${host}' is not covered by frame-src in ${headerName}. ` +
            `MSAL silent SSO uses iframes against the authority.`,
        );
      }
    }
  }

  if (aiConnection) {
    const ingestion = /(?:^|;)\s*IngestionEndpoint\s*=\s*([^;]+)/i.exec(aiConnection);
    if (!ingestion) {
      errors.push('APP_INSIGHTS_CONNECTION_STRING has no IngestionEndpoint=... segment.');
    } else {
      const endpoint = ingestion[1].trim();
      const host = hostFromUrl(endpoint);
      if (!host) {
        errors.push(
          `APP_INSIGHTS_CONNECTION_STRING IngestionEndpoint is not a valid URL: ${endpoint}`,
        );
      } else if (!connectSrc.some((entry) => entryMatchesHost(host, entry))) {
        errors.push(
          `App Insights ingestion host '${host}' is not covered by connect-src in ${headerName}.`,
        );
      }
    }
    // The applicationinsights-web SDK also fetches its dynamic config blob
    // from `js.monitor.azure.com` at startup, on a path separate from the
    // ingestion endpoint. Require the host explicitly whenever the AI
    // conn string is set; the host is hardcoded inside the SDK and is
    // not derivable from the conn string.
    if (!connectSrc.some((entry) => entryMatchesHost(AI_CONFIG_CDN_HOST, entry))) {
      errors.push(
        `App Insights config CDN host '${AI_CONFIG_CDN_HOST}' is not covered by ` +
          `connect-src in ${headerName}. The applicationinsights-web SDK fetches ` +
          `dynamic config from this host at startup.`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

// CLI wrapper: reads env + fs, prints prefixed messages, returns boolean.
function checkOriginsFromEnv() {
  const authority = (process.env.ENTRA_AUTHORITY ?? '').trim();
  const aiConnection = (process.env.APP_INSIGHTS_CONNECTION_STRING ?? '').trim();
  if (!authority && !aiConnection) {
    console.log(
      'check-csp-hashes (--ci-origins): skipped ' +
        '(no ENTRA_AUTHORITY or APP_INSIGHTS_CONNECTION_STRING in env)',
    );
    return true;
  }
  const { headerName, directives } = readCsp();
  const result = checkOrigins({ authority, aiConnection, headerName, directives });
  for (const message of result.errors) {
    console.error(`check-csp-hashes (--ci-origins): ${message}`);
  }
  if (result.ok) {
    console.log('check-csp-hashes (--ci-origins): OK');
  }
  return result.ok;
}

function main() {
  const args = process.argv.slice(2);
  const mode = args[0] ?? '--src';

  let ok;
  if (mode === '--src') {
    ok = checkHashes('--src');
  } else if (mode === '--dist') {
    ok = checkHashes('--dist');
  } else if (mode === '--ci-origins') {
    ok = checkOriginsFromEnv();
  } else {
    console.error(
      `check-csp-hashes: unknown mode '${mode}'. ` + `Valid: --src (default), --dist, --ci-origins`,
    );
    process.exit(2);
  }
  if (!ok) process.exit(1);
}

// Only invoke main() when this file is executed directly. Importers (the
// test file) load the module solely for its exports; they must not trigger
// the CLI side effects (env reading, fs reading, process.exit).
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
