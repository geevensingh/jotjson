// scripts/build-info-payload.mjs
//
// Pure helper that computes the BUILD_INFO payload shape consumed by
// both prebuild (writes `src/generated/build-info.ts`, the typed
// constant the SPA bundle ships) and postbuild (reads back that
// TS file's literal and emits `dist/jotjson/browser/build-info.json`,
// the per-deploy marker the freshness gate polls).
//
// The helper exists so the payload shape is unit-testable in
// isolation AND so callers must pass `sha` (and `builtAt`)
// explicitly. The original inline version in
// `scripts/write-build-info.mjs` read `process.env.GITHUB_SHA`
// directly, which silently degrades in workflow_run-triggered
// jobs: `github.event.workflow_run.head_sha` is the SHA that
// was actually built, but `GITHUB_SHA` resolves to the
// triggering workflow's ref and can lag (or move) between
// trigger and execution. The CD workflows set
// `JOTJSON_BUILD_SHA` from the workflow_run.head_sha
// expression; `write-build-info.mjs` reads that env var and
// passes it down so the bundle's encoded SHA matches the
// checked-out ref.
//
// Runs with zero dependencies on Node 24+.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function normalizeRepositoryUrl(rawRepositoryUrl) {
  if (typeof rawRepositoryUrl !== 'string' || rawRepositoryUrl.trim() === '') {
    return '';
  }

  let repositoryUrl = rawRepositoryUrl.trim();

  if (repositoryUrl.startsWith('git+')) {
    repositoryUrl = repositoryUrl.slice('git+'.length);
  }

  repositoryUrl = repositoryUrl.replace(/\.git$/iu, '');

  const sshProtocolMatch = /^ssh:\/\/git@github\.com\/([^/]+\/[^/]+)$/iu.exec(repositoryUrl);
  if (sshProtocolMatch !== null) {
    return `https://github.com/${sshProtocolMatch[1]}`;
  }

  const sshShortcutMatch = /^git@github\.com:([^/]+\/[^/]+)$/iu.exec(repositoryUrl);
  if (sshShortcutMatch !== null) {
    return `https://github.com/${sshShortcutMatch[1]}`;
  }

  return repositoryUrl;
}

// Computes a monotonically non-decreasing build counter on `main`.
// Returns 'unknown' (and warns) on shallow checkouts or when git is
// unavailable -- a fake '0' would silently pollute telemetry. The
// post-build assertion in ci.yml fails the workflow if a shipped
// artifact contains 'unknown', surfacing a missing fetch-depth: 0.
export function deriveBuildNumber({ repoRoot, logger = console } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot === '') {
    throw new Error('deriveBuildNumber: repoRoot is required');
  }
  try {
    const isShallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (isShallow === 'true') {
      logger.warn(
        "write-build-info: shallow git checkout detected; buildNumber set to 'unknown'. " +
          'Set actions/checkout fetch-depth: 0 if this is the build that ships.',
      );
      return 'unknown';
    }
    const count = execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (count === '' || !/^\d+$/u.test(count)) {
      logger.warn(
        `write-build-info: unexpected git rev-list output ${JSON.stringify(count)}; ` +
          "buildNumber set to 'unknown'.",
      );
      return 'unknown';
    }
    return count;
  } catch (error) {
    logger.warn(
      `write-build-info: failed to derive buildNumber from git (${error?.message ?? error}); ` +
        "buildNumber set to 'unknown'.",
    );
    return 'unknown';
  }
}

// Resolves the deploy SHA from environment variables. The CD
// workflows export `JOTJSON_BUILD_SHA` from the
// `${{ github.event.workflow_run.head_sha || github.sha }}`
// expression so the encoded SHA tracks the checked-out ref.
// `GITHUB_SHA` is a fallback for local builds invoked under a CI
// context that only sets the GitHub-default vars. 'dev' is the
// final fallback for ordinary developer builds.
export function resolveBuildShaFromEnv(env = process.env) {
  const candidates = [env.JOTJSON_BUILD_SHA, env.GITHUB_SHA];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.toLowerCase();
    }
  }
  return 'dev';
}

// Builds the BUILD_INFO payload. Caller MUST pass `sha` and may
// optionally override every other source field (used by tests).
// `builtAt` defaults to the current ISO timestamp at call time;
// postbuild reads back the prebuild TS file rather than recomputing
// the payload, so the bundle's BUILD_INFO and the deployed
// /build-info.json carry the SAME `builtAt` value.
export function computeBuildInfoPayload({
  repoRoot,
  sha,
  branch = '',
  builtAt = new Date().toISOString(),
  packageMetadata,
  buildNumber,
  logger = console,
} = {}) {
  if (typeof repoRoot !== 'string' || repoRoot === '') {
    throw new Error('computeBuildInfoPayload: repoRoot is required');
  }
  if (typeof sha !== 'string' || sha.trim() === '') {
    throw new Error(
      'computeBuildInfoPayload: sha is required (pass resolveBuildShaFromEnv(env) or a literal).',
    );
  }
  const metadata =
    packageMetadata ?? JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
  const resolvedBuildNumber = buildNumber ?? deriveBuildNumber({ repoRoot, logger });
  return {
    version: metadata.version,
    sha: sha.toLowerCase(),
    branch,
    builtAt,
    repoUrl: normalizeRepositoryUrl(metadata.repository?.url),
    buildNumber: resolvedBuildNumber,
  };
}
