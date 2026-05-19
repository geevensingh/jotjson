#!/usr/bin/env node
// scripts/check-deploy-freshness.mjs
//
// Post-deploy gate. Verifies the four invariants the SW migration
// (see plan.md, DESIGN_SPEC.md -> Versioning) depends on at the
// CDN edge:
//
//   1. GET /sw.js                -> 200, Cache-Control: no-store,
//                                    body contains the required
//                                    migration substrings.
//   2. GET /ngsw-worker.js       -> 200, byte-equal to /sw.js (the
//                                    permanent passthrough alias is
//                                    the URL the OLD ngsw cohort
//                                    revalidates against; drift here
//                                    breaks the stuck-user unstick
//                                    mechanism).
//   3. GET /ngsw.json            -> 200, body == "{}\n" (build-emitted
//                                    inert stub keeps the OLD ngsw's
//                                    periodic poll from entering
//                                    `unrecoverable`).
//   4. GET /index.html           -> Cache-Control:
//                                    "no-cache, must-revalidate".
//
// Propagation: SWA deploys propagate to the CDN over time. The
// script polls /sw.js with exponential backoff until the response
// body byte-matches the local dist/jotjson/browser/sw.js (the bytes
// the current build emitted). Once propagation is detected, the
// four assertions above run sequentially. Total budget is bounded
// by DEFAULT_TIMEOUT_MS.
//
// SCOPE: This probe verifies origin / edge state. It does NOT
// verify the user-visible "stuck SW unsticks on next visit"
// symptom -- that test requires a browser with a stale SW already
// controlling the origin, which neither this script nor Playwright
// can reproduce in a fresh context. See e2e/sw-migration.spec.ts
// for the user-symptom verification.

import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NGSW_JSON_STUB_URL, SW_CANONICAL_URL, SW_LEGACY_ALIAS_URLS } from './sw-urls.mjs';

const DEFAULT_ORIGIN = 'https://jotjson.com';
const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const INDEX_HTML_PATH = '/index.html';
const INDEX_HTML_CACHE_CONTROL = 'no-cache, must-revalidate';
const SW_CACHE_CONTROL = 'no-store';
const NGSW_JSON_EXPECTED_BODY = '{}\n';

// Mirrors the required-substring set in scripts/build-sw.mjs.
// Drift between the two would let a broken transpile pass the
// post-deploy gate; the SW shape lint (scripts/check-sw-shape.mjs)
// catches the inverse case at build time.
const REQUIRED_SW_SUBSTRINGS = Object.freeze([
  'skipWaiting',
  'caches.delete',
  'clients.claim',
  'jotjson-sw-migration',
  'legacyCacheWiped',
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const DEFAULT_LOCAL_SW = resolve(repoRoot, 'dist/jotjson/browser/sw.js');

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
      throw new Error(`Unknown argument '${args[index]}'. Valid options: --origin, --local-sw.`);
    }
  }
}

function normalizeOrigin(rawOrigin) {
  let parsedOrigin;
  try {
    parsedOrigin = new URL(rawOrigin);
  } catch {
    throw new Error(`Invalid origin '${rawOrigin}'. Expected an absolute https:// URL.`);
  }
  if (parsedOrigin.protocol !== 'https:') {
    throw new Error(`Invalid origin '${rawOrigin}'. Expected an https:// URL.`);
  }
  return parsedOrigin.origin;
}

export function parseCliOptions(args = process.argv.slice(2), env = process.env) {
  const originOption = readOptionWithOptionalValue(args, '--origin');
  const localSwOption = readOptionWithOptionalValue(args, '--local-sw');
  const consumedIndexes = new Set([
    ...originOption.consumedIndexes,
    ...localSwOption.consumedIndexes,
  ]);
  requireNoUnknownArgs(args, consumedIndexes);

  const cliOrigin = originOption.value?.trim() ?? '';
  const envOrigin = env.DEPLOY_ORIGIN?.trim() ?? '';
  const rawOrigin = cliOrigin || envOrigin || DEFAULT_ORIGIN;
  const originSource = cliOrigin ? '--origin' : envOrigin ? 'DEPLOY_ORIGIN' : 'default';

  const cliLocalSw = localSwOption.value?.trim() ?? '';
  const localSwPath = cliLocalSw ? resolve(cliLocalSw) : DEFAULT_LOCAL_SW;

  return {
    origin: normalizeOrigin(rawOrigin),
    originSource,
    localSwPath,
  };
}

function buildUrl(origin, pathname, searchParams = {}) {
  const url = new URL(pathname, origin);
  for (const [name, value] of Object.entries(searchParams)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

async function fetchWithAssertionName(fetchImpl, assertionName, url, options = {}) {
  try {
    return await fetchImpl(url, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${assertionName}: fetch failed for ${url}: ${message}`);
  }
}

export function readLocalSwBytes(localSwPath = DEFAULT_LOCAL_SW) {
  try {
    return readFileSync(localSwPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not read local SW from ${localSwPath}: ${message}. ` +
        `Run \`npm run build:prod\` (or the equivalent CI build step) first so ` +
        `dist/jotjson/browser/sw.js exists, or pass --local-sw=<path>.`,
    );
  }
}

function bytesEqual(left, right) {
  if (left.length !== right.length) return false;
  return Buffer.compare(left, right) === 0;
}

export async function waitForPropagation({
  origin,
  localSwBytes,
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
        `propagation assertion failed: timed out after ${timeoutMs}ms waiting for ` +
          `${SW_CANONICAL_URL} body to byte-match the locally built dist/jotjson/browser/sw.js.`,
      );
    }

    const probeUrl = buildUrl(origin, SW_CANONICAL_URL, {
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
          `check-deploy-freshness: propagation attempt ${attemptNumber}: ` +
            `status ${response.status}, waiting for 200.`,
        );
      } else {
        const remoteBytes = Buffer.from(await response.arrayBuffer());
        if (bytesEqual(remoteBytes, localSwBytes)) {
          logger.log(
            `check-deploy-freshness: propagation detected on attempt ${attemptNumber} ` +
              `(${remoteBytes.length} bytes match).`,
          );
          return;
        }
        logger.log(
          `check-deploy-freshness: propagation attempt ${attemptNumber}: ` +
            `served ${remoteBytes.length} bytes, expected ${localSwBytes.length}; not yet propagated.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.log(
        `check-deploy-freshness: propagation attempt ${attemptNumber}: ${message}; ` +
          `retrying until timeout.`,
      );
    }

    const remainingMs = timeoutMs - (nowImpl() - startedAtMs);
    if (remainingMs <= 0) {
      throw new Error(
        `propagation assertion failed: timed out after ${timeoutMs}ms waiting for ` +
          `${SW_CANONICAL_URL} body to byte-match the locally built dist/jotjson/browser/sw.js.`,
      );
    }
    const delayMs = Math.min(backoffMs, remainingMs);
    logger.log(`check-deploy-freshness: waiting ${delayMs}ms before next propagation attempt.`);
    await sleepImpl(delayMs);
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    attemptNumber += 1;
  }
}

export async function assertSwJs({ origin, fetchImpl = globalThis.fetch, logger = console }) {
  const url = buildUrl(origin, SW_CANONICAL_URL);
  logger.log(`check-deploy-freshness: GET ${url}`);
  const response = await fetchWithAssertionName(
    fetchImpl,
    `${SW_CANONICAL_URL} assertion failed`,
    url,
  );

  if (response.status !== 200) {
    throw new Error(`${SW_CANONICAL_URL} assertion failed: expected 200, got ${response.status}.`);
  }
  const cacheControl = response.headers.get('Cache-Control');
  if (cacheControl !== SW_CACHE_CONTROL) {
    throw new Error(
      `${SW_CANONICAL_URL} assertion failed: Cache-Control must be '${SW_CACHE_CONTROL}' ` +
        `(got: ${JSON.stringify(cacheControl)}). The SW gateway must not be cached or the ` +
        `24h byte-revalidation that delivers updates can be defeated by a CDN cache.`,
    );
  }
  const body = await response.text();
  for (const needle of REQUIRED_SW_SUBSTRINGS) {
    if (!body.includes(needle)) {
      throw new Error(
        `${SW_CANONICAL_URL} assertion failed: body is missing required substring '${needle}'. ` +
          `The post-deploy SW does not look like the minimal pass-through SW; ` +
          `migration mechanism would be broken.`,
      );
    }
  }
  logger.log(`check-deploy-freshness: ${SW_CANONICAL_URL} assertion passed.`);
  return Buffer.from(body, 'utf8');
}

export async function assertLegacyAlias({
  origin,
  legacyUrl,
  canonicalBytes,
  fetchImpl = globalThis.fetch,
  logger = console,
}) {
  const url = buildUrl(origin, legacyUrl);
  logger.log(`check-deploy-freshness: GET ${url}`);
  const response = await fetchWithAssertionName(fetchImpl, `${legacyUrl} assertion failed`, url);

  if (response.status !== 200) {
    throw new Error(`${legacyUrl} assertion failed: expected 200, got ${response.status}.`);
  }
  const remoteBytes = Buffer.from(await response.arrayBuffer());
  if (!bytesEqual(remoteBytes, canonicalBytes)) {
    throw new Error(
      `${legacyUrl} assertion failed: bytes differ from ${SW_CANONICAL_URL} ` +
        `(${remoteBytes.length} vs ${canonicalBytes.length}). The permanent passthrough alias ` +
        `MUST stay byte-identical to the canonical SW or the OLD ngsw cohort's ` +
        `byte-revalidation against the legacy URL would never see new bytes.`,
    );
  }
  logger.log(`check-deploy-freshness: ${legacyUrl} assertion passed.`);
}

export async function assertNgswJsonStub({
  origin,
  fetchImpl = globalThis.fetch,
  logger = console,
}) {
  const url = buildUrl(origin, NGSW_JSON_STUB_URL);
  logger.log(`check-deploy-freshness: GET ${url}`);
  const response = await fetchWithAssertionName(
    fetchImpl,
    `${NGSW_JSON_STUB_URL} assertion failed`,
    url,
  );

  if (response.status !== 200) {
    throw new Error(
      `${NGSW_JSON_STUB_URL} assertion failed: expected 200, got ${response.status}.`,
    );
  }
  const body = await response.text();
  if (body !== NGSW_JSON_EXPECTED_BODY) {
    throw new Error(
      `${NGSW_JSON_STUB_URL} assertion failed: body must be exactly ` +
        `${JSON.stringify(NGSW_JSON_EXPECTED_BODY)} (got ${JSON.stringify(body)}). ` +
        `The inert stub is what keeps the OLD ngsw's periodic poll from entering ` +
        `\`unrecoverable\` mid-migration.`,
    );
  }
  logger.log(`check-deploy-freshness: ${NGSW_JSON_STUB_URL} assertion passed.`);
}

export async function assertIndexHtmlCacheControl({
  origin,
  fetchImpl = globalThis.fetch,
  logger = console,
}) {
  const url = buildUrl(origin, INDEX_HTML_PATH);
  logger.log(`check-deploy-freshness: GET ${url}`);
  const response = await fetchWithAssertionName(
    fetchImpl,
    `${INDEX_HTML_PATH} assertion failed`,
    url,
  );

  if (response.status !== 200) {
    throw new Error(`${INDEX_HTML_PATH} assertion failed: expected 200, got ${response.status}.`);
  }
  const cacheControl = response.headers.get('Cache-Control');
  if (cacheControl !== INDEX_HTML_CACHE_CONTROL) {
    throw new Error(
      `${INDEX_HTML_PATH} assertion failed: Cache-Control must be ` +
        `'${INDEX_HTML_CACHE_CONTROL}' (got: ${JSON.stringify(cacheControl)}).`,
    );
  }
  logger.log(`check-deploy-freshness: ${INDEX_HTML_PATH} assertion passed.`);
}

export async function runDeployFreshnessCheck(options) {
  const localSwBytes = options.localSwBytes ?? readLocalSwBytes(options.localSwPath);
  await waitForPropagation({ ...options, localSwBytes });
  const canonicalBytes = await assertSwJs(options);
  for (const legacyUrl of SW_LEGACY_ALIAS_URLS) {
    await assertLegacyAlias({ ...options, legacyUrl, canonicalBytes });
  }
  await assertNgswJsonStub(options);
  await assertIndexHtmlCacheControl(options);
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseCliOptions(args, env);
  console.log(`check-deploy-freshness: origin source: ${options.originSource} (${options.origin})`);
  console.log(`check-deploy-freshness: local SW: ${options.localSwPath}`);
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
