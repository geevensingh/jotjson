#!/usr/bin/env node
// scripts/check-deploy-freshness.mjs
//
// Post-deploy gate: verifies the SWA origin stops returning 304 for
// stale ETags on the Angular SW gateway files (/ngsw.json and
// /ngsw-worker.js).
//
// SCOPE: This probe verifies origin Cache-Control: no-store is in effect.
// It does NOT verify the user-visible "new tab shows old version"
// symptom -- that test requires a browser with a stale SW already
// controlling the origin, which neither this script nor Playwright
// can reproduce in a fresh context. The user-symptom verification is
// a manual smoke test post-deploy (see plan.md Phase 3.1).

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_ORIGIN = 'https://jotjson.com';
const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const NGSW_JSON_PATH = '/ngsw.json';
const NGSW_WORKER_PATH = '/ngsw-worker.js';

function randomProbeToken() {
  return randomUUID().replaceAll('-', '');
}

function readOptionWithOptionalValue(args, optionName) {
  const exactPrefix = `${optionName}=`;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument.startsWith(exactPrefix)) {
      return { value: argument.slice(exactPrefix.length), consumedIndexes: new Set([index]) };
    }
    if (argument === optionName) {
      const nextIndex = index + 1;
      const value = args[nextIndex];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${optionName}. Use ${optionName}=<value>.`);
      }
      return { value, consumedIndexes: new Set([index, nextIndex]) };
    }
  }
  return { value: null, consumedIndexes: new Set() };
}

function requireNoUnknownArgs(args, consumedIndexes) {
  for (let index = 0; index < args.length; index += 1) {
    if (!consumedIndexes.has(index)) {
      throw new Error(
        `Unknown argument '${args[index]}'. Valid options: --expected-sha, --origin.`,
      );
    }
  }
}

function normalizeOrigin(rawOrigin) {
  let parsedOrigin;
  try {
    parsedOrigin = new URL(rawOrigin);
  } catch (error) {
    throw new Error(`Invalid origin '${rawOrigin}'. Expected an absolute https:// URL.`);
  }
  if (parsedOrigin.protocol !== 'https:') {
    throw new Error(`Invalid origin '${rawOrigin}'. Expected an https:// URL.`);
  }
  return parsedOrigin.origin;
}

export function parseCliOptions(args = process.argv.slice(2), env = process.env) {
  const expectedShaOption = readOptionWithOptionalValue(args, '--expected-sha');
  const originOption = readOptionWithOptionalValue(args, '--origin');
  const consumedIndexes = new Set([
    ...expectedShaOption.consumedIndexes,
    ...originOption.consumedIndexes,
  ]);
  requireNoUnknownArgs(args, consumedIndexes);

  const cliExpectedSha = expectedShaOption.value?.trim() ?? '';
  const envGithubSha = env.GITHUB_SHA?.trim() ?? '';
  const envExpectedSha = env.EXPECTED_SHA?.trim() ?? '';
  const expectedSha = cliExpectedSha || envGithubSha || envExpectedSha;
  const expectedShaSource = cliExpectedSha
    ? '--expected-sha'
    : envGithubSha
      ? 'GITHUB_SHA'
      : envExpectedSha
        ? 'EXPECTED_SHA'
        : null;

  if (!expectedSha) {
    throw new Error(
      'Missing expected SHA. Pass --expected-sha=<sha> or set GITHUB_SHA / EXPECTED_SHA.',
    );
  }

  const cliOrigin = originOption.value?.trim() ?? '';
  const envOrigin = env.DEPLOY_ORIGIN?.trim() ?? '';
  const rawOrigin = cliOrigin || envOrigin || DEFAULT_ORIGIN;
  const originSource = cliOrigin ? '--origin' : envOrigin ? 'DEPLOY_ORIGIN' : 'default';

  return {
    expectedSha,
    expectedShaSource,
    origin: normalizeOrigin(rawOrigin),
    originSource,
  };
}

function buildUrl(origin, pathname, searchParams = {}) {
  const url = new URL(pathname, origin);
  for (const [name, value] of Object.entries(searchParams)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

function extractBuildSha(ngswManifest) {
  if (!ngswManifest || typeof ngswManifest !== 'object' || Array.isArray(ngswManifest)) {
    return { ok: false, reason: 'manifest JSON is not an object' };
  }
  const appData = ngswManifest.appData;
  if (!appData || typeof appData !== 'object' || Array.isArray(appData)) {
    return { ok: false, reason: 'manifest JSON has no appData object' };
  }
  const buildSha = appData.buildSha;
  if (typeof buildSha !== 'string' || buildSha.length === 0) {
    return { ok: false, reason: 'manifest JSON has no appData.buildSha string' };
  }
  return { ok: true, buildSha };
}

async function readManifestBuildSha(response) {
  let manifestJson;
  try {
    manifestJson = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `manifest body is not valid JSON (${message})` };
  }
  return extractBuildSha(manifestJson);
}

async function fetchWithAssertionName(fetchImpl, assertionName, url, options = {}) {
  try {
    return await fetchImpl(url, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${assertionName}: fetch failed for ${url}: ${message}`);
  }
}

export async function waitForPropagation({
  expectedSha,
  origin,
  fetchImpl = globalThis.fetch,
  logger = console,
  sleepImpl = sleep,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  initialBackoffMs = INITIAL_BACKOFF_MS,
  maxBackoffMs = MAX_BACKOFF_MS,
  nowImpl = () => Date.now(),
  createProbeToken = randomProbeToken,
}) {
  const startedAtMs = nowImpl();
  let attemptNumber = 1;
  let backoffMs = initialBackoffMs;

  while (true) {
    const elapsedMs = nowImpl() - startedAtMs;
    if (elapsedMs >= timeoutMs) {
      throw new Error(
        `propagation assertion failed: timed out after ${timeoutMs}ms waiting for ${NGSW_JSON_PATH} appData.buildSha to equal ${expectedSha}.`,
      );
    }

    const probeUrl = buildUrl(origin, NGSW_JSON_PATH, {
      probe: createProbeToken(),
    });
    logger.log(`check-deploy-freshness: propagation attempt ${attemptNumber}: GET ${probeUrl}`);

    try {
      const response = await fetchWithAssertionName(
        fetchImpl,
        'propagation assertion failed',
        probeUrl,
      );
      if (response.status !== 200) {
        logger.log(
          `check-deploy-freshness: propagation attempt ${attemptNumber}: status ${response.status}, waiting for 200.`,
        );
      } else {
        const buildShaResult = await readManifestBuildSha(response);
        if (buildShaResult.ok && buildShaResult.buildSha === expectedSha) {
          logger.log(
            `check-deploy-freshness: propagation detected on attempt ${attemptNumber} for sha ${expectedSha}.`,
          );
          return;
        }
        const observedSha = buildShaResult.ok ? buildShaResult.buildSha : buildShaResult.reason;
        logger.log(
          `check-deploy-freshness: propagation attempt ${attemptNumber}: observed ${observedSha}; expected ${expectedSha}.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.log(
        `check-deploy-freshness: propagation attempt ${attemptNumber}: ${message}; retrying until timeout.`,
      );
    }

    const remainingMs = timeoutMs - (nowImpl() - startedAtMs);
    if (remainingMs <= 0) {
      throw new Error(
        `propagation assertion failed: timed out after ${timeoutMs}ms waiting for ${NGSW_JSON_PATH} appData.buildSha to equal ${expectedSha}.`,
      );
    }
    const delayMs = Math.min(backoffMs, remainingMs);
    logger.log(`check-deploy-freshness: waiting ${delayMs}ms before next propagation attempt.`);
    await sleepImpl(delayMs);
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    attemptNumber += 1;
  }
}

export async function assertNgswJsonNoStore({
  expectedSha,
  origin,
  fetchImpl = globalThis.fetch,
  logger = console,
  createProbeToken = randomProbeToken,
}) {
  const staleEtag = `"probe-${createProbeToken()}"`;
  const url = buildUrl(origin, NGSW_JSON_PATH);
  logger.log(
    `check-deploy-freshness: asserting ${NGSW_JSON_PATH} ignores stale If-None-Match and returns 200.`,
  );
  const response = await fetchWithAssertionName(
    fetchImpl,
    'ngsw.json no-store assertion failed',
    url,
    {
      headers: { 'If-None-Match': staleEtag },
    },
  );

  if (response.status === 304) {
    throw new Error(
      `${NGSW_JSON_PATH} no-store assertion failed: expected 200, got 304 for a stale If-None-Match header.`,
    );
  }
  if (response.status !== 200) {
    throw new Error(
      `${NGSW_JSON_PATH} no-store assertion failed: expected 200, got ${response.status}.`,
    );
  }

  const buildShaResult = await readManifestBuildSha(response);
  if (!buildShaResult.ok) {
    throw new Error(`${NGSW_JSON_PATH} no-store assertion failed: ${buildShaResult.reason}.`);
  }
  if (buildShaResult.buildSha !== expectedSha) {
    throw new Error(
      `${NGSW_JSON_PATH} no-store assertion failed: appData.buildSha was ${buildShaResult.buildSha}, expected ${expectedSha}.`,
    );
  }

  logger.log(`check-deploy-freshness: ${NGSW_JSON_PATH} no-store assertion passed.`);
}

export async function assertWorkerNoStore({
  origin,
  fetchImpl = globalThis.fetch,
  logger = console,
  createProbeToken = randomProbeToken,
}) {
  const staleEtag = `"probe-${createProbeToken()}"`;
  const url = buildUrl(origin, NGSW_WORKER_PATH);
  logger.log(
    `check-deploy-freshness: asserting ${NGSW_WORKER_PATH} ignores stale If-None-Match and returns 200.`,
  );
  const response = await fetchWithAssertionName(
    fetchImpl,
    'ngsw-worker.js no-store assertion failed',
    url,
    {
      headers: { 'If-None-Match': staleEtag },
    },
  );

  if (response.status === 304) {
    throw new Error(
      `${NGSW_WORKER_PATH} no-store assertion failed: expected 200, got 304 for a stale If-None-Match header.`,
    );
  }
  if (response.status !== 200) {
    throw new Error(
      `${NGSW_WORKER_PATH} no-store assertion failed: expected 200, got ${response.status}.`,
    );
  }

  logger.log(`check-deploy-freshness: ${NGSW_WORKER_PATH} no-store assertion passed.`);
}

export async function runDeployFreshnessCheck(options) {
  await waitForPropagation(options);
  await assertNgswJsonNoStore(options);
  await assertWorkerNoStore(options);
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseCliOptions(args, env);
  console.log(
    `check-deploy-freshness: expected sha source: ${options.expectedShaSource} (${options.expectedSha})`,
  );
  console.log(`check-deploy-freshness: origin source: ${options.originSource} (${options.origin})`);
  await runDeployFreshnessCheck(options);
  console.log('check-deploy-freshness: OK');
}

const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`check-deploy-freshness: ${message}`);
    process.exit(1);
  });
}
