#!/usr/bin/env node
// Prints the SHA-256 CSP hash of every distinct inline event-handler value
// found in the given HTML file (defaults to the production home page). Used
// to verify the documented `'sha256-...'` literal in
// `staticwebapp.config.json` matches the actually-served bytes.
//
// Reads from the served file rather than a hardcoded JS string so the
// reproduction step matches what browsers compute - including the HTML-entity
// decoding browsers apply during attribute parsing.
//
// Usage:
//   node scripts/print-csp-hash.mjs                                      # default: dist/jotjson/browser/index.html
//   node scripts/print-csp-hash.mjs dist/jotjson/browser/shell.html      # any HTML file
//
// Output: one line per distinct decoded handler value, formatted as:
//   "<decoded-value>"  ->  'sha256-<base64>'

import { existsSync, readFileSync } from 'node:fs';
import { extractInlineEventHandlers, sha256Token } from './check-csp-hashes.mjs';

const targetPath = process.argv[2] ?? 'dist/jotjson/browser/index.html';

if (!existsSync(targetPath)) {
  console.error(`print-csp-hash: ${targetPath} does not exist.`);
  if (targetPath.startsWith('dist/')) {
    console.error('Run `npm run build` first.');
  }
  process.exit(2);
}

const html = readFileSync(targetPath, 'utf8');
const handlers = extractInlineEventHandlers(html);

if (handlers.length === 0) {
  console.error(`print-csp-hash: no inline event handlers found in ${targetPath}.`);
  process.exit(2);
}

const seen = new Set();
for (const value of handlers) {
  if (seen.has(value)) continue;
  seen.add(value);
  const hash = sha256Token(value);
  console.log(`${JSON.stringify(value)}  ->  ${hash}`);
}
