#!/usr/bin/env node
// One-time per-clone git config sync. Runs from the `prepare` script after
// `npm install` to wire `blame.ignoreRevsFile` to `.git-blame-ignore-revs`,
// so `git blame` (and IDE blame views) automatically skip past mass-format
// commits listed in that file.
//
// Without this, every contributor would have to run the command in the
// header of `.git-blame-ignore-revs` manually. GitHub's web blame already
// respects the file unconditionally, but local tooling (CLI git, GitLens,
// JetBrains) does not.
//
// Failure modes that are intentionally swallowed:
//   - Not inside a git checkout (e.g., a tarball install). `git config
//     --local` exits non-zero; we treat this as "nothing to do".
//   - `git` not on PATH. Same handling.
//
// Idempotent: re-running just rewrites the same value.

import { execFileSync } from 'node:child_process';

try {
  execFileSync('git', ['config', 'blame.ignoreRevsFile', '.git-blame-ignore-revs', '--local'], {
    stdio: 'ignore',
  });
} catch {
  // Not a git checkout, or git not on PATH. Either way, nothing to do.
}
