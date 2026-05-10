#!/usr/bin/env node
// SEO postbuild: emits shell.html for SWA's navigationFallback and
// injects a <meta name="prerendered"> marker into prerendered HTML.
//
// Inputs (produced by `ng build` with outputMode: 'static'):
//   dist/jotjson/browser/index.html       <- prerendered '/'
//   dist/jotjson/browser/404/index.html   <- prerendered '/404'
//   dist/jotjson/browser/index.csr.html   <- empty SPA shell (CSR)
//
// Outputs (in-place plus a rename):
//   dist/jotjson/browser/shell.html       <- renamed from index.csr.html
//   dist/jotjson/browser/index.html       <- with marker injected
//   dist/jotjson/browser/404/index.html   <- with marker injected
//
// The marker lets `LoadingSplashService` discriminate prerendered-route
// boots (start at kind=null, no Angular splash flicker over the
// prerendered content) from shell-fallback boots (start at kind='jotjson',
// show the splash exactly as today).
//
// Runs with zero dependencies on Node 24+.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const browserDirectory = resolve(repositoryRoot, 'dist', 'jotjson', 'browser');

const PRERENDER_MARKER = '<meta name="prerendered" content="true">';

function fail(message) {
  console.error(`postbuild-seo: ${message}`);
  process.exit(1);
}

function injectMarker(htmlPath) {
  if (!existsSync(htmlPath)) {
    fail(`expected prerendered HTML missing: ${htmlPath}`);
  }
  const html = readFileSync(htmlPath, 'utf8');
  if (html.includes(PRERENDER_MARKER)) {
    return;
  }
  // Insert immediately after <head> so the marker is parseable as soon
  // as the browser hits `<app-loading-splash>`. We don't depend on
  // `<head>` being the first byte; allow whitespace/attrs.
  const headOpenMatch = html.match(/<head[^>]*>/i);
  if (!headOpenMatch) {
    fail(`<head> not found in ${htmlPath}`);
  }
  const insertAt = headOpenMatch.index + headOpenMatch[0].length;
  const updated = html.slice(0, insertAt) + PRERENDER_MARKER + html.slice(insertAt);
  writeFileSync(htmlPath, updated);
}

function emitShellFromCsr() {
  const csrPath = resolve(browserDirectory, 'index.csr.html');
  const shellPath = resolve(browserDirectory, 'shell.html');
  if (!existsSync(csrPath)) {
    fail(`expected ${csrPath} produced by ng build (RenderMode.Client)`);
  }
  // Rename so SWA's navigationFallback picks up the canonical name.
  // Use rename (not copy) to keep the dist folder tight; ng build
  // re-emits index.csr.html on every build so there's nothing to
  // preserve.
  if (existsSync(shellPath)) {
    fail(`unexpected pre-existing ${shellPath}`);
  }
  renameSync(csrPath, shellPath);
}

if (!existsSync(browserDirectory)) {
  fail(`browser output not found: ${browserDirectory}`);
}

emitShellFromCsr();
injectMarker(resolve(browserDirectory, 'index.html'));
injectMarker(resolve(browserDirectory, '404', 'index.html'));

console.log('postbuild-seo: shell.html emitted; prerender marker injected into / and /404');
