#!/usr/bin/env node
// Prerender content sanity check.
//
// Verifies that `npm run build` produces the M7h-expected layout under
// dist/jotjson/browser/:
//   - index.html       (prerendered '/')
//   - 404/index.html   (prerendered '/404')
//   - shell.html       (SPA shell for navigationFallback)
//
// And that:
//   - index.html has the prerender marker, the OG defaults, and the
//     home server-skeleton text crawlers should see.
//   - 404/index.html has noindex.
//   - shell.html does NOT have the prerender marker.
//   - public/robots.txt and public/sitemap.xml landed in the bundle.
//
// Runs with zero dependencies on Node 24+. Hooked into CI via
// `npm run check:prerender`.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const browserDirectory = resolve(repositoryRoot, 'dist', 'jotjson', 'browser');

const failures = [];

function check(label, condition) {
  if (!condition) {
    failures.push(label);
  }
}

function readOrFail(relativePath) {
  const path = resolve(browserDirectory, relativePath);
  if (!existsSync(path)) {
    failures.push(`missing: ${relativePath}`);
    return '';
  }
  return readFileSync(path, 'utf8');
}

if (!existsSync(browserDirectory)) {
  console.error(
    `check-prerender: browser output not found at ${browserDirectory} - run \`npm run build\` first.`,
  );
  process.exit(1);
}

const indexHtml = readOrFail('index.html');
const notFoundHtml = readOrFail('404/index.html');
const shellHtml = readOrFail('shell.html');
const robotsTxt = readOrFail('robots.txt');
const sitemapXml = readOrFail('sitemap.xml');
const ogPng = resolve(browserDirectory, 'og.png');
const buildInfoJsonText = readOrFail('build-info.json');

const PRERENDER_MARKER = '<meta name="prerendered" content="true">';

// --- build-info.json: postbuild-emit regression test.
// Issue #336 -- /build-info.json is the per-deploy SHA marker that the
// freshness gate's lockstep poll relies on. A regression that quietly
// stops emitting it (e.g., postbuild step accidentally removed or moved
// before `ng build`) would let the gate fail at the CDN edge instead
// of here at build time.
check(
  'build-info.json missing or invalid JSON',
  (() => {
    if (!buildInfoJsonText) return false;
    try {
      const parsed = JSON.parse(buildInfoJsonText);
      return typeof parsed?.sha === 'string' && parsed.sha.length > 0;
    } catch {
      return false;
    }
  })(),
);

// --- Prerender marker: present in / and /404, absent in shell.
check('index.html missing prerender marker', indexHtml.includes(PRERENDER_MARKER));
check('404/index.html missing prerender marker', notFoundHtml.includes(PRERENDER_MARKER));
check(
  'shell.html unexpectedly has prerender marker (would suppress splash on shell-fallback boots)',
  !shellHtml.includes(PRERENDER_MARKER),
);

// --- index.html: server-skeleton, brand, tagline, OG defaults.
check(
  'index.html missing brand mark <h1>JotJSON</h1>',
  /<h1[^>]*>\s*JotJSON\s*<\/h1>/i.test(indexHtml),
);
check(
  'index.html missing tagline copy',
  indexHtml.includes('JSON viewer, formatter, and tree explorer'),
);
check(
  'index.html missing description copy (server skeleton)',
  indexHtml.includes('Paste, format, validate, and share JSON or JSONC'),
);
check('index.html missing og:title', /<meta\s+property="og:title"/i.test(indexHtml));
check(
  'index.html missing og:image',
  /<meta\s+property="og:image"\s+content="https:\/\/jotjson\.com\/og\.png"/i.test(indexHtml),
);
check(
  'index.html missing twitter:card summary_large_image',
  /<meta\s+name="twitter:card"\s+content="summary_large_image"/i.test(indexHtml),
);
check(
  'index.html missing canonical',
  /<link\s+rel="canonical"\s+href="https:\/\/jotjson\.com\/"/i.test(indexHtml),
);

// --- 404/index.html: noindex + the not-found component.
check('404/index.html missing app-not-found render', /<app-not-found/i.test(notFoundHtml));
check(
  '404/index.html missing noindex meta',
  /<meta\s+name="robots"\s+content=("noindex|noindex)[^>]*>/i.test(notFoundHtml),
);

// --- shell.html: static splash present (boot animation for dynamic
// routes) but no prerendered home content.
check('shell.html missing static jot-splash markup', shellHtml.includes('jot-splash'));
check('shell.html unexpectedly has prerendered <app-home> body', !/<app-home/i.test(shellHtml));

// --- Static SEO assets.
check('robots.txt missing User-agent rule', /User-agent:\s*\*/i.test(robotsTxt));
check(
  'robots.txt missing sitemap reference',
  /Sitemap:\s*https:\/\/jotjson\.com\/sitemap\.xml/i.test(robotsTxt),
);
check('sitemap.xml missing root URL', sitemapXml.includes('https://jotjson.com/'));
check('og.png not deployed to dist', existsSync(ogPng));

if (failures.length > 0) {
  console.error('check-prerender: FAILED');
  for (const message of failures) {
    console.error(`  - ${message}`);
  }
  process.exit(1);
}

console.log(
  'check-prerender: OK (index.html / 404/index.html / shell.html / robots.txt / sitemap.xml / og.png / build-info.json).',
);
