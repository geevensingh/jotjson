#!/usr/bin/env node
// Substitutes Angular service-worker appData placeholders in the emitted
// ngsw.json manifest with the generated build metadata for this build.
//
// `ngsw-config.json` is checked in with placeholder tokens because the build
// SHA and build number are only known at build time. Angular CLI copies those
// tokens into `dist/jotjson/browser/ngsw.json`; this postbuild script replaces
// them in place before the artifact is considered complete.
//
// Runs with zero dependencies on Node 24+.

import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BUILD_SHA_TOKEN = '__BUILD_SHA__';
export const BUILD_NUMBER_TOKEN = '__BUILD_NUMBER__';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');

export const DEFAULT_NGSW_PATH = resolve(repositoryRoot, 'dist', 'jotjson', 'browser', 'ngsw.json');
export const DEFAULT_BUILD_INFO_PATH = resolve(repositoryRoot, 'src', 'generated', 'build-info.ts');

function fail(message) {
  throw new Error(`write-ngsw-appdata: ${message}`);
}

function readNonEmptyString(value, fieldName, buildInfoPath) {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  fail(`BUILD_INFO.${fieldName} in ${buildInfoPath} must be a non-empty string or finite number.`);
}

export function parseBuildInfo(buildInfoText, buildInfoPath = DEFAULT_BUILD_INFO_PATH) {
  const match = /export\s+const\s+BUILD_INFO(?:\s*:\s*BuildInfo)?\s*=\s*(\{[\s\S]*?\})\s*;/u.exec(
    buildInfoText,
  );
  if (match === null) {
    fail(`BUILD_INFO object not found in ${buildInfoPath}.`);
  }

  let buildInfo;
  try {
    buildInfo = JSON.parse(match[1]);
  } catch (error) {
    fail(`failed to parse BUILD_INFO object in ${buildInfoPath}: ${error?.message ?? error}`);
  }

  return {
    buildSha: readNonEmptyString(buildInfo.sha, 'sha', buildInfoPath),
    buildNumber: readNonEmptyString(buildInfo.buildNumber, 'buildNumber', buildInfoPath),
  };
}

async function readBuildInfo(buildInfoPath) {
  let buildInfoText;
  try {
    buildInfoText = await readFile(buildInfoPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail(`build info not found: ${buildInfoPath}. Run node scripts/write-build-info.mjs first.`);
    }
    fail(`failed to read build info ${buildInfoPath}: ${error?.message ?? error}`);
  }
  return parseBuildInfo(buildInfoText, buildInfoPath);
}

async function readNgswManifest(ngswPath) {
  try {
    return await readFile(ngswPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail(`ngsw manifest not found: ${ngswPath}. Run ng build first.`);
    }
    fail(`failed to read ngsw manifest ${ngswPath}: ${error?.message ?? error}`);
  }
}

function getPlaceholderState(manifestText, ngswPath) {
  const hasBuildShaPlaceholder = manifestText.includes(BUILD_SHA_TOKEN);
  const hasBuildNumberPlaceholder = manifestText.includes(BUILD_NUMBER_TOKEN);

  if (!hasBuildShaPlaceholder && !hasBuildNumberPlaceholder) {
    return 'absent';
  }

  if (hasBuildShaPlaceholder && hasBuildNumberPlaceholder) {
    return 'present';
  }

  fail(
    `${ngswPath} must contain both ${BUILD_SHA_TOKEN} and ${BUILD_NUMBER_TOKEN}, or neither ` +
      `(got ${BUILD_SHA_TOKEN}: ${hasBuildShaPlaceholder ? 'present' : 'absent'}, ` +
      `${BUILD_NUMBER_TOKEN}: ${hasBuildNumberPlaceholder ? 'present' : 'absent'}).`,
  );
}

function jsonStringTokenValue(value) {
  return JSON.stringify(value).slice(1, -1);
}

export function validateSubstitution(manifestText, buildInfo, ngswPath = DEFAULT_NGSW_PATH) {
  if (manifestText.includes(BUILD_SHA_TOKEN) || manifestText.includes(BUILD_NUMBER_TOKEN)) {
    fail(`placeholder token remains in ${ngswPath} after substitution.`);
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    fail(`substituted ${ngswPath} is not valid JSON: ${error?.message ?? error}`);
  }

  const appData = manifest?.appData;
  if (appData?.buildSha !== buildInfo.buildSha) {
    fail(
      `${ngswPath} appData.buildSha was not replaced with BUILD_INFO.sha ` +
        `(expected ${JSON.stringify(buildInfo.buildSha)}, got ${JSON.stringify(appData?.buildSha)}).`,
    );
  }
  if (appData?.buildNumber !== buildInfo.buildNumber) {
    fail(
      `${ngswPath} appData.buildNumber was not replaced with BUILD_INFO.buildNumber ` +
        `(expected ${JSON.stringify(buildInfo.buildNumber)}, got ${JSON.stringify(appData?.buildNumber)}).`,
    );
  }
}

export async function substituteNgswAppData({
  ngswPath = DEFAULT_NGSW_PATH,
  buildInfoPath = DEFAULT_BUILD_INFO_PATH,
  logger = console,
} = {}) {
  const manifestText = await readNgswManifest(ngswPath);
  const placeholderState = getPlaceholderState(manifestText, ngswPath);

  if (placeholderState === 'absent') {
    logger.log(
      `write-ngsw-appdata: no placeholders found in ${ngswPath}; assuming appData is already substituted.`,
    );
    return { status: 'unchanged' };
  }

  const buildInfo = await readBuildInfo(buildInfoPath);
  const updatedManifestText = manifestText
    .replaceAll(BUILD_SHA_TOKEN, jsonStringTokenValue(buildInfo.buildSha))
    .replaceAll(BUILD_NUMBER_TOKEN, jsonStringTokenValue(buildInfo.buildNumber));

  await writeFile(ngswPath, updatedManifestText, 'utf8');

  const verifiedManifestText = await readFile(ngswPath, 'utf8');
  validateSubstitution(verifiedManifestText, buildInfo, ngswPath);

  logger.log(
    `write-ngsw-appdata: substituted appData in ${ngswPath} ` +
      `(buildSha=${buildInfo.buildSha}, buildNumber=${buildInfo.buildNumber}).`,
  );
  return { status: 'substituted', ...buildInfo };
}

async function main() {
  try {
    await substituteNgswAppData();
  } catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  }
}

async function invokedDirectly() {
  try {
    if (!process.argv[1]) {
      return false;
    }
    return pathToFileURL(await realpath(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (await invokedDirectly()) {
  await main();
}
