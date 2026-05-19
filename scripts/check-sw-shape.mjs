#!/usr/bin/env node
// scripts/check-sw-shape.mjs
//
// Lint gate that asserts:
//   1. The source SW (src/sw.worker.ts) hashes to a known SHA-256.
//      Mechanical forcing function: any edit to the SW source forces
//      a human to update the hash in this script, which makes the diff
//      visible in review.
//   2. (Only if dist/ exists) Build outputs contain the required
//      runtime substrings (post-transpile; comments may be stripped
//      but the load-bearing identifiers survive any reasonable
//      minification.)
//   3. (Only if dist/ exists) sw.js and every legacy alias are
//      byte-identical to each other and dist/jotjson/browser/ngsw.json
//      is the inert `{}\n` stub.
//
// Source hash check runs unconditionally so the lint:all chain gates
// on it even before the production build has run.
//
// See docs/sw-migration.md and DESIGN_SPEC.md PWA section.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NGSW_JSON_STUB_URL, SW_ALL_URLS, SW_CANONICAL_URL } from './sw-urls.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const distRoot = resolve(repoRoot, 'dist/jotjson/browser');

const SW_SOURCE = resolve(repoRoot, 'src/sw.worker.ts');
const EXPECTED_SW_SOURCE_SHA256 =
  '55658452dbed6641104795903decdfe8b0b2694a37fb36fa84171cc1af382135';

const REQUIRED_RUNTIME_SUBSTRINGS = [
  'skipWaiting',
  'caches.delete',
  'clients.claim',
  'jotjson-sw-migration',
  'legacyCacheWiped',
];

const NGSW_JSON_STUB_BODY = '{}\n';

function urlToDistPath(url) {
  return resolve(distRoot, url.slice(1));
}

function fail(message) {
  process.stderr.write(`check-sw-shape: ${message}\n`);
  return 1;
}

export function checkSourceHash() {
  const sourceBytes = readFileSync(SW_SOURCE);
  // Normalize before hashing so the gate is stable across:
  //   - .gitattributes `* text=auto` + core.autocrlf on Windows (CRLF
  //     in working tree, LF in the git index; Linux/Mac/CI see LF).
  //   - Editors that prepend a UTF-8 BOM (e.g., VSCode with
  //     `files.encoding: utf8bom`).
  //   - Legacy editors that save lone CR (older Mac tooling).
  // The expected hash is the LF, BOM-less form.
  const normalized = sourceBytes
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  const actualSha = createHash('sha256').update(normalized, 'utf8').digest('hex');
  if (actualSha !== EXPECTED_SW_SOURCE_SHA256) {
    return fail(
      `src/sw.worker.ts has changed. Expected SHA-256 ${EXPECTED_SW_SOURCE_SHA256}, got ${actualSha}.\n` +
        '  This file is the canonical service worker; edits to it can brick every user.\n' +
        `  If the edit is intentional, update EXPECTED_SW_SOURCE_SHA256 in scripts/check-sw-shape.mjs\n` +
        `  to ${actualSha} (and review the diff carefully).`,
    );
  }
  return 0;
}

export function checkBuildOutputs() {
  const canonicalPath = urlToDistPath(SW_CANONICAL_URL);
  if (!existsSync(canonicalPath)) {
    process.stdout.write(
      `check-sw-shape: skipping build-output checks (${canonicalPath} not present; run \`npm run build\` first).\n`,
    );
    return 0;
  }
  let exitCode = 0;
  const canonicalBytes = readFileSync(canonicalPath);
  const canonicalText = canonicalBytes.toString('utf8');
  for (const needle of REQUIRED_RUNTIME_SUBSTRINGS) {
    if (!canonicalText.includes(needle)) {
      exitCode |= fail(`build output ${canonicalPath} is missing substring: ${needle}`);
    }
  }
  for (const url of SW_ALL_URLS) {
    const path = urlToDistPath(url);
    if (!existsSync(path)) {
      exitCode |= fail(`expected build output missing: ${path}`);
      continue;
    }
    const bytes = readFileSync(path);
    if (!bytes.equals(canonicalBytes)) {
      exitCode |= fail(`${path} is not byte-identical to ${canonicalPath}`);
    }
  }
  const ngswJsonPath = urlToDistPath(NGSW_JSON_STUB_URL);
  if (!existsSync(ngswJsonPath)) {
    exitCode |= fail(`expected build output missing: ${ngswJsonPath}`);
  } else {
    const body = readFileSync(ngswJsonPath, 'utf8');
    if (body !== NGSW_JSON_STUB_BODY) {
      exitCode |= fail(`${ngswJsonPath} body should be exactly '{}\\n' (got ${body.length} bytes)`);
    }
  }
  return exitCode;
}

export function main() {
  let exitCode = 0;
  exitCode |= checkSourceHash();
  exitCode |= checkBuildOutputs();
  if (exitCode === 0) {
    process.stdout.write('check-sw-shape: OK\n');
  }
  return exitCode;
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
  process.exit(main());
}
