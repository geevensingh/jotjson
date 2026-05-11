// Unit tests for scripts/check-csp-hashes.mjs.
//
// Runs under Node's built-in test runner: `node --test`. No external
// dependencies. The test file imports the script as a module; the script
// guards `main()` behind an "invoked directly" check so importing it does
// not trigger CLI side effects (env reads, fs reads, process.exit).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AI_CONFIG_CDN_HOST,
  checkHashesAndPolicy,
  checkOrigins,
  checkPolicyStructure,
  computeExpectedHashes,
  decodeHtmlEntities,
  entryMatchesHost,
  extractInlineEventHandlers,
  hostFromUrl,
  INLINE_HANDLER_HASH,
  parseCspString,
  readCsp,
  sha256Token,
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

// --- decodeHtmlEntities ---------------------------------------------------

test('decodeHtmlEntities decodes the named entities used in attribute values', () => {
  assert.equal(decodeHtmlEntities('&apos;'), "'");
  assert.equal(decodeHtmlEntities('&quot;'), '"');
  assert.equal(decodeHtmlEntities('&lt;'), '<');
  assert.equal(decodeHtmlEntities('&gt;'), '>');
  assert.equal(decodeHtmlEntities('&amp;'), '&');
});

test('decodeHtmlEntities decodes numeric and hex character references', () => {
  // Decimal: &#39; is apostrophe; &#34; is quote.
  assert.equal(decodeHtmlEntities('this.media=&#39;all&#39;'), "this.media='all'");
  // Hex: &#x27; is also apostrophe; case-insensitive on the 'x'.
  assert.equal(decodeHtmlEntities('this.media=&#x27;all&#x27;'), "this.media='all'");
  assert.equal(decodeHtmlEntities('&#X27;'), "'");
});

test('decodeHtmlEntities does not double-decode &amp;lt;', () => {
  // If decoded right-to-left as written, this would become '<'. The
  // implementation explicitly resolves named refs first and `&amp;` last to
  // preserve `&lt;` literal in the source.
  assert.equal(decodeHtmlEntities('&amp;lt;'), '&lt;');
});

// --- extractInlineEventHandlers -------------------------------------------

test('extractInlineEventHandlers matches double-quoted on* attributes', () => {
  const html = `<link rel="preload" as="style" onload="this.media='all'">`;
  assert.deepEqual(extractInlineEventHandlers(html), ["this.media='all'"]);
});

test('extractInlineEventHandlers matches single-quoted on* attributes', () => {
  const html = `<button onclick='doThing(1)'>x</button>`;
  assert.deepEqual(extractInlineEventHandlers(html), ['doThing(1)']);
});

test('extractInlineEventHandlers matches unquoted on* attribute values', () => {
  const html = `<button onclick=doThing>x</button>`;
  assert.deepEqual(extractInlineEventHandlers(html), ['doThing']);
});

test('extractInlineEventHandlers is case-insensitive on the attribute name', () => {
  const html = `<a OnLoad="a()" ONCLICK="b()">x</a>`;
  assert.deepEqual(extractInlineEventHandlers(html), ['a()', 'b()']);
});

test('extractInlineEventHandlers decodes HTML entities in the value', () => {
  // Same logical handler, three encodings: literal, named ref, numeric ref.
  const html =
    `<link onload="this.media='all'">` +
    `<link onload="this.media=&apos;all&apos;">` +
    `<link onload="this.media=&#39;all&#39;">`;
  const out = extractInlineEventHandlers(html);
  assert.deepEqual(out, ["this.media='all'", "this.media='all'", "this.media='all'"]);
});

test('extractInlineEventHandlers ignores non-on* attributes', () => {
  // `formaction` and `name="onload"` look superficially similar but are
  // not event handlers; only `on*=` patterns should be returned.
  const html = `<input name="onload" formaction="/x" type="text">`;
  assert.deepEqual(extractInlineEventHandlers(html), []);
});

test('extractInlineEventHandlers does not match `onfoo=` inside a quoted value', () => {
  // The leading `\s` anchor is what protects against this: inside the
  // quoted value the chars before "on" are part of the value, not whitespace.
  const html = `<a href="/path?onload=1">x</a>`;
  assert.deepEqual(extractInlineEventHandlers(html), []);
});

test('extractInlineEventHandlers handles empty attribute values', () => {
  const html = `<a onclick="">x</a><a onclick=''>x</a>`;
  assert.deepEqual(extractInlineEventHandlers(html), ['', '']);
});

test('extractInlineEventHandlers tolerates whitespace around `=`', () => {
  const html = `<a onclick = "doThing()">x</a>`;
  assert.deepEqual(extractInlineEventHandlers(html), ['doThing()']);
});

// --- checkPolicyStructure -------------------------------------------------

function makeStructDirectives(overrides = {}) {
  return {
    'script-src': [
      "'self'",
      "'unsafe-eval'",
      "'unsafe-hashes'",
      INLINE_HANDLER_HASH,
      ...(overrides.scriptSrcExtra ?? []),
    ],
    'font-src': ["'self'", 'data:', ...(overrides.fontSrcExtra ?? [])],
    ...(overrides.extra ?? {}),
  };
}

test('checkPolicyStructure ok when all required tokens are present', () => {
  const result = checkPolicyStructure({
    directives: makeStructDirectives(),
    headerName: 'Content-Security-Policy-Report-Only',
  });
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("checkPolicyStructure fails when 'unsafe-hashes' is missing from script-src", () => {
  const directives = makeStructDirectives();
  directives['script-src'] = directives['script-src'].filter((t) => t !== "'unsafe-hashes'");
  const result = checkPolicyStructure({
    directives,
    headerName: 'Content-Security-Policy-Report-Only',
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("'unsafe-hashes'")),
    `expected an unsafe-hashes error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('checkPolicyStructure fails when the documented inline-handler hash is missing', () => {
  const directives = makeStructDirectives();
  directives['script-src'] = directives['script-src'].filter((t) => t !== INLINE_HANDLER_HASH);
  const result = checkPolicyStructure({
    directives,
    headerName: 'Content-Security-Policy-Report-Only',
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes(INLINE_HANDLER_HASH)),
    `expected an inline-handler-hash error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('checkPolicyStructure fails when script-src-attr is set (regression guard)', () => {
  const directives = makeStructDirectives({ extra: { 'script-src-attr': ["'none'"] } });
  const result = checkPolicyStructure({
    directives,
    headerName: 'Content-Security-Policy-Report-Only',
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('script-src-attr')),
    `expected a script-src-attr error, got: ${JSON.stringify(result.errors)}`,
  );
});

test("checkPolicyStructure fails when font-src lacks 'data:'", () => {
  const directives = makeStructDirectives();
  directives['font-src'] = ["'self'"];
  const result = checkPolicyStructure({
    directives,
    headerName: 'Content-Security-Policy-Report-Only',
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('font-src')),
    `expected a font-src error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('checkPolicyStructure fails when no CSP header is configured', () => {
  const result = checkPolicyStructure({ directives: {}, headerName: null });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('no CSP header')),
    `expected a no-CSP-header error, got: ${JSON.stringify(result.errors)}`,
  );
});

// --- computeExpectedHashes ------------------------------------------------

test('computeExpectedHashes unions hashes across multiple HTML strings', () => {
  const a = `<script>console.log("a");</script>`;
  const b = `<script>console.log("b");</script><link onload="this.media='all'">`;
  const result = computeExpectedHashes([a, b]);
  // 2 distinct script bodies + 1 distinct event-handler value = 3 hashes.
  assert.equal(result.expected.size, 3);
  assert.equal(result.scriptCount, 2);
  assert.equal(result.handlerCount, 1);
  // The documented inline-handler hash must be among the computed hashes.
  assert.ok(
    result.expected.has(INLINE_HANDLER_HASH),
    `expected to find ${INLINE_HANDLER_HASH} in computed hashes, got: ${[...result.expected].join(', ')}`,
  );
});

test('computeExpectedHashes deduplicates identical handlers across files', () => {
  // Same handler value in two HTML strings produces one hash, two counts.
  const html = `<link onload="this.media='all'">`;
  const result = computeExpectedHashes([html, html]);
  assert.equal(result.expected.size, 1);
  assert.equal(result.handlerCount, 2);
  assert.equal(result.scriptCount, 0);
});

// --- checkHashesAndPolicy -------------------------------------------------

function makeFullDirectives({ extraScriptSrc = [], includeUnsafeHashes = true } = {}) {
  return {
    'script-src': [
      "'self'",
      "'unsafe-eval'",
      ...(includeUnsafeHashes ? ["'unsafe-hashes'"] : []),
      INLINE_HANDLER_HASH,
      ...extraScriptSrc,
    ],
    'font-src': ["'self'", 'data:'],
  };
}

test('checkHashesAndPolicy ok when every expected hash is present and policy is structurally sound', () => {
  const expected = new Set([INLINE_HANDLER_HASH]);
  const result = checkHashesAndPolicy({
    expected,
    scriptCount: 0,
    handlerCount: 1,
    directives: makeFullDirectives(),
    headerName: 'Content-Security-Policy-Report-Only',
    mode: '--dist',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.stale, []);
  assert.deepEqual(result.structureErrors, []);
});

test('checkHashesAndPolicy reports a missing hash when an event handler is not in script-src', () => {
  const expected = new Set([INLINE_HANDLER_HASH, "'sha256-NotInPolicy='"]);
  const result = checkHashesAndPolicy({
    expected,
    scriptCount: 0,
    handlerCount: 2,
    directives: makeFullDirectives(),
    headerName: 'Content-Security-Policy-Report-Only',
    mode: '--dist',
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["'sha256-NotInPolicy='"]);
});

test('checkHashesAndPolicy reports a stale hash in --dist mode when the policy lists an unused hash', () => {
  // Policy lists an extra hash that does not appear in the expected set.
  const staleHash = "'sha256-IamStale='";
  const expected = new Set([INLINE_HANDLER_HASH]);
  const result = checkHashesAndPolicy({
    expected,
    scriptCount: 0,
    handlerCount: 1,
    directives: makeFullDirectives({ extraScriptSrc: [staleHash] }),
    headerName: 'Content-Security-Policy-Report-Only',
    mode: '--dist',
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.stale, [staleHash]);
});

test('checkHashesAndPolicy does NOT flag stale hashes in --src mode', () => {
  // In --src mode the source HTML lacks the inlineCritical handler entirely,
  // so the documented INLINE_HANDLER_HASH would otherwise look unused. The
  // stale check is intentionally skipped to avoid that false positive.
  const expected = new Set(); // src/index.html has no inline scripts in this synthetic case.
  const result = checkHashesAndPolicy({
    expected,
    scriptCount: 0,
    handlerCount: 0,
    directives: makeFullDirectives(),
    headerName: 'Content-Security-Policy-Report-Only',
    mode: '--src',
  });
  assert.deepEqual(result.stale, []);
  // Structure check still passes -- the policy itself is well-formed.
  assert.equal(result.ok, true);
});

test('checkHashesAndPolicy folds structure errors into the result', () => {
  // Drop 'unsafe-hashes' from the policy. Even with the hash list correct,
  // the structure check should fail and ok should be false.
  const expected = new Set([INLINE_HANDLER_HASH]);
  const result = checkHashesAndPolicy({
    expected,
    scriptCount: 0,
    handlerCount: 1,
    directives: makeFullDirectives({ includeUnsafeHashes: false }),
    headerName: 'Content-Security-Policy-Report-Only',
    mode: '--dist',
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.stale, []);
  assert.ok(
    result.structureErrors.some((e) => e.includes("'unsafe-hashes'")),
    `expected a structure error mentioning 'unsafe-hashes', got: ${JSON.stringify(result.structureErrors)}`,
  );
});

// --- end-to-end: hash a real handler value, verify against policy --------

test('the hash of `this.media=\\u0027all\\u0027` matches the documented INLINE_HANDLER_HASH', () => {
  // Ground truth: hashing the literal byte sequence Angular's inlineCritical
  // pattern emits should produce the constant we paste into the policy.
  // This guards against drift if someone updates the constant without
  // updating the literal it represents (or vice versa).
  assert.equal(sha256Token("this.media='all'"), INLINE_HANDLER_HASH);
});
