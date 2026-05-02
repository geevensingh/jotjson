#!/usr/bin/env node
// Prettier annotation wrapper. Runs `prettier --list-different .` and, when
// invoked under GitHub Actions (`process.env.GITHUB_ACTIONS === 'true'`),
// emits one `::error file=PATH::msg` annotation per unformatted file so
// failures surface inline on the PR Files Changed view.
//
// Local runs are unchanged in behavior: list of unformatted files (if any)
// to stderr, exit 1 if any. Prettier itself exits 1 when files differ;
// other non-zero exits indicate prettier-internal errors and we surface
// those verbatim.
//
// Why a wrapper instead of `prettier --check`:
//   prettier --check / --list-different have no built-in line/column
//   information for formatting violations, so annotations are file-level
//   only. The wrapper is responsible for translating the path list into
//   the GitHub `::error file=...::` workflow command.
//
// Runs with zero dependencies on Node 24+. Invoke directly or via
//   npm run lint:format

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const prettierJsPath = resolve('node_modules', 'prettier', 'bin', 'prettier.cjs');
if (!existsSync(prettierJsPath)) {
  console.error(
    'check-format: cannot find node_modules/prettier/bin/prettier.cjs. Run "npm ci" first.',
  );
  process.exit(2);
}

const result = spawnSync(process.execPath, [prettierJsPath, '--list-different', '.'], {
  encoding: 'utf8',
});

if (result.error) {
  console.error('check-format: failed to spawn prettier:', result.error.message);
  process.exit(2);
}

if (result.status !== 0 && result.status !== 1) {
  // Prettier crashed (config error, etc.). Surface output verbatim and exit
  // with prettier's status code so CI reflects the actual failure.
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  process.exit(result.status ?? 1);
}

const unformatted = (result.stdout ?? '')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

if (unformatted.length === 0) {
  console.log('check-format: OK (all files match prettier configuration)');
  process.exit(0);
}

console.error(`check-format: ${unformatted.length} file(s) not formatted:`);
for (const f of unformatted) {
  console.error(`  ${f}`);
}
console.error('\nRun "npm run format" to fix.');

if (process.env.GITHUB_ACTIONS === 'true') {
  for (const f of unformatted) {
    // Prettier emits forward-slash paths even on Windows. Encode any `%`
    // in the filename per GitHub's workflow-command escaping rules; `:`
    // and `,` in unix paths are not legal but the same encoding applies
    // to be safe.
    const file = f.replace(/%/g, '%25');
    const msg = 'File is not formatted per prettier rules. Run "npm run format" to fix.';
    console.log(`::error file=${file}::${msg}`);
  }
}

process.exit(1);
