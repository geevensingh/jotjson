import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Pinned: the last commit on `main` that still has
 * `provideServiceWorker('ngsw-worker.js', ...)` in `app.config.ts`.
 * This is the natural parent of the SW-migration squash-merge.
 *
 * DO NOT replace with `HEAD~1` -- it silently degrades on the next
 * unrelated merge into main (per plan v2 §3d C3 + memory:
 * "Pin to a literal SHA, not HEAD~1").
 *
 * Update once when the migration PR merges; never again. The
 * regex backstop below catches a placeholder before the eventual
 * `git worktree add` error path.
 */
export const FIXTURE_SHA = '6a45bdcdee6e41b6e384c8bd8864e8382f6696c5';

if (!/^[0-9a-f]{40}$/.test(FIXTURE_SHA)) {
  throw new Error(
    `FIXTURE_SHA must be a 40-char hex commit SHA; got ${FIXTURE_SHA}. ` +
      `See plan.md \u00a73d in the SW migration PR.`,
  );
}

/**
 * Materializes the pre-migration build into a temporary directory via
 * `git worktree add --detach`, runs `npm ci && npm run build`, and
 * returns the path to `dist/jotjson/browser/`.
 *
 * Cached for the lifetime of the e2e test job; subsequent calls within
 * the same node process reuse the same worktree.
 */
let cachedDistPath: string | undefined;

export function buildFixture(): string {
  if (cachedDistPath && existsSync(cachedDistPath)) {
    return cachedDistPath;
  }
  const worktreeDir = mkdtempSync(resolve(tmpdir(), 'jj-pre-migration-'));
  execSync(`git worktree add --detach ${worktreeDir} ${FIXTURE_SHA}`, {
    stdio: 'inherit',
  });
  execSync('npm ci', { cwd: worktreeDir, stdio: 'inherit' });
  execSync('npm run build', { cwd: worktreeDir, stdio: 'inherit' });
  cachedDistPath = resolve(worktreeDir, 'dist/jotjson/browser');
  return cachedDistPath;
}
