// Unit tests for scripts/check-deploy-freshness.mjs.
//
// Runs under Node's built-in test runner: `node --test`. No external
// dependencies. The test file imports the script as a module; the script
// guards `main()` behind an "invoked directly" check so importing it does
// not trigger CLI side effects (network fetches, env reads, process.exit).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertNgswJsonNoStore,
  parseCliOptions,
  runDeployFreshnessCheck,
  waitForPropagation,
} from './check-deploy-freshness.mjs';

const EXPECTED_SHA = 'abc123def456';
const ORIGIN = 'https://example.azurestaticapps.net';

function manifestResponse(buildSha, status = 200) {
  return new Response(JSON.stringify({ appData: { buildSha } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptyResponse(status = 200) {
  return new Response(status === 304 ? null : 'ok', { status });
}

function silentLogger() {
  return {
    log() {},
  };
}

test('parseCliOptions prefers CLI values and normalizes origin', () => {
  const options = parseCliOptions(
    ['--expected-sha=cli-sha', '--origin=https://example.azurestaticapps.net/path'],
    {
      GITHUB_SHA: 'github-sha',
      EXPECTED_SHA: 'env-sha',
      DEPLOY_ORIGIN: 'https://env.example.com',
    },
  );

  assert.deepEqual(options, {
    expectedSha: 'cli-sha',
    expectedShaSource: '--expected-sha',
    origin: ORIGIN,
    originSource: '--origin',
  });
});

test('waitForPropagation retries with exponential backoff until the deployed sha appears', async () => {
  const fetchUrls = [];
  const delays = [];
  const responses = [manifestResponse('old-sha'), manifestResponse(EXPECTED_SHA)];
  const observedNowValues = [0, 0, 0, 5_000, 5_000];

  await waitForPropagation({
    expectedSha: EXPECTED_SHA,
    origin: ORIGIN,
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
  assert.match(fetchUrls[0], /\/ngsw\.json\?probe=probe-1$/);
  assert.match(fetchUrls[1], /\/ngsw\.json\?probe=probe-2$/);
});

test('runDeployFreshnessCheck sends stale If-None-Match headers to both gateway files', async () => {
  const calls = [];
  const responses = [
    manifestResponse(EXPECTED_SHA),
    manifestResponse(EXPECTED_SHA),
    emptyResponse(200),
  ];

  await runDeployFreshnessCheck({
    expectedSha: EXPECTED_SHA,
    origin: ORIGIN,
    logger: silentLogger(),
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return responses.shift();
    },
    sleepImpl: async () => {},
    nowImpl: () => 0,
    createProbeToken: () => 'etag-token',
  });

  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/ngsw\.json\?probe=etag-token$/);
  assert.equal(calls[0].options.headers, undefined);
  assert.equal(calls[1].url, `${ORIGIN}/ngsw.json`);
  assert.deepEqual(calls[1].options.headers, { 'If-None-Match': '"probe-etag-token"' });
  assert.equal(calls[2].url, `${ORIGIN}/ngsw-worker.js`);
  assert.deepEqual(calls[2].options.headers, { 'If-None-Match': '"probe-etag-token"' });
});

test('assertNgswJsonNoStore fails clearly on a 304 response', async () => {
  await assert.rejects(
    () =>
      assertNgswJsonNoStore({
        expectedSha: EXPECTED_SHA,
        origin: ORIGIN,
        logger: silentLogger(),
        fetchImpl: async () => emptyResponse(304),
        createProbeToken: () => 'stale-token',
      }),
    /\/ngsw\.json no-store assertion failed: expected 200, got 304/,
  );
});

test('assertNgswJsonNoStore fails clearly when appData is missing', async () => {
  await assert.rejects(
    () =>
      assertNgswJsonNoStore({
        expectedSha: EXPECTED_SHA,
        origin: ORIGIN,
        logger: silentLogger(),
        fetchImpl: async () =>
          new Response(JSON.stringify({ hashTable: {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        createProbeToken: () => 'stale-token',
      }),
    /\/ngsw\.json no-store assertion failed: manifest JSON has no appData object/,
  );
});
