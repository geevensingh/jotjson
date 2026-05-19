// Unit tests for scripts/check-deploy-freshness.mjs.
//
// Runs under Node's built-in test runner: `node --test`. No external
// dependencies. The test file imports the script as a module; the
// script guards `main()` behind an "invoked directly" check so importing
// it does not trigger CLI side effects (network fetches, env reads,
// process.exit).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertIndexHtmlCacheControl,
  assertLegacyAlias,
  assertNgswJsonStub,
  assertSwJs,
  parseCliOptions,
  runDeployFreshnessCheck,
  waitForPropagation,
} from './check-deploy-freshness.mjs';

const ORIGIN = 'https://example.azurestaticapps.net';

const MINIMAL_SW_BODY = [
  '/* sw fixture */',
  "self.addEventListener('install', () => self.skipWaiting());",
  "self.addEventListener('activate', e => e.waitUntil(",
  '  caches.keys().then(k => Promise.all(k.map(n => caches.delete(n))))',
  '    .then(() => self.clients.claim())));',
  "self.addEventListener('fetch', () => {});",
  '// jotjson-sw-migration sentinel: legacyCacheWiped',
  '',
].join('\n');

const MINIMAL_SW_BYTES = Buffer.from(MINIMAL_SW_BODY, 'utf8');

function swResponse(body, { status = 200, cacheControl = 'no-store' } = {}) {
  const headers = new Headers();
  if (cacheControl !== null) headers.set('Cache-Control', cacheControl);
  return new Response(body, { status, headers });
}

function silentLogger() {
  return { log() {} };
}

test('parseCliOptions prefers CLI values and normalizes origin', () => {
  const options = parseCliOptions(
    ['--origin=https://example.azurestaticapps.net/path', '--local-sw=/tmp/sw.js'],
    {
      DEPLOY_ORIGIN: 'https://env.example.com',
    },
  );

  assert.equal(options.origin, ORIGIN);
  assert.equal(options.originSource, '--origin');
  assert.equal(options.localSwPath.endsWith('sw.js'), true);
});

test('parseCliOptions falls back to DEPLOY_ORIGIN', () => {
  const options = parseCliOptions([], {
    DEPLOY_ORIGIN: 'https://nonprod.example.com',
  });
  assert.equal(options.origin, 'https://nonprod.example.com');
  assert.equal(options.originSource, 'DEPLOY_ORIGIN');
});

test('parseCliOptions falls back to default origin', () => {
  const options = parseCliOptions([], {});
  assert.equal(options.origin, 'https://jotjson.com');
  assert.equal(options.originSource, 'default');
});

test('parseCliOptions rejects non-https origins', () => {
  assert.throws(
    () => parseCliOptions(['--origin=http://example.com'], {}),
    /Expected an https:\/\/ URL/,
  );
});

test('waitForPropagation retries until the SW body byte-matches', async () => {
  const fetchUrls = [];
  const delays = [];
  const responses = [swResponse('old-sw'), swResponse(MINIMAL_SW_BODY)];
  const observedNowValues = [0, 0, 0, 5_000, 5_000];

  await waitForPropagation({
    origin: ORIGIN,
    localSwBytes: MINIMAL_SW_BYTES,
    logger: silentLogger(),
    fetchImpl: async (url) => {
      fetchUrls.push(url);
      return responses.shift();
    },
    sleepImpl: async (delayMs) => {
      delays.push(delayMs);
    },
    nowImpl: () => observedNowValues.shift() ?? 5_000,
    createProbeToken: () => `probe-${fetchUrls.length + 1}`,
  });

  assert.deepEqual(delays, [5_000]);
  assert.equal(fetchUrls.length, 2);
  assert.match(fetchUrls[0], /\/sw\.js\?probe=probe-1$/);
  assert.match(fetchUrls[1], /\/sw\.js\?probe=probe-2$/);
});

test('waitForPropagation times out when bytes never match', async () => {
  await assert.rejects(
    () =>
      waitForPropagation({
        origin: ORIGIN,
        localSwBytes: MINIMAL_SW_BYTES,
        logger: silentLogger(),
        fetchImpl: async () => swResponse('old-sw'),
        sleepImpl: async () => {},
        nowImpl: (() => {
          let t = 0;
          return () => {
            const v = t;
            t += 60_000;
            return v;
          };
        })(),
        timeoutMs: 30_000,
        createProbeToken: () => 'token',
      }),
    /timed out after 30000ms/,
  );
});

test('assertSwJs fails when Cache-Control is wrong', async () => {
  await assert.rejects(
    () =>
      assertSwJs({
        origin: ORIGIN,
        logger: silentLogger(),
        fetchImpl: async () => swResponse(MINIMAL_SW_BODY, { cacheControl: 'public, max-age=60' }),
      }),
    /Cache-Control must be 'no-store'/,
  );
});

test('assertSwJs fails when body is missing a required substring', async () => {
  await assert.rejects(
    () =>
      assertSwJs({
        origin: ORIGIN,
        logger: silentLogger(),
        fetchImpl: async () => swResponse('window.x = 1;'),
      }),
    /missing required substring 'skipWaiting'/,
  );
});

test('assertSwJs returns canonical bytes on success', async () => {
  const bytes = await assertSwJs({
    origin: ORIGIN,
    logger: silentLogger(),
    fetchImpl: async () => swResponse(MINIMAL_SW_BODY),
  });
  assert.equal(Buffer.compare(bytes, MINIMAL_SW_BYTES), 0);
});

test('assertLegacyAlias fails when bytes differ from canonical', async () => {
  await assert.rejects(
    () =>
      assertLegacyAlias({
        origin: ORIGIN,
        legacyUrl: '/ngsw-worker.js',
        canonicalBytes: MINIMAL_SW_BYTES,
        logger: silentLogger(),
        fetchImpl: async () => swResponse('different bytes'),
      }),
    /bytes differ from \/sw\.js/,
  );
});

test('assertLegacyAlias passes when bytes are byte-identical', async () => {
  await assertLegacyAlias({
    origin: ORIGIN,
    legacyUrl: '/ngsw-worker.js',
    canonicalBytes: MINIMAL_SW_BYTES,
    logger: silentLogger(),
    fetchImpl: async () => swResponse(MINIMAL_SW_BODY),
  });
});

test('assertNgswJsonStub fails when body is not {}', async () => {
  await assert.rejects(
    () =>
      assertNgswJsonStub({
        origin: ORIGIN,
        logger: silentLogger(),
        fetchImpl: async () => new Response('{"appData":{}}\n', { status: 200 }),
      }),
    /body must be exactly/,
  );
});

test('assertNgswJsonStub passes when body is exactly {}\\n', async () => {
  await assertNgswJsonStub({
    origin: ORIGIN,
    logger: silentLogger(),
    fetchImpl: async () => new Response('{}\n', { status: 200 }),
  });
});

test('assertIndexHtmlCacheControl fails when header is wrong', async () => {
  await assert.rejects(
    () =>
      assertIndexHtmlCacheControl({
        origin: ORIGIN,
        logger: silentLogger(),
        fetchImpl: async () =>
          new Response('<html></html>', {
            status: 200,
            headers: { 'Cache-Control': 'public, max-age=60' },
          }),
      }),
    /must be 'no-cache, must-revalidate'/,
  );
});

test('assertIndexHtmlCacheControl passes when header is no-cache, must-revalidate', async () => {
  await assertIndexHtmlCacheControl({
    origin: ORIGIN,
    logger: silentLogger(),
    fetchImpl: async () =>
      new Response('<html></html>', {
        status: 200,
        headers: { 'Cache-Control': 'no-cache, must-revalidate' },
      }),
  });
});

test('runDeployFreshnessCheck runs the full sequence in order', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/sw.js?probe=')) return swResponse(MINIMAL_SW_BODY);
    if (url.endsWith('/sw.js')) return swResponse(MINIMAL_SW_BODY);
    if (url.endsWith('/ngsw-worker.js')) return swResponse(MINIMAL_SW_BODY);
    if (url.endsWith('/ngsw.json')) return new Response('{}\n', { status: 200 });
    if (url.endsWith('/index.html')) {
      return new Response('<html></html>', {
        status: 200,
        headers: { 'Cache-Control': 'no-cache, must-revalidate' },
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  await runDeployFreshnessCheck({
    origin: ORIGIN,
    localSwBytes: MINIMAL_SW_BYTES,
    logger: silentLogger(),
    fetchImpl,
    sleepImpl: async () => {},
    nowImpl: () => 0,
    createProbeToken: () => 'token',
  });

  assert.equal(calls.length, 5);
  assert.match(calls[0], /\/sw\.js\?probe=token$/);
  assert.equal(calls[1], `${ORIGIN}/sw.js`);
  assert.equal(calls[2], `${ORIGIN}/ngsw-worker.js`);
  assert.equal(calls[3], `${ORIGIN}/ngsw.json`);
  assert.equal(calls[4], `${ORIGIN}/index.html`);
});
