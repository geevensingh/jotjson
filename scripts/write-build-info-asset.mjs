#!/usr/bin/env node
// scripts/write-build-info-asset.mjs
//
// POSTBUILD: writes `dist/jotjson/browser/build-info.json` by
// reading back the `BUILD_INFO` payload that
// `scripts/write-build-info.mjs` wrote to
// `src/generated/build-info.ts` at prebuild time. Reading back from
// the TS file (rather than recomputing the payload) is the key
// invariant: the SPA bundle imports `BUILD_INFO` from that file at
// build time, so the deployed bundle's `BUILD_INFO` constant and
// the publicly-fetchable `/build-info.json` carry BYTEWISE-
// IDENTICAL payload (including `builtAt`, which would otherwise
// drift between two `new Date()` calls).
//
// The freshness gate (`scripts/check-deploy-freshness.mjs`) polls
// `/build-info.json` and asserts `body.sha === expectedSha` where
// expectedSha is `${{ workflow_run.head_sha || github.sha }}` --
// the same expression that sets `JOTJSON_BUILD_SHA` in the CD
// workflows, which `write-build-info.mjs` reads. So:
//
//   bundle BUILD_INFO.sha == deployed build-info.json.sha == asserted SHA
//
// Runs from the npm `postbuild` / `postbuild:prod` lifecycle hooks.
// Fails loud if `dist/jotjson/browser/` is missing (signals a
// postbuild ordering bug -- this script must run after `ng build`)
// or if `src/generated/build-info.ts` is missing (signals that
// `scripts/write-build-info.mjs` was not run, e.g. someone called
// `ng build` directly bypassing the `prebuild` hook).

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');

export const BUILD_INFO_TS_PATH = resolve(repositoryRoot, 'src', 'generated', 'build-info.ts');
export const BROWSER_DIRECTORY = resolve(repositoryRoot, 'dist', 'jotjson', 'browser');
export const BUILD_INFO_JSON_PATH = resolve(BROWSER_DIRECTORY, 'build-info.json');

const REQUIRED_PAYLOAD_FIELDS = Object.freeze([
  'version',
  'sha',
  'branch',
  'builtAt',
  'repoUrl',
  'buildNumber',
]);

// Matches `export const BUILD_INFO: BuildInfo = { ... };` -- the
// exact form `scripts/write-build-info.mjs` emits via
// `JSON.stringify(payload, null, 2)`. We use a greedy capture anchored
// to the trailing `};` so embedded `}` inside string values (e.g., a
// branch name containing braces) do not terminate the match early.
// This is safe because the generated file contains exactly one
// `export const BUILD_INFO` statement.
const BUILD_INFO_LITERAL_REGEX =
  /export\s+const\s+BUILD_INFO\s*:\s*BuildInfo\s*=\s*(\{[\s\S]*\})\s*;/;

export function extractBuildInfoPayload(tsSource) {
  if (typeof tsSource !== 'string') {
    throw new Error('extractBuildInfoPayload: tsSource must be a string');
  }
  const match = BUILD_INFO_LITERAL_REGEX.exec(tsSource);
  if (match === null) {
    throw new Error(
      'write-build-info-asset: could not locate the BUILD_INFO literal in build-info.ts. ' +
        'scripts/write-build-info.mjs may have changed format -- both scripts must stay in sync.',
    );
  }
  let payload;
  try {
    payload = JSON.parse(match[1]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `write-build-info-asset: BUILD_INFO literal is not valid JSON: ${message}. ` +
        'scripts/write-build-info.mjs and this script must stay in sync.',
    );
  }
  for (const field of REQUIRED_PAYLOAD_FIELDS) {
    if (typeof payload[field] !== 'string') {
      throw new Error(
        `write-build-info-asset: BUILD_INFO.${field} must be a string ` +
          `(got: ${JSON.stringify(payload[field])}). Build is broken; ` +
          `scripts/write-build-info.mjs and this script must stay in sync.`,
      );
    }
  }
  return payload;
}

export function writeBuildInfoAsset({
  tsPath = BUILD_INFO_TS_PATH,
  browserDirectory = BROWSER_DIRECTORY,
  jsonPath = BUILD_INFO_JSON_PATH,
  logger = console,
} = {}) {
  if (!existsSync(tsPath)) {
    throw new Error(
      `write-build-info-asset: ${tsPath} does not exist. ` +
        'Run scripts/write-build-info.mjs first (it is the prebuild hook).',
    );
  }
  if (!existsSync(browserDirectory)) {
    throw new Error(
      `write-build-info-asset: ${browserDirectory} does not exist. ` +
        'This script must run as a postbuild hook after `ng build` has populated dist/.',
    );
  }

  const tsSource = readFileSync(tsPath, 'utf8');
  const payload = extractBuildInfoPayload(tsSource);

  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + '\n');
  logger.log(
    `write-build-info-asset: wrote ${jsonPath} ` +
      `(sha=${payload.sha}, buildNumber=${payload.buildNumber}).`,
  );
  return payload;
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
  try {
    writeBuildInfoAsset();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}
