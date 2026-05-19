#!/usr/bin/env node
// scripts/check-deprecated-telemetry.mjs
//
// Forbids re-introduction of the legacy `update.*` telemetry tokens
// that were retired by the SW migration. The literal-union entries
// in src/app/core/telemetry/telemetry-message-ids.ts are kept as
// frozen-for-history records (so KQL queries still parse against
// pre-migration data and grep can find the migration history), but
// no production source should call `logger.event('update.X', ...)`
// or `logger.warn('update.X', ...)` etc.
//
// If a new emit site is genuinely needed, add a brand-new
// `sw.<name>` token to the catalog with full JSDoc per
// AGENTS.md §4 Telemetry, and emit that instead.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Matches `logger.<event|warn|error|info>('update.X', ...)` and
// `trackEvent('update.X', ...)`. Uses single-or-double quotes; does
// not attempt to match template literals because the catalog tokens
// are all simple identifiers (no interpolation) and a contributor
// writing `logger.event(\`update.\${x}\`, ...)` would already trip
// the literal-union type system.
const PATTERN =
  /\b(?:logger|telemetry|client)\.(?:event|warn|error|info)\s*\(\s*['"]update\.[^'"]*['"]/g;
const TRACK_EVENT_PATTERN = /\btrackEvent\s*\(\s*['"]update\.[^'"]*['"]/g;

const EXCLUDE_FILES = new Set([
  // The catalog itself is allowed to list the frozen tokens.
  'src/app/core/telemetry/telemetry-message-ids.ts',
]);

export function listProdFiles() {
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
    .filter((p) => !p.includes('/testing/') && !p.endsWith('.testing.ts'))
    .filter((p) => !EXCLUDE_FILES.has(p));
}

export function scan(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const normalizedPath = path.replace(/\\/g, '/');
  return scanText(text, normalizedPath);
}

export function scanText(text, normalizedPath) {
  const violations = [];
  for (const pattern of [PATTERN, TRACK_EVENT_PATTERN]) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const upToMatch = text.slice(0, m.index);
      const lastNl = upToMatch.lastIndexOf('\n');
      const line = upToMatch.split('\n').length;
      const col = m.index - (lastNl + 1) + 1;
      const lineSoFar = text.slice(lastNl + 1, m.index);
      if (/^\s*(\*|\/\/)/.test(lineSoFar)) continue;
      if (lineSoFar.includes('//')) continue;
      violations.push({
        path: normalizedPath,
        line,
        col,
        snippet: m[0],
      });
    }
  }
  return violations;
}

export function main() {
  const files = listProdFiles();
  const allViolations = files.flatMap(scan);

  if (allViolations.length === 0) {
    process.stdout.write(
      `check-deprecated-telemetry: OK (${files.length} production .ts files scanned, 0 violations)\n`,
    );
    return 0;
  }

  process.stderr.write(
    'check-deprecated-telemetry: emit-site references to retired update.* tokens:\n',
  );
  for (const v of allViolations) {
    process.stderr.write(`  ${v.path}:${v.line}:${v.col}  ${v.snippet}\n`);
    process.stderr.write(
      `    -> The update.* telemetry tokens were retired in the SW migration.\n` +
        `       Use one of the sw.* tokens (sw.registered, sw.activated, sw.registerFailed,\n` +
        `       sw.legacyCacheWiped) or add a new token to TELEMETRY_MESSAGE_IDS with full\n` +
        `       JSDoc per AGENTS.md §4 Telemetry.\n`,
    );
  }
  process.stderr.write(
    `\n${allViolations.length} violation(s) in ${files.length} production .ts files.\n`,
  );

  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const v of allViolations) {
      const file = v.path.replace(/%/g, '%25');
      const msg = `${v.snippet} - retired update.* token (see docs/sw-migration.md)`
        .replace(/%/g, '%25')
        .replace(/\r/g, '%0D')
        .replace(/\n/g, '%0A');
      process.stdout.write(`::error file=${file},line=${v.line},col=${v.col}::${msg}\n`);
    }
  }

  return 1;
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
