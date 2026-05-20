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
  assertBuildInfoJson,
  assertIndexHtmlCacheControl,
  assertLegacyAlias,
  assertNgswJsonStub,
  assertSwJs,
  parseCliOptions,
  runDeployFreshnessCheck,
  waitForPropagation,
} from './check-deploy-freshness.mjs';

const ORIGIN = 'https://example.azurestaticapps.net';
const VALID_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const OTHER_SHA = '0123456789abcdef0123456789abcdef01234567';

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
    [
      '--origin=https://example.azurestaticapps.net/path',
      '--local-sw=/tmp/sw.js',
      `--expected-sha=${VALID_SHA}`,
    ],
    {
      DEPLOY_ORIGIN: 'https://env.example.com',
    },
  );

  assert.equal(options.origin, ORIGIN);
  assert.equal(options.originSource, '--origin');
  assert.equal(options.localSwPath.endsWith('sw.js'), true);
});

test('parseCliOptions falls back to DEPLOY_ORIGIN', () => {
  const options = parseCliOptions([`--expected-sha=${VALID_SHA}`], {
    DEPLOY_ORIGIN: 'https://nonprod.example.com',
  });
  assert.equal(options.origin, 'https://nonprod.example.com');
  assert.equal(options.originSource, 'DEPLOY_ORIGIN');
});

test('parseCliOptions falls back to default origin', () => {
  const options = parseCliOptions([`--expected-sha=${VALID_SHA}`], {});
  assert.equal(options.origin, 'https://jotjson.com');
  assert.equal(options.originSource, 'default');
});

test('parseCliOptions rejects non-https origins', () => {
  assert.throws(
    () => parseCliOptions(['--origin=http://example.com', `--expected-sha=${VALID_SHA}`], {}),
    /Expected an https:\/\/ URL/,
  );
});

test('parseCliOptions rejects unknown arguments', () => {
  assert.throws(
    () =>
      parseCliOptions(
        ['--bogus-flag=value', '--origin=https://example.com', `--expected-sha=${VALID_SHA}`],
        {},
      ),
    /Unknown argument '--bogus-flag=value'/,
  );
});

test('parseCliOptions accepts --expected-sha=<40-hex>', () => {
  const options = parseCliOptions(
    ['--origin=https://example.com', `--expected-sha=${VALID_SHA}`],
    {},
  );
  assert.equal(options.expectedSha, VALID_SHA);
  assert.equal(options.allowByteMatchOnly, false);
});

test('parseCliOptions accepts --allow-byte-match-only', () => {
  const options = parseCliOptions(['--origin=https://example.com', '--allow-byte-match-only'], {});
  assert.equal(options.expectedSha, null);
  assert.equal(options.allowByteMatchOnly, true);
});

test('parseCliOptions rejects missing --expected-sha without --allow-byte-match-only', () => {
  // Strictness-by-default closes the PR #337 silent-degradation hole:
  // the previous design rejected --expected-sha entirely, so PR #337
  // shipped without SHA-tied verification once the workflow argv
  // started passing the flag. The fix inverts the default to require
  // --expected-sha and offer an explicit escape hatch.
  assert.throws(
    () => parseCliOptions(['--origin=https://example.com'], {}),
    /Missing required --expected-sha/,
  );
});

test('parseCliOptions rejects non-40-hex --expected-sha values', () => {
  for (const bad of [
    'abc123', // too short
    'ABCDEF0123456789ABCDEF0123456789ABCDEF01', // uppercase
    `${VALID_SHA}g`, // 41 chars, invalid hex
    `${VALID_SHA}0`, // 41 hex chars
    'not-a-sha-at-all-not-a-sha-at-all-notash1', // 41-char garbage
  ]) {
    assert.throws(
      () => parseCliOptions(['--origin=https://example.com', `--expected-sha=${bad}`], {}),
      /Invalid --expected-sha value/,
      `should reject ${JSON.stringify(bad)}`,
    );
  }
});

test('parseCliOptions rejects empty --expected-sha= value', () => {
  // Catches empty-string runtime evaluation of GitHub Actions
  // `${{ vars.MISSING }}` expressions; the workflow yaml looks
  // valid but evaluates to `--expected-sha=` at runtime.
  assert.throws(
    () => parseCliOptions(['--origin=https://example.com', '--expected-sha='], {}),
    /Missing required --expected-sha/,
  );
});

test('parseCliOptions rejects both --expected-sha and --allow-byte-match-only', () => {
  assert.throws(
    () =>
      parseCliOptions(
        ['--origin=https://example.com', `--expected-sha=${VALID_SHA}`, '--allow-byte-match-only'],
        {},
      ),
    /mutually exclusive/,
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

test('waitForPropagation lockstep: retries when sw.js matches but build-info.json stale', async () => {
  const fetchUrls = [];
  const delays = [];
  // Iter 1: sw matches, build-info has wrong sha -> retry.
  // Iter 2: both match -> declared.
  const responses = [
    swResponse(MINIMAL_SW_BODY),
    new Response(JSON.stringify({ sha: OTHER_SHA }), { status: 200 }),
    swResponse(MINIMAL_SW_BODY),
    new Response(JSON.stringify({ sha: VALID_SHA }), { status: 200 }),
  ];

  await waitForPropagation({
    origin: ORIGIN,
    localSwBytes: MINIMAL_SW_BYTES,
    expectedSha: VALID_SHA,
    logger: silentLogger(),
    fetchImpl: async (url) => {
      fetchUrls.push(url);
      return responses.shift();
    },
    sleepImpl: async (delayMs) => {
      delays.push(delayMs);
    },
    nowImpl: (() => {
      let calls = 0;
      return () => (calls++ < 3 ? 0 : 5_000);
    })(),
    createProbeToken: (() => {
      let iter = 0;
      return () => `probe-${++iter}`;
    })(),
  });

  assert.equal(delays.length, 1, 'expected one sleep between two iterations');
  assert.equal(fetchUrls.length, 4, 'expected 2 lockstep fetches x 2 iters');
  assert.match(fetchUrls[0], /\/sw\.js\?probe=probe-1$/);
  assert.match(fetchUrls[1], /\/build-info\.json\?probe=probe-1$/);
  assert.match(fetchUrls[2], /\/sw\.js\?probe=probe-2$/);
  assert.match(fetchUrls[3], /\/build-info\.json\?probe=probe-2$/);
});

test('waitForPropagation lockstep: retries when build-info matches but sw.js stale', async () => {
  const fetchUrls = [];
  const responses = [
    swResponse('old-sw'),
    new Response(JSON.stringify({ sha: VALID_SHA }), { status: 200 }),
    swResponse(MINIMAL_SW_BODY),
    new Response(JSON.stringify({ sha: VALID_SHA }), { status: 200 }),
  ];

  await waitForPropagation({
    origin: ORIGIN,
    localSwBytes: MINIMAL_SW_BYTES,
    expectedSha: VALID_SHA,
    logger: silentLogger(),
    fetchImpl: async (url) => {
      fetchUrls.push(url);
      return responses.shift();
    },
    sleepImpl: async () => {},
    nowImpl: (() => {
      let calls = 0;
      return () => (calls++ < 3 ? 0 : 5_000);
    })(),
    createProbeToken: (() => {
      let iter = 0;
      return () => `probe-${++iter}`;
    })(),
  });

  assert.equal(fetchUrls.length, 4);
  assert.equal(responses.length, 0);
});

test('waitForPropagation lockstep: both probe URLs share the same probe token per iteration', async () => {
  const fetchUrls = [];
  const responses = [
    swResponse(MINIMAL_SW_BODY),
    new Response(JSON.stringify({ sha: VALID_SHA }), { status: 200 }),
  ];

  await waitForPropagation({
    origin: ORIGIN,
    localSwBytes: MINIMAL_SW_BYTES,
    expectedSha: VALID_SHA,
    logger: silentLogger(),
    fetchImpl: async (url) => {
      fetchUrls.push(url);
      return responses.shift();
    },
    sleepImpl: async () => {},
    nowImpl: () => 0,
    createProbeToken: () => 'shared-token',
  });

  assert.match(fetchUrls[0], /\/sw\.js\?probe=shared-token$/);
  assert.match(fetchUrls[1], /\/build-info\.json\?probe=shared-token$/);
});

test('waitForPropagation lockstep: times out when build-info sha never matches', async () => {
  await assert.rejects(
    () =>
      waitForPropagation({
        origin: ORIGIN,
        localSwBytes: MINIMAL_SW_BYTES,
        expectedSha: VALID_SHA,
        logger: silentLogger(),
        fetchImpl: async (url) => {
          if (url.includes('/sw.js')) return swResponse(MINIMAL_SW_BODY);
          return new Response(JSON.stringify({ sha: OTHER_SHA }), { status: 200 });
        },
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
    /body\.sha to equal '[a-f0-9]+'/,
  );
});

test('assertBuildInfoJson passes when body.sha matches and Cache-Control is no-store', async () => {
  await assertBuildInfoJson({
    origin: ORIGIN,
    expectedSha: VALID_SHA,
    logger: silentLogger(),
    fetchImpl: async () =>
      new Response(JSON.stringify({ sha: VALID_SHA, version: '0.1.0' }), {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      }),
  });
});

test('assertBuildInfoJson fails on canonical URL (no probe= query)', async () => {
  // Substantive value: propagation poll uses ?probe= to defeat caches;
  // this assertion exercises the CANONICAL URL the SPA bundle / downstream
  // tooling actually fetch.
  let observedUrl = null;
  await assertBuildInfoJson({
    origin: ORIGIN,
    expectedSha: VALID_SHA,
    logger: silentLogger(),
    fetchImpl: async (url) => {
      observedUrl = url;
      return new Response(JSON.stringify({ sha: VALID_SHA }), {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      });
    },
  });
  assert.equal(observedUrl, `${ORIGIN}/build-info.json`);
  assert.equal(observedUrl.includes('?'), false, 'canonical URL must not include any query');
});

test('assertBuildInfoJson fails when body.sha mismatches expected', async () => {
  await assert.rejects(
    () =>
      assertBuildInfoJson({
        origin: ORIGIN,
        expectedSha: VALID_SHA,
        logger: silentLogger(),
        fetchImpl: async () =>
          new Response(JSON.stringify({ sha: OTHER_SHA }), {
            status: 200,
            headers: { 'Cache-Control': 'no-store' },
          }),
      }),
    /body\.sha is '0123456789abcdef0123456789abcdef01234567', expected 'abcdef0123456789abcdef0123456789abcdef01'/,
  );
});

test('assertBuildInfoJson fails when Cache-Control is wrong', async () => {
  await assert.rejects(
    () =>
      assertBuildInfoJson({
        origin: ORIGIN,
        expectedSha: VALID_SHA,
        logger: silentLogger(),
        fetchImpl: async () =>
          new Response(JSON.stringify({ sha: VALID_SHA }), {
            status: 200,
            headers: { 'Cache-Control': 'public, max-age=60' },
          }),
      }),
    /Cache-Control must be 'no-store'/,
  );
});

test('assertBuildInfoJson fails when body does not parse as JSON', async () => {
  await assert.rejects(
    () =>
      assertBuildInfoJson({
        origin: ORIGIN,
        expectedSha: VALID_SHA,
        logger: silentLogger(),
        fetchImpl: async () =>
          new Response('not json at all', {
            status: 200,
            headers: { 'Cache-Control': 'no-store' },
          }),
      }),
    /body did not parse as JSON/,
  );
});

test('assertBuildInfoJson fails when body has no string sha field', async () => {
  await assert.rejects(
    () =>
      assertBuildInfoJson({
        origin: ORIGIN,
        expectedSha: VALID_SHA,
        logger: silentLogger(),
        fetchImpl: async () =>
          new Response(JSON.stringify({ version: '0.1.0' }), {
            status: 200,
            headers: { 'Cache-Control': 'no-store' },
          }),
      }),
    /missing a string 'sha' field/,
  );
});

test('assertBuildInfoJson rejects callers that pass null expectedSha', async () => {
  await assert.rejects(
    () =>
      assertBuildInfoJson({
        origin: ORIGIN,
        expectedSha: null,
        logger: silentLogger(),
        fetchImpl: async () => new Response('', { status: 200 }),
      }),
    /requires expectedSha/,
  );
});

test('runDeployFreshnessCheck with --expected-sha hits build-info.json on canonical URL', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/sw.js?probe=')) return swResponse(MINIMAL_SW_BODY);
    if (url.includes('/build-info.json?probe=')) {
      return new Response(JSON.stringify({ sha: VALID_SHA }), { status: 200 });
    }
    if (url.endsWith('/sw.js')) return swResponse(MINIMAL_SW_BODY);
    if (url.endsWith('/ngsw-worker.js')) return swResponse(MINIMAL_SW_BODY);
    if (url.endsWith('/ngsw.json')) return new Response('{}\n', { status: 200 });
    if (url.endsWith('/index.html')) {
      return new Response('<html></html>', {
        status: 200,
        headers: { 'Cache-Control': 'no-cache, must-revalidate' },
      });
    }
    if (url.endsWith('/build-info.json')) {
      return new Response(JSON.stringify({ sha: VALID_SHA }), {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  await runDeployFreshnessCheck({
    origin: ORIGIN,
    localSwBytes: MINIMAL_SW_BYTES,
    expectedSha: VALID_SHA,
    logger: silentLogger(),
    fetchImpl,
    sleepImpl: async () => {},
    nowImpl: () => 0,
    createProbeToken: () => 'token',
  });

  assert.equal(calls.length, 7, 'expected 2 propagation + 4 canonical SW + 1 canonical build-info');
  assert.match(calls[0], /\/sw\.js\?probe=token$/);
  assert.match(calls[1], /\/build-info\.json\?probe=token$/);
  assert.equal(calls[2], `${ORIGIN}/sw.js`);
  assert.equal(calls[3], `${ORIGIN}/ngsw-worker.js`);
  assert.equal(calls[4], `${ORIGIN}/ngsw.json`);
  assert.equal(calls[5], `${ORIGIN}/index.html`);
  assert.equal(calls[6], `${ORIGIN}/build-info.json`);
});
