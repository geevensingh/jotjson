#!/usr/bin/env node
// Spec-pattern lint: rejects known-fragile testing patterns in *.spec.ts.
//
// Why this exists:
//   `spyOnProperty(navigator, 'clipboard', 'get')` requires
//   `navigator.clipboard` to already exist as an accessor property. Linux
//   headless Chrome (the CI runner) exposes it as a data property (or omits
//   it entirely outside a secure context), so the spy throws
//   "Property clipboard does not have access type get" and crashes the test.
//   Windows headless Chrome happens to expose a getter, so locally green and
//   CI red. We have already paid for this once (see the M4b clipboard fix
//   that introduced this script). The rest of the codebase uses
//   `Object.defineProperty(navigator, 'clipboard', { configurable: true,
//   get: () => ... })` in beforeEach + restore in afterEach, which works
//   on every platform.
//
// Adding new rules:
//   Push a `{ pattern, message }` onto RULES. `pattern` is a RegExp (use
//   `/.../` literal so flags are explicit). Keep messages actionable -
//   point at the approved alternative.
//
// Runs with zero dependencies on Node 24+. Invoke directly or via
//   npm run check:spec-patterns

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const RULES = [
  {
    pattern: /\bspyOnProperty\s*\(\s*navigator\s*,\s*['"]clipboard['"]/g,
    message:
      "Use Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => ... })" +
      ' with a beforeEach/afterEach pair that captures and restores the' +
      ' original descriptor. spyOnProperty requires an accessor property,' +
      ' which Linux headless Chrome does not expose for navigator.clipboard.',
  },
];

function listSpecFiles() {
  // Match check-ascii.mjs: include both tracked and untracked-but-not-ignored
  // files so a fresh local file is scanned BEFORE it is staged.
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'buffer' },
  );
  return out
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((p) => p.endsWith('.spec.ts'));
}

function scan(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const violations = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let m;
    while ((m = rule.pattern.exec(text)) !== null) {
      const upToMatch = text.slice(0, m.index);
      const line = upToMatch.split('\n').length;
      const lastNl = upToMatch.lastIndexOf('\n');
      const col = m.index - (lastNl + 1) + 1;
      violations.push({ path, line, col, message: rule.message, snippet: m[0] });
    }
  }
  return violations;
}

const files = listSpecFiles();
const allViolations = files.flatMap(scan);

if (allViolations.length === 0) {
  console.log(`check-spec-patterns: OK (${files.length} spec files scanned, 0 violations)`);
  process.exit(0);
}

console.error('check-spec-patterns: violations found:');
for (const v of allViolations) {
  console.error(`  ${v.path}:${v.line}:${v.col}  ${v.snippet}`);
  console.error(`    -> ${v.message}`);
}
console.error(`\n${allViolations.length} violation(s) in ${files.length} spec files.`);
process.exit(1);
