#!/usr/bin/env node
// scripts/build-sw.mjs
//
// Transpiles src/sw.worker.ts to a top-level (module: None) script and
// writes it to:
//   - dist/jotjson/browser/sw.js               (canonical URL)
//   - dist/jotjson/browser/ngsw-worker.js      (permanent passthrough alias;
//                                               byte-identical to sw.js so the
//                                               pre-migration ngsw cohort
//                                               unsticks via its periodic
//                                               byte-revalidation against the
//                                               URL it was originally
//                                               registered at)
//
// Also writes a `{}` stub at:
//   - dist/jotjson/browser/ngsw.json           (so the pre-migration ngsw
//                                               concludes "no new version" on
//                                               its periodic poll instead of
//                                               entering `unrecoverable`)
//
// Replaces the legacy `scripts/write-ngsw-appdata.mjs` postbuild step.
//
// See plan.md (in the SW migration PR) §2b for the verification chain:
//   (1) shape-check the emit (required substrings),
//   (2) node --check the canonical output,
//   (3) read BOTH output files independently from disk and assert byte
//       equality (skeptic v3 #7: this catches a future postbuild step
//       that rewrites one file but not the other; in-memory equality
//       would not).

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import { NGSW_JSON_STUB_URL, SW_CANONICAL_URL, SW_LEGACY_ALIAS_URLS } from './sw-urls.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const distRoot = resolve(repoRoot, 'dist/jotjson/browser');

const SOURCE = resolve(repoRoot, 'src/sw.worker.ts');
const NGSW_JSON_STUB_BODY = '{}\n';

const REQUIRED_SUBSTRINGS = [
  'skipWaiting',
  'caches.delete',
  'clients.claim',
  'jotjson-sw-migration',
  'legacyCacheWiped',
];

function urlToDistPath(url) {
  if (!url.startsWith('/')) {
    fail(`expected URL to start with '/': ${url}`);
  }
  return resolve(distRoot, url.slice(1));
}

export function fail(message) {
  process.stderr.write(`build-sw: ${message}\n`);
  process.exit(1);
}

export function buildSwSource(tsSource) {
  const result = ts.transpileModule(tsSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      lib: ['ES2022', 'WebWorker'],
      module: ts.ModuleKind.None,
      strict: true,
      removeComments: false,
    },
    reportDiagnostics: true,
  });
  if (result.diagnostics && result.diagnostics.length > 0) {
    fail(
      `TypeScript diagnostics:\n${result.diagnostics
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
        .join('\n')}`,
    );
  }
  return result.outputText;
}

export function assertShape(emit) {
  for (const needle of REQUIRED_SUBSTRINGS) {
    if (!emit.includes(needle)) {
      fail(`emit is missing required substring: ${needle}`);
    }
  }
}

export function main() {
  const tsSource = readFileSync(SOURCE, 'utf8');
  const emit = buildSwSource(tsSource);
  assertShape(emit);

  mkdirSync(distRoot, { recursive: true });

  const canonicalPath = urlToDistPath(SW_CANONICAL_URL);
  const legacyPaths = SW_LEGACY_ALIAS_URLS.map(urlToDistPath);
  const ngswJsonPath = urlToDistPath(NGSW_JSON_STUB_URL);

  writeFileSync(canonicalPath, emit);
  for (const legacyPath of legacyPaths) {
    writeFileSync(legacyPath, emit);
  }
  writeFileSync(ngswJsonPath, NGSW_JSON_STUB_BODY);

  execSync(`node --check "${canonicalPath}"`, { stdio: 'inherit' });

  const bytesCanonical = readFileSync(canonicalPath);
  for (const legacyPath of legacyPaths) {
    const bytesLegacy = readFileSync(legacyPath);
    if (!bytesCanonical.equals(bytesLegacy)) {
      fail(`canonical (${canonicalPath}) and legacy (${legacyPath}) SW bytes differ on disk`);
    }
  }

  const hashCanonical = createHash('sha256').update(bytesCanonical).digest('hex');
  process.stdout.write(
    `build-sw: wrote ${canonicalPath} + ${legacyPaths.length} legacy aliases + ${ngswJsonPath} (sha256=${hashCanonical})\n`,
  );
}

const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main();
}
