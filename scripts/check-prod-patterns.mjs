#!/usr/bin/env node
// Production-source pattern lint: rejects known-fragile patterns in
// production .ts files (frontend `src/` and `api/src/`), excluding test
// files and test helpers.
//
// Why this exists (separate from check-spec-patterns.mjs):
//   `check-spec-patterns.mjs` scans `*.spec.ts` for fragile testing
//   patterns. This script scans the rest of the production source for
//   patterns that defeat type-safety guarantees we want to keep.
//
// Current rules:
//   1. `as TelemetryMessageId`
//      The TelemetryMessageId literal-union catalog
//      (`src/app/core/telemetry/telemetry-message-ids.ts`) only protects
//      us if every emitter uses a token from the catalog. A cast like
//      `'foo.bar' as TelemetryMessageId` silently smuggles an
//      uncatalogued id into the wire format. Add the new token to
//      `TELEMETRY_MESSAGE_IDS` instead.
//
// File scope:
//   - frontend production: `src/**/*.ts`
//   - backend production:  `api/src/**/*.ts`
// Exclusions:
//   - any `*.spec.ts` (Karma frontend specs)
//   - any `*.test.ts` (Jest backend tests)
//   - any path containing `/testing/` or ending in `.testing.ts`
//
// Adding new rules:
//   Push a `{ pattern, message }` onto RULES. `pattern` is a RegExp (use
//   `/.../g` so the scanner can iterate matches). Keep messages
//   actionable - point at the approved alternative.
//
// Runs with zero dependencies on Node 24+. Invoke directly or via
//   npm run check:prod-patterns

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const RULES = [
  {
    pattern: /\bas\s+TelemetryMessageId\b/g,
    message:
      "Cast 'as TelemetryMessageId' defeats the literal-union catalog." +
      ' Add the new id to TELEMETRY_MESSAGE_IDS in' +
      ' src/app/core/telemetry/telemetry-message-ids.ts (with JSDoc)' +
      ' instead of casting at the call site.',
  },
];

function listProdFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'buffer' },
  );
  const all = out.toString('utf8').split('\0').filter(Boolean);
  return all
    .filter((p) => p.endsWith('.ts'))
    .filter((p) => p.startsWith('src/') || p.startsWith('api/src/'))
    .filter((p) => !p.endsWith('.spec.ts') && !p.endsWith('.test.ts'))
    .filter((p) => !p.includes('/testing/') && !p.endsWith('.testing.ts'));
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
      const lastNl = upToMatch.lastIndexOf('\n');
      const line = upToMatch.split('\n').length;
      const col = m.index - (lastNl + 1) + 1;
      // Skip matches inside line comments (`// ...`) or JSDoc /
      // block-comment lines (a line whose non-whitespace prefix
      // before the match starts with `*` or `//`). This lets
      // documentation reference the banned pattern without tripping
      // the lint. We do not parse multi-line `/* ... */` blocks
      // exhaustively - the `*` prefix on each continuation line in
      // our codebase covers the JSDoc case.
      const lineSoFar = text.slice(lastNl + 1, m.index);
      if (/^\s*(\*|\/\/)/.test(lineSoFar)) {
        continue;
      }
      if (lineSoFar.includes('//')) {
        continue;
      }
      violations.push({ path, line, col, message: rule.message, snippet: m[0] });
    }
  }
  return violations;
}

const files = listProdFiles();
const allViolations = files.flatMap(scan);

if (allViolations.length === 0) {
  console.log(
    `check-prod-patterns: OK (${files.length} production .ts files scanned, 0 violations)`,
  );
  process.exit(0);
}

console.error('check-prod-patterns: violations found:');
for (const v of allViolations) {
  console.error(`  ${v.path}:${v.line}:${v.col}  ${v.snippet}`);
  console.error(`    -> ${v.message}`);
}
console.error(`\n${allViolations.length} violation(s) in ${files.length} production .ts files.`);

if (process.env.GITHUB_ACTIONS === 'true') {
  for (const v of allViolations) {
    const file = v.path.replace(/%/g, '%25');
    const msg = String(`${v.snippet} - ${v.message}`)
      .replace(/%/g, '%25')
      .replace(/\r/g, '%0D')
      .replace(/\n/g, '%0A');
    console.log(`::error file=${file},line=${v.line},col=${v.col}::${msg}`);
  }
}

process.exit(1);
