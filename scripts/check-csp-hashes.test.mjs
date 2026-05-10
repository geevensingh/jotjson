// Unit tests for scripts/check-csp-hashes.mjs.
//
// Runs under Node's built-in test runner: `node --test`. No external
// dependencies. The test file imports the script as a module; the script
// guards `main()` behind an "invoked directly" check so importing it does
// not trigger CLI side effects (env reads, fs reads, process.exit).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCspString,
  entryMatchesHost,
  hostFromUrl,
  readCsp,
  checkOrigins,
  AI_CONFIG_CDN_HOST,
} from './check-csp-hashes.mjs';

// --- parseCspString -------------------------------------------------------

test('parseCspString returns an object keyed by lowercased directive name', () => {
  const out = parseCspString("default-src 'self'; SCRIPT-SRC 'self' 'unsafe-eval'");
  assert.deepEqual(out, {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-eval'"],
  });
});

test('parseCspString preserves token case for hash literals', () => {
  const out = parseCspString("script-src 'sha256-Foo+Bar/Qux='");
  assert.deepEqual(out['script-src'], ["'sha256-Foo+Bar/Qux='"]);
});

test('parseCspString tolerates extra whitespace and empty segments', () => {
  const out = parseCspString("  default-src   'self' ; ; script-src 'self'  ");
  assert.deepEqual(out['default-src'], ["'self'"]);
  assert.deepEqual(out['script-src'], ["'self'"]);
});

// --- hostFromUrl ----------------------------------------------------------

test('hostFromUrl returns the host for valid HTTPS URLs', () => {
  assert.equal(hostFromUrl('https://login.microsoftonline.com/foo'), 'login.microsoftonline.com');
});

test('hostFromUrl returns null for invalid URLs', () => {
  assert.equal(hostFromUrl('not a url'), null);
});

// --- entryMatchesHost -----------------------------------------------------

test('entryMatchesHost matches an exact host', () => {
  assert.equal(entryMatchesHost('example.com', 'https://example.com'), true);
});

test('entryMatchesHost is case-insensitive', () => {
  assert.equal(entryMatchesHost('Example.Com', 'https://EXAMPLE.com'), true);
});

test('entryMatchesHost matches a subdomain via wildcard', () => {
  assert.equal(entryMatchesHost('foo.example.com', 'https://*.example.com'), true);
});

test('entryMatchesHost wildcard does NOT match the bare suffix', () => {
  // CSP spec: '*.example.com' matches 'foo.example.com' but NOT 'example.com'.
  assert.equal(entryMatchesHost('example.com', 'https://*.example.com'), false);
});

test('entryMatchesHost rejects non-https entries', () => {
  assert.equal(entryMatchesHost('example.com', "'self'"), false);
  assert.equal(entryMatchesHost('example.com', 'http://example.com'), false);
});

test('entryMatchesHost rejects mismatched hosts', () => {
  assert.equal(entryMatchesHost('foo.com', 'https://bar.com'), false);
});

// --- readCsp --------------------------------------------------------------

function withTmpSwaConfig(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'csp-test-'));
  const path = join(dir, 'staticwebapp.config.json');
  writeFileSync(path, contents, 'utf8');
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('readCsp returns enforced header when only Content-Security-Policy is set', () => {
  withTmpSwaConfig(
    JSON.stringify({
      globalHeaders: { 'Content-Security-Policy': "default-src 'self'" },
    }),
    (path) => {
      const result = readCsp(path);
      assert.equal(result.headerName, 'Content-Security-Policy');
      assert.deepEqual(result.directives['default-src'], ["'self'"]);
    },
  );
});

test('readCsp returns Report-Only header name when only that is set', () => {
  withTmpSwaConfig(
    JSON.stringify({
      globalHeaders: { 'Content-Security-Policy-Report-Only': "default-src 'self'" },
    }),
    (path) => {
      const result = readCsp(path);
      assert.equal(result.headerName, 'Content-Security-Policy-Report-Only');
    },
  );
});

test('readCsp throws when both enforced and Report-Only headers are set', () => {
  withTmpSwaConfig(
    JSON.stringify({
      globalHeaders: {
        'Content-Security-Policy': "default-src 'self'",
        'Content-Security-Policy-Report-Only': "default-src 'self'",
      },
    }),
    (path) => {
      assert.throws(() => readCsp(path), /BOTH/);
    },
  );
});

test('readCsp returns null headerName when no CSP header is set', () => {
  withTmpSwaConfig(JSON.stringify({ globalHeaders: { 'X-Frame-Options': 'DENY' } }), (path) => {
    const result = readCsp(path);
    assert.equal(result.headerName, null);
    assert.deepEqual(result.directives, {});
  });
});

// --- checkOrigins (pure) --------------------------------------------------

function makeDirectives(connectSrc = [], frameSrc = []) {
  return { 'connect-src': connectSrc, 'frame-src': frameSrc };
}

const FAKE_AI_CONN =
  'InstrumentationKey=00000000-0000-0000-0000-000000000000;' +
  'IngestionEndpoint=https://westus2-1.in.applicationinsights.azure.com/';

test('checkOrigins ok when authority host covers connect-src and frame-src', () => {
  const result = checkOrigins({
    authority: 'https://login.example.com/tenant',
    aiConnection: '',
    headerName: 'Content-Security-Policy',
    directives: makeDirectives(
      ["'self'", 'https://login.example.com'],
      ['https://login.example.com'],
    ),
  });
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('checkOrigins fails when authority host is missing from connect-src', () => {
  const result = checkOrigins({
    authority: 'https://login.example.com/tenant',
    aiConnection: '',
    headerName: 'Content-Security-Policy',
    directives: makeDirectives([], ['https://login.example.com']),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('connect-src')),
    `expected a connect-src error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('checkOrigins fails when authority host is missing from frame-src', () => {
  const result = checkOrigins({
    authority: 'https://login.example.com/tenant',
    aiConnection: '',
    headerName: 'Content-Security-Policy',
    directives: makeDirectives(['https://login.example.com'], []),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('frame-src')),
    `expected a frame-src error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('checkOrigins fails when authority is not a valid URL', () => {
  const result = checkOrigins({
    authority: 'not-a-url',
    aiConnection: '',
    headerName: 'Content-Security-Policy',
    directives: makeDirectives(),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('not a valid URL')),
    `expected a 'not a valid URL' error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('checkOrigins fails when AI conn string lacks IngestionEndpoint', () => {
  const result = checkOrigins({
    authority: '',
    aiConnection: 'InstrumentationKey=abc',
    headerName: 'Content-Security-Policy',
    directives: makeDirectives([`https://${AI_CONFIG_CDN_HOST}`]),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('IngestionEndpoint')),
    `expected an IngestionEndpoint error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('checkOrigins fails when AI ingestion host is missing from connect-src', () => {
  const result = checkOrigins({
    authority: '',
    aiConnection: FAKE_AI_CONN,
    headerName: 'Content-Security-Policy',
    directives: makeDirectives([`https://${AI_CONFIG_CDN_HOST}`]),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('ingestion host')),
    `expected an 'ingestion host' error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('checkOrigins requires AI config CDN host in connect-src when AI conn string is set', () => {
  // This is the regression PR #102 caught in production: ingestion host
  // covered, but the SDK config CDN host (`js.monitor.azure.com`) was not
  // in connect-src, so the SDK's startup config fetch was blocked.
  const result = checkOrigins({
    authority: '',
    aiConnection: FAKE_AI_CONN,
    headerName: 'Content-Security-Policy',
    directives: makeDirectives([
      'https://*.in.applicationinsights.azure.com',
      // js.monitor.azure.com intentionally omitted.
    ]),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes(AI_CONFIG_CDN_HOST)),
    `expected an error mentioning ${AI_CONFIG_CDN_HOST}, got: ${JSON.stringify(result.errors)}`,
  );
});

test('checkOrigins ok when both AI ingestion and AI config CDN hosts are in connect-src', () => {
  const result = checkOrigins({
    authority: '',
    aiConnection: FAKE_AI_CONN,
    headerName: 'Content-Security-Policy',
    directives: makeDirectives([
      'https://*.in.applicationinsights.azure.com',
      `https://${AI_CONFIG_CDN_HOST}`,
    ]),
  });
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('checkOrigins skips AI config CDN check when AI conn string is unset', () => {
  // No AI conn string means we are not running with App Insights; the SDK
  // will not fetch its config CDN, so the host need not be present.
  const result = checkOrigins({
    authority: 'https://login.example.com/tenant',
    aiConnection: '',
    headerName: 'Content-Security-Policy',
    directives: makeDirectives(['https://login.example.com'], ['https://login.example.com']),
  });
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('checkOrigins fails when no CSP header is configured', () => {
  const result = checkOrigins({
    authority: 'https://login.example.com/tenant',
    aiConnection: '',
    headerName: null,
    directives: {},
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('no CSP header')),
    `expected a 'no CSP header' error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('checkOrigins accumulates multiple errors instead of bailing on the first', () => {
  const result = checkOrigins({
    authority: 'https://login.example.com/tenant',
    aiConnection: FAKE_AI_CONN,
    headerName: 'Content-Security-Policy',
    // Both authority and AI requirements unmet.
    directives: makeDirectives([], []),
  });
  assert.equal(result.ok, false);
  // Expect: authority-connect, authority-frame, AI-ingestion, AI-config-CDN.
  assert.ok(
    result.errors.length >= 4,
    `expected >= 4 errors, got ${result.errors.length}: ${JSON.stringify(result.errors)}`,
  );
});
