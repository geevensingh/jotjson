// Unit tests for scripts/check-swa-config.mjs.
//
// Runs under Node's built-in test runner: `node --test`. No external
// dependencies. The test file imports the script as a module; the script
// guards `main()` behind an "invoked directly" check so importing it does
// not trigger CLI side effects (fs reads, process.exit).
//
// Coverage shape: one happy-path test that reads the actual
// `staticwebapp.config.json` and asserts no errors, then one negative
// test per assertion (mutating a clone of the parsed config in-memory)
// to prove each assertion is doing real work. Each negative test asserts
// at least one error is returned AND that the error message mentions the
// expected field name, so a future refactor that silently swallows the
// failure into a different code path is still caught.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkConfig,
  checkGlobalHeaders,
  checkMimeTypes,
  checkNavigationFallback,
  checkPlatform,
  checkRoutes,
  expandBraceGlob,
  getExcludedExtensions,
  readConfig,
  routeMatchesPath,
  SHELL_CACHE_CONTROL,
  SHELL_PATHS,
  SUPPORTED_API_RUNTIMES,
  SW_GATEWAY_CACHE_CONTROL,
  SW_GATEWAY_PATHS,
} from './check-swa-config.mjs';

// Deep-clones via JSON. Sufficient for our config shape (plain JSON,
// no Dates / Maps / Sets / functions / undefined sentinels).
function cloneConfig() {
  return JSON.parse(JSON.stringify(readConfig()));
}

function assertHasErrorMatching(errors, matcher) {
  assert.ok(errors.length > 0, `expected at least one error, got none`);
  const test =
    typeof matcher === 'string'
      ? (message) => message.includes(matcher)
      : (message) => matcher.test(message);
  const matched = errors.some(test);
  assert.ok(
    matched,
    `expected an error matching ${matcher}, got:\n${errors.map((m) => `  - ${m}`).join('\n')}`,
  );
}

// --- expandBraceGlob ------------------------------------------------------

test('expandBraceGlob expands a single brace group', () => {
  assert.deepEqual(expandBraceGlob('*.{js,css}'), ['*.js', '*.css']);
});

test('expandBraceGlob passes through entries with no braces', () => {
  assert.deepEqual(expandBraceGlob('/api/*'), ['/api/*']);
});

test('expandBraceGlob expands multiple groups recursively', () => {
  assert.deepEqual(expandBraceGlob('{a,b}.{x,y}').sort(), ['a.x', 'a.y', 'b.x', 'b.y']);
});

// --- getExcludedExtensions ------------------------------------------------

test('getExcludedExtensions parses the brace-grouped form', () => {
  const exts = getExcludedExtensions(['/*.{js,css,map}']);
  assert.equal(exts.has('js'), true);
  assert.equal(exts.has('css'), true);
  assert.equal(exts.has('map'), true);
});

test('getExcludedExtensions parses split entries (no brace group)', () => {
  const exts = getExcludedExtensions(['/*.js', '/*.css']);
  assert.equal(exts.has('js'), true);
  assert.equal(exts.has('css'), true);
});

test('getExcludedExtensions ignores entries that are not *.EXT shape', () => {
  const exts = getExcludedExtensions(['/api/*', '/foo']);
  assert.equal(exts.size, 0);
});

// --- routePatternToRegex / routeMatchesPath -------------------------------

test('routePatternToRegex single * matches across segments (SWA semantics)', () => {
  assert.equal(routeMatchesPath('/api/*', '/api/blobs'), true);
  assert.equal(routeMatchesPath('/api/*', '/api/blobs/123'), true);
  assert.equal(routeMatchesPath('/api/*', '/api/me/preferences'), true);
});

test('routePatternToRegex /* matches every absolute path', () => {
  for (const path of [
    '/index.html',
    '/404/index.html',
    '/shell.html',
    '/ngsw.json',
    '/ngsw-worker.js',
  ]) {
    assert.equal(routeMatchesPath('/*', path), true, `expected '/*' to match '${path}'`);
  }
});

test('routePatternToRegex *.{ext,ext} respects the extension filter', () => {
  assert.equal(routeMatchesPath('/*.{html,htm}', '/index.html'), true);
  assert.equal(routeMatchesPath('/*.{html,htm}', '/404/index.html'), true);
  assert.equal(routeMatchesPath('/*.{html,htm}', '/ngsw.json'), false);
});

test('routePatternToRegex *.ext respects the extension filter', () => {
  assert.equal(routeMatchesPath('/*.json', '/ngsw.json'), true);
  assert.equal(routeMatchesPath('/*.js', '/ngsw-worker.js'), true);
  assert.equal(routeMatchesPath('/*.json', '/index.html'), false);
});

test('routePatternToRegex collapses non-SWA ** to single * (defensive)', () => {
  // SWA does not define `**`. Treating it the same as `*` ensures a
  // contributor cannot silently bypass the shadowing check by writing
  // `/**` instead of `/*`.
  assert.equal(routeMatchesPath('/api/**', '/api/blobs/123'), true);
});

test('routePatternToRegex escapes regex metacharacters in the literal prefix', () => {
  assert.equal(routeMatchesPath('/index.html', '/index.html'), true);
  // The `.` in `.html` must not match `/indexXhtml`.
  assert.equal(routeMatchesPath('/index.html', '/indexXhtml'), false);
});

test('routePatternToRegex non-wildcard pattern equals exact match', () => {
  assert.equal(routeMatchesPath('/api/blobs', '/api/blobs'), true);
  assert.equal(routeMatchesPath('/api/blobs', '/api/blobs/123'), false);
});

// --- Happy path: real config passes all assertions ------------------------

test('checkConfig passes on the actual staticwebapp.config.json', () => {
  const result = checkConfig(readConfig());
  assert.deepEqual(
    result.errors,
    [],
    `expected no errors, got:\n${result.errors.map((m) => `  - ${m}`).join('\n')}`,
  );
  assert.equal(result.ok, true);
});

// --- Negative: X-Frame-Options drift --------------------------------------

test('X-Frame-Options set to DENY fails (re-breaks MSAL silent SSO)', () => {
  const config = cloneConfig();
  config.globalHeaders['X-Frame-Options'] = 'DENY';
  assertHasErrorMatching(checkGlobalHeaders(config), /X-Frame-Options/);
});

test('X-Frame-Options removed entirely fails', () => {
  const config = cloneConfig();
  delete config.globalHeaders['X-Frame-Options'];
  assertHasErrorMatching(checkGlobalHeaders(config), /X-Frame-Options/);
});

// --- Negative: X-Content-Type-Options -------------------------------------

test('X-Content-Type-Options removed fails', () => {
  const config = cloneConfig();
  delete config.globalHeaders['X-Content-Type-Options'];
  assertHasErrorMatching(checkGlobalHeaders(config), /X-Content-Type-Options/);
});

// --- Negative: HSTS -------------------------------------------------------

test('HSTS max-age below 1 year fails', () => {
  const config = cloneConfig();
  config.globalHeaders['Strict-Transport-Security'] = 'max-age=86400; includeSubDomains';
  assertHasErrorMatching(checkGlobalHeaders(config), /max-age=86400/);
});

test('HSTS missing includeSubDomains fails', () => {
  const config = cloneConfig();
  config.globalHeaders['Strict-Transport-Security'] = 'max-age=31536000';
  assertHasErrorMatching(checkGlobalHeaders(config), /includeSubDomains/);
});

test('HSTS header missing entirely fails', () => {
  const config = cloneConfig();
  delete config.globalHeaders['Strict-Transport-Security'];
  assertHasErrorMatching(checkGlobalHeaders(config), /Strict-Transport-Security/);
});

// --- Negative: Referrer-Policy --------------------------------------------

test('Referrer-Policy removed fails', () => {
  const config = cloneConfig();
  delete config.globalHeaders['Referrer-Policy'];
  assertHasErrorMatching(checkGlobalHeaders(config), /Referrer-Policy/);
});

// --- Negative: Permissions-Policy -----------------------------------------

test('Permissions-Policy mutated to drop clipboard-write fails', () => {
  const config = cloneConfig();
  config.globalHeaders['Permissions-Policy'] = 'clipboard-read=(self)';
  assertHasErrorMatching(checkGlobalHeaders(config), /Permissions-Policy/);
});

// --- Negative: CSP header presence ----------------------------------------

test('CSP header removed fails (delegated detailed checks to check-csp-hashes.mjs)', () => {
  const config = cloneConfig();
  delete config.globalHeaders['Content-Security-Policy'];
  assertHasErrorMatching(checkGlobalHeaders(config), /Content-Security-Policy/);
});

// --- Negative: navigationFallback.rewrite ---------------------------------

test('navigationFallback.rewrite set to /index.html fails', () => {
  const config = cloneConfig();
  config.navigationFallback.rewrite = '/index.html';
  assertHasErrorMatching(checkNavigationFallback(config), /rewrite/);
});

// --- Negative: navigationFallback.exclude ---------------------------------

test('navigationFallback.exclude missing /api/* fails', () => {
  const config = cloneConfig();
  config.navigationFallback.exclude = config.navigationFallback.exclude.filter(
    (entry) => entry !== '/api/*',
  );
  assertHasErrorMatching(checkNavigationFallback(config), /\/api\/\*/);
});

test('navigationFallback.exclude missing a static-asset extension fails', () => {
  const config = cloneConfig();
  // Replace the brace-grouped entry with one that lacks `webmanifest`.
  config.navigationFallback.exclude = ['/api/*', '/*.{js,css,map,svg,ico,png,jpg,webp,woff,woff2}'];
  assertHasErrorMatching(checkNavigationFallback(config), /webmanifest/);
});

test('navigationFallback.exclude split into multiple entries passes', () => {
  // Proves the brace-expander is doing real work: a contributor can split
  // `*.{js,css}` into `*.js` and `*.css` without tripping the gate.
  const config = cloneConfig();
  config.navigationFallback.exclude = [
    '/api/*',
    '/*.js',
    '/*.css',
    '/*.map',
    '/*.svg',
    '/*.ico',
    '/*.png',
    '/*.jpg',
    '/*.webp',
    '/*.woff',
    '/*.woff2',
    '/*.webmanifest',
  ];
  assert.deepEqual(checkNavigationFallback(config), []);
});

// --- Negative: /api/* allowedRoles ----------------------------------------

test('/api/* allowedRoles missing anonymous fails', () => {
  const config = cloneConfig();
  const apiRoute = config.routes.find((route) => route.route === '/api/*');
  assert.ok(apiRoute, "expected base config to contain a '/api/*' route");
  apiRoute.allowedRoles = ['authenticated'];
  assertHasErrorMatching(checkRoutes(config), /anonymous/);
});

// --- Positive: split Cache-Control shape ----------------------------------

test('checkRoutes accepts SW gateway no-store and HTML shell revalidation split', () => {
  const config = cloneConfig();
  assert.deepEqual(checkRoutes(config), []);

  for (const path of SW_GATEWAY_PATHS) {
    const route = config.routes.find((entry) => entry.route === path);
    assert.ok(route, `expected base config to contain a '${path}' route`);
    assert.equal(route.headers?.['Cache-Control'], SW_GATEWAY_CACHE_CONTROL);
  }

  for (const path of SHELL_PATHS) {
    const route = config.routes.find((entry) => entry.route === path);
    assert.ok(route, `expected base config to contain a '${path}' route`);
    assert.equal(route.headers?.['Cache-Control'], SHELL_CACHE_CONTROL);
  }
});

// --- Negative: route-order shadowing --------------------------------------

test('wildcard route preceding service worker gateway rules fails', () => {
  const config = cloneConfig();
  config.routes.splice(1, 0, {
    route: '/*.{json,js}',
    headers: { 'Cache-Control': 'public, max-age=31536000' },
  });
  assertHasErrorMatching(
    checkRoutes(config),
    /service worker gateway.*issue #167|issue #167.*service worker gateway/,
  );
});

test('wildcard route preceding HTML shell rules fails', () => {
  const config = cloneConfig();
  config.routes.splice(1, 0, {
    route: '/*.html',
    headers: { 'Cache-Control': 'public, max-age=31536000' },
  });
  assertHasErrorMatching(checkRoutes(config), /HTML shell.*issue #167|issue #167.*HTML shell/);
});

// --- Negative: Cache-Control per grouped path -----------------------------

for (const path of SW_GATEWAY_PATHS) {
  test(`service worker gateway Cache-Control rule for ${path} removed fails`, () => {
    const config = cloneConfig();
    config.routes = config.routes.filter((entry) => entry.route !== path);
    assertHasErrorMatching(checkRoutes(config), new RegExp(`${path}.*service worker gateway`));
  });

  test(`service worker gateway Cache-Control value drift on ${path} fails`, () => {
    const config = cloneConfig();
    const route = config.routes.find((entry) => entry.route === path);
    assert.ok(route, `expected base config to contain a '${path}' route`);
    assert.ok(route.headers, `expected '${path}' route to have a headers object`);
    route.headers['Cache-Control'] = 'no-cache, must-revalidate';
    assertHasErrorMatching(
      checkRoutes(config),
      new RegExp(`${path}.*service worker gateway.*issue #167`),
    );
    route.headers['Cache-Control'] = SW_GATEWAY_CACHE_CONTROL;
    const routeErrors = checkRoutes(config).filter((message) =>
      message.includes(`routes['${path}']`),
    );
    assert.deepEqual(routeErrors, []);
  });
}

for (const path of SHELL_PATHS) {
  test(`HTML shell Cache-Control rule for ${path} removed fails`, () => {
    const config = cloneConfig();
    config.routes = config.routes.filter((entry) => entry.route !== path);
    assertHasErrorMatching(checkRoutes(config), new RegExp(`${path}.*HTML shell`));
  });

  test(`HTML shell Cache-Control value drift on ${path} fails`, () => {
    const config = cloneConfig();
    const route = config.routes.find((entry) => entry.route === path);
    assert.ok(route, `expected base config to contain a '${path}' route`);
    assert.ok(route.headers, `expected '${path}' route to have a headers object`);
    route.headers['Cache-Control'] = 'no-store';
    assertHasErrorMatching(checkRoutes(config), new RegExp(`${path}.*HTML shell.*issue #167`));
    route.headers['Cache-Control'] = SHELL_CACHE_CONTROL;
    const routeErrors = checkRoutes(config).filter((message) =>
      message.includes(`routes['${path}']`),
    );
    assert.deepEqual(routeErrors, []);
  });
}

// --- Negative: platform.apiRuntime ----------------------------------------

test('platform.apiRuntime missing fails', () => {
  const config = cloneConfig();
  delete config.platform;
  assertHasErrorMatching(checkPlatform(config), /apiRuntime/);
});

test('platform.apiRuntime set to node:18 (EOL) fails', () => {
  const config = cloneConfig();
  config.platform.apiRuntime = 'node:18';
  assertHasErrorMatching(checkPlatform(config), /node:18/);
});

test('platform.apiRuntime set to each allowlisted value passes', () => {
  for (const runtime of SUPPORTED_API_RUNTIMES) {
    const config = cloneConfig();
    config.platform.apiRuntime = runtime;
    assert.deepEqual(checkPlatform(config), [], `expected '${runtime}' to be accepted, got errors`);
  }
});

// --- Negative: mimeTypes --------------------------------------------------

test('mimeTypes[.webmanifest] removed fails', () => {
  const config = cloneConfig();
  delete config.mimeTypes['.webmanifest'];
  assertHasErrorMatching(checkMimeTypes(config), /\.webmanifest/);
});

test('mimeTypes key without leading dot fails (proves dot-prefix is intentional)', () => {
  const config = cloneConfig();
  config.mimeTypes['webmanifest'] = config.mimeTypes['.webmanifest'];
  delete config.mimeTypes['.webmanifest'];
  assertHasErrorMatching(checkMimeTypes(config), /\.webmanifest/);
});

// --- checkConfig aggregator -----------------------------------------------

test('checkConfig aggregates errors from all sub-checks', () => {
  const config = cloneConfig();
  config.globalHeaders['X-Frame-Options'] = 'DENY';
  config.platform.apiRuntime = 'node:18';
  const result = checkConfig(config);
  assert.equal(result.ok, false);
  assertHasErrorMatching(result.errors, /X-Frame-Options/);
  assertHasErrorMatching(result.errors, /node:18/);
});
