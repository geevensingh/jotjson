#!/usr/bin/env node
// Scans every git-tracked text file for non-ASCII codepoints that are not on
// the allowlist. Exits non-zero with a file:line:col report when any are
// found, so CI keeps us honest about the normalizations landed in 328b054
// and c7c5667.
//
// Adjusting the allowlist:
//   Add a codepoint below only when a keep-as-is decision is made (typically
//   because the ASCII substitute degrades UX or legibility). Keep the
//   human-readable name next to it so future readers understand why.
//
// Runs with zero dependencies on Node 24+. Invoke directly or via
//   npm run check:ascii

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Allowlist of intentionally-kept non-ASCII codepoints. Everything else is
// flagged. Stored as numbers to keep this source file 100% ASCII.
const ALLOWED = new Set([
  0x00a7, // SECTION SIGN - cross-references in docs (e.g., `DESIGN_SPEC.md #Auth`)
  0x00b7, // MIDDLE DOT - tree spacer column in json-tree.component.html
  0x2500, // BOX DRAWINGS LIGHT HORIZONTAL  - DESIGN_SPEC diagrams
  0x2502, // BOX DRAWINGS LIGHT VERTICAL    - DESIGN_SPEC diagrams
  0x251c, // BOX DRAWINGS LIGHT VERTICAL AND RIGHT
  0x2514, // BOX DRAWINGS LIGHT UP AND RIGHT
  0x25b6, // BLACK RIGHT-POINTING TRIANGLE  - arrowheads in DESIGN_SPEC diagrams
  0x25bc  // BLACK DOWN-POINTING TRIANGLE
]);

// File types to skip entirely. These are binaries shipped with the repo whose
// bytes are not meaningful as UTF-8 text.
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.woff', '.woff2']);

function listTrackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'buffer' });
  // -z emits NUL-terminated paths to survive unusual filenames.
  return out
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function isBinaryPath(path) {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return BINARY_EXT.has(path.slice(dot).toLowerCase());
}

function looksBinary(buf) {
  // Heuristic: any NUL byte in the first 8KB implies binary.
  return buf.slice(0, 8192).includes(0);
}

function scan(path) {
  if (isBinaryPath(path)) return [];
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    return [];
  }
  if (looksBinary(buf)) return [];
  const text = buf.toString('utf8');
  const violations = [];
  let line = 1;
  let col = 1;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x80 && !ALLOWED.has(cp)) {
      violations.push({
        path,
        line,
        col,
        cp,
        char: ch
      });
    }
    if (ch === '\n') {
      line += 1;
      col = 1;
    } else {
      // codePointAt counted a whole codepoint; advance column by one visible slot.
      col += 1;
    }
  }
  return violations;
}

function formatCodepoint(cp) {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

function main() {
  const files = listTrackedFiles();
  const allViolations = [];
  for (const f of files) {
    allViolations.push(...scan(f));
  }
  if (allViolations.length === 0) {
    console.log(`check-ascii: OK (${files.length} tracked files scanned, 0 violations)`);
    return;
  }
  console.error(`check-ascii: ${allViolations.length} disallowed non-ASCII codepoint(s) found:`);
  console.error('');
  for (const v of allViolations) {
    console.error(`  ${v.path}:${v.line}:${v.col}  ${formatCodepoint(v.cp)}  ${JSON.stringify(v.char)}`);
  }
  console.error('');
  console.error('If a codepoint is genuinely needed, add it (with a comment) to the ALLOWED');
  console.error('set in scripts/check-ascii.mjs and re-run.');
  process.exit(1);
}

main();
