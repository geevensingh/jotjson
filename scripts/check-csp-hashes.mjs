#!/usr/bin/env node
// Verifies that the CSP header in `staticwebapp.config.json` covers every
// inline `<script>` block in the served HTML, and (in CI) that the runtime
// origins baked into the production bundle are covered by the CSP allowlist.
//
// Three modes:
//
//   --src         (default; runs in `npm run lint`)
//                 Hash inline scripts in `src/index.html` and verify that
//                 every hash is present in `script-src`. Catches policy/source
//                 drift in the inner loop.
//
//   --dist        (runs after `npm run build`)
//                 Same logic against `dist/jotjson/browser/index.html`. This
//                 is the authoritative gate: browsers hash whatever the file
//                 actually contains, and Angular's prod build (Beasties +
//                 esbuild) is allowed to mutate the served index.html. CI
//                 invokes this after the production build.
//
//   --ci-origins  (CI-only; runs when ENTRA_AUTHORITY and/or
//                 APP_INSIGHTS_CONNECTION_STRING are set)
//                 Asserts that the configured Entra authority host is
//                 covered by `connect-src` AND `frame-src`, and that the
//                 App Insights ingestion host (parsed from the connection
//                 string's IngestionEndpoint=...) is covered by
//                 `connect-src`. Skips silently when neither env var is
//                 set, so contributors without secrets are not blocked.
//
// Runs with zero dependencies on Node 24+. Invoke directly or via:
//   npm run lint:csp-hashes
//   node scripts/check-csp-hashes.mjs --dist
//   node scripts/check-csp-hashes.mjs --ci-origins

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const SRC_INDEX = 'src/index.html';
const DIST_INDEX = 'dist/jotjson/browser/index.html';
const SWA_CONFIG = 'staticwebapp.config.json';

function parseCspString(cspValue) {
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

function readCsp() {
  const raw = readFileSync(SWA_CONFIG, 'utf8');
  const config = JSON.parse(raw);
  const headers = config.globalHeaders ?? {};
  const enforced = headers['Content-Security-Policy'];
  const reportOnly = headers['Content-Security-Policy-Report-Only'];
  if (enforced && reportOnly) {
    throw new Error(
      `${SWA_CONFIG} sets BOTH Content-Security-Policy and ` +
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

function extractInlineScripts(html) {
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

function sha256Token(content) {
  // Normalize CRLF -> LF before hashing. Files checked out on Windows may
  // have CRLF locally while the production bundle (built and uploaded by
  // Linux CI) ships LF; both should agree on the same hash. Browsers hash
  // the served bytes, which on Azure SWA (Linux) are LF.
  const normalized = content.replace(/\r\n/g, '\n');
  const digest = createHash('sha256').update(normalized, 'utf8').digest('base64');
  return `'sha256-${digest}'`;
}

function checkHashes(filePath, mode) {
  if (!existsSync(filePath)) {
    if (mode === '--dist') {
      console.error(
        `check-csp-hashes (${mode}): ${filePath} does not exist. ` + `Run \`npm run build\` first.`,
      );
    } else {
      console.error(`check-csp-hashes (${mode}): ${filePath} does not exist.`);
    }
    return false;
  }
  const html = readFileSync(filePath, 'utf8');
  const scripts = extractInlineScripts(html);
  const expectedHashes = scripts.map(sha256Token);

  const { headerName, directives } = readCsp();
  if (!headerName) {
    console.error(
      `check-csp-hashes (${mode}): ${SWA_CONFIG} globalHeaders has no ` +
        `Content-Security-Policy or Content-Security-Policy-Report-Only. ` +
        `Inline scripts found in ${filePath}:`,
    );
    for (const hash of expectedHashes) console.error(`  ${hash}`);
    return false;
  }
  const scriptSrc = directives['script-src'] ?? [];
  const policyHashes = scriptSrc.filter((token) => /^'sha256-[A-Za-z0-9+/=]+'$/.test(token));

  const expectedSet = new Set(expectedHashes);
  const policySet = new Set(policyHashes);
  const missing = [...expectedSet].filter((hash) => !policySet.has(hash));
  const stale = [...policySet].filter((hash) => !expectedSet.has(hash));

  if (missing.length === 0 && stale.length === 0) {
    console.log(
      `check-csp-hashes (${mode}): OK ` +
        `(${expectedHashes.length} inline script(s), ${headerName})`,
    );
    return true;
  }

  console.error(`check-csp-hashes (${mode}): mismatch in ${headerName} script-src`);
  if (missing.length) {
    console.error('');
    console.error('  Missing from script-src in staticwebapp.config.json (paste these in):');
    for (const hash of missing) console.error(`    ${hash}`);
  }
  if (stale.length) {
    console.error('');
    console.error('  Stale in script-src in staticwebapp.config.json (remove these):');
    for (const hash of stale) console.error(`    ${hash}`);
  }
  return false;
}

function hostFromUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function entryMatchesHost(host, entry) {
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

function checkOrigins() {
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
  if (!headerName) {
    console.error(
      `check-csp-hashes (--ci-origins): ${SWA_CONFIG} has no CSP header to check origins against.`,
    );
    return false;
  }
  const connectSrc = directives['connect-src'] ?? [];
  const frameSrc = directives['frame-src'] ?? [];

  let ok = true;

  if (authority) {
    const host = hostFromUrl(authority);
    if (!host) {
      console.error(
        `check-csp-hashes (--ci-origins): ENTRA_AUTHORITY is not a valid URL: ${authority}`,
      );
      ok = false;
    } else {
      const inConnect = connectSrc.some((entry) => entryMatchesHost(host, entry));
      const inFrame = frameSrc.some((entry) => entryMatchesHost(host, entry));
      if (!inConnect) {
        console.error(
          `check-csp-hashes (--ci-origins): ENTRA_AUTHORITY host '${host}' ` +
            `is not covered by connect-src in ${headerName}.`,
        );
        ok = false;
      }
      if (!inFrame) {
        console.error(
          `check-csp-hashes (--ci-origins): ENTRA_AUTHORITY host '${host}' ` +
            `is not covered by frame-src in ${headerName}. MSAL silent SSO ` +
            `uses iframes against the authority.`,
        );
        ok = false;
      }
    }
  }

  if (aiConnection) {
    const ingestion = /(?:^|;)\s*IngestionEndpoint\s*=\s*([^;]+)/i.exec(aiConnection);
    if (!ingestion) {
      console.error(
        'check-csp-hashes (--ci-origins): APP_INSIGHTS_CONNECTION_STRING has ' +
          'no IngestionEndpoint=... segment.',
      );
      ok = false;
    } else {
      const endpoint = ingestion[1].trim();
      const host = hostFromUrl(endpoint);
      if (!host) {
        console.error(
          `check-csp-hashes (--ci-origins): APP_INSIGHTS_CONNECTION_STRING ` +
            `IngestionEndpoint is not a valid URL: ${endpoint}`,
        );
        ok = false;
      } else {
        const inConnect = connectSrc.some((entry) => entryMatchesHost(host, entry));
        if (!inConnect) {
          console.error(
            `check-csp-hashes (--ci-origins): App Insights ingestion host ` +
              `'${host}' is not covered by connect-src in ${headerName}.`,
          );
          ok = false;
        }
      }
    }
  }

  if (ok) {
    console.log('check-csp-hashes (--ci-origins): OK');
  }
  return ok;
}

function main() {
  const args = process.argv.slice(2);
  const mode = args[0] ?? '--src';

  let ok;
  if (mode === '--src') {
    ok = checkHashes(SRC_INDEX, '--src');
  } else if (mode === '--dist') {
    ok = checkHashes(DIST_INDEX, '--dist');
  } else if (mode === '--ci-origins') {
    ok = checkOrigins();
  } else {
    console.error(
      `check-csp-hashes: unknown mode '${mode}'. ` + `Valid: --src (default), --dist, --ci-origins`,
    );
    process.exit(2);
  }
  if (!ok) process.exit(1);
}

main();
