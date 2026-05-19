#!/usr/bin/env node
// scripts/cull-stale-previews.mjs
//
// Cull stale per-PR preview environments from `swa-jotjson-nonprod`
// (and optionally the paired Cosmos SQL database `jotjson-pr-<N>` on
// `cosmos-jotjson-nonprod`).
//
// SCOPE: this script considers ONLY SWA env names matching the bare-number
// pattern `^[0-9]+$` (which is how `cd-preview.yml` names per-PR envs:
// `PREVIEW_ENV: pr-${{ github.event.pull_request.number }}` is sent to
// SWA, which surfaces them as bare numbers via `az staticwebapp
// environment list`). The `default` env and any manually-created env
// with a non-numeric name are NEVER touched.
//
// For each numeric env, we look up the corresponding PR's state via a
// single bulk `gh pr list --state all --limit 300 --json number,state`
// call. If the PR is CLOSED or MERGED, the env is culled. If the PR is
// OPEN or not present in the list at all, the env is KEPT (the
// "not-present" case is anomalous and we err toward false-negative cull
// rather than risk deleting a live env).
//
// CALLERS: invoked from `cd-preview.yml`'s `build-and-deploy` job as a
// best-effort just-in-time step before SWA deploy, and from
// `preview-cull.yml`'s daily cron job as a background safety net. Both
// callers wrap this script with `continue-on-error: true` and rely on
// the final exit code (0 on success / partial failure, non-zero on
// hard failure to enumerate state).

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const STALE_ENV_NAME_PATTERN = /^[0-9]+$/;
const PR_LIST_LIMIT = 300;
const VALID_PR_STATES = new Set(['OPEN', 'CLOSED', 'MERGED']);

function readRequiredFlag(args, flagName) {
  const exactPrefix = `${flagName}=`;
  for (const argument of args) {
    if (argument.startsWith(exactPrefix)) {
      const value = argument.slice(exactPrefix.length).trim();
      if (!value) {
        throw new Error(`Empty value for ${flagName}. Use ${flagName}=<value>.`);
      }
      return value;
    }
  }
  return null;
}

function hasBooleanFlag(args, flagName) {
  return args.some((argument) => argument === flagName);
}

export function parseCliOptions(args = process.argv.slice(2)) {
  const swaName = readRequiredFlag(args, '--swa-name');
  const resourceGroup = readRequiredFlag(args, '--rg');
  const cosmosAccount = readRequiredFlag(args, '--cosmos-account');
  const dryRun = hasBooleanFlag(args, '--dry-run');
  const pairedCosmos = hasBooleanFlag(args, '--paired-cosmos');

  const validFlags = new Set([
    '--swa-name',
    '--rg',
    '--cosmos-account',
    '--dry-run',
    '--paired-cosmos',
  ]);
  for (const argument of args) {
    const flagName = argument.includes('=') ? argument.slice(0, argument.indexOf('=')) : argument;
    if (!validFlags.has(flagName)) {
      throw new Error(
        `Unknown argument '${argument}'. Valid flags: --swa-name=, --rg=, --cosmos-account=, --dry-run, --paired-cosmos.`,
      );
    }
  }

  if (!swaName) {
    throw new Error('Missing required flag --swa-name=<name>.');
  }
  if (!resourceGroup) {
    throw new Error('Missing required flag --rg=<resource-group>.');
  }
  if (pairedCosmos && !cosmosAccount) {
    throw new Error(
      'Missing required flag --cosmos-account=<account> (required with --paired-cosmos).',
    );
  }

  return {
    swaName,
    resourceGroup,
    cosmosAccount,
    dryRun,
    pairedCosmos,
  };
}

export function isStaleEnvName(envName) {
  if (typeof envName !== 'string') return false;
  return STALE_ENV_NAME_PATTERN.test(envName);
}

export function pickCullable(envName, prStateMap) {
  if (!isStaleEnvName(envName)) {
    return { action: 'skip', reason: 'non-numeric env name (e.g. default); never touched' };
  }
  const prNumber = Number(envName);
  const state = prStateMap.get(prNumber);
  if (state === undefined) {
    return {
      action: 'keep',
      reason: `PR #${prNumber} not found in PR list (anomalous; keeping defensively)`,
    };
  }
  if (state === 'OPEN') {
    return { action: 'keep', reason: `PR #${prNumber} is OPEN` };
  }
  if (state === 'CLOSED' || state === 'MERGED') {
    return { action: 'cull', reason: `PR #${prNumber} is ${state}` };
  }
  return {
    action: 'keep',
    reason: `PR #${prNumber} has unrecognized state '${state}' (keeping defensively)`,
  };
}

function runCommand(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    shell: false,
    ...options,
  });
  if (result.error) {
    throw new Error(`failed to spawn ${file}: ${result.error.message}`);
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function listPrs(runner = runCommand) {
  const result = runner('gh', [
    'pr',
    'list',
    '--state',
    'all',
    '--limit',
    String(PR_LIST_LIMIT),
    '--json',
    'number,state',
  ]);
  if (result.status !== 0) {
    throw new Error(
      `gh pr list failed (exit ${result.status}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`gh pr list returned invalid JSON: ${message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`gh pr list returned non-array JSON: ${typeof parsed}`);
  }
  const stateMap = new Map();
  for (const entry of parsed) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof entry.number === 'number' &&
      typeof entry.state === 'string' &&
      VALID_PR_STATES.has(entry.state)
    ) {
      stateMap.set(entry.number, entry.state);
    }
  }
  return stateMap;
}

function listSwaEnvs(swaName, resourceGroup, runner = runCommand) {
  const result = runner('az', [
    'staticwebapp',
    'environment',
    'list',
    '--name',
    swaName,
    '--resource-group',
    resourceGroup,
    '--query',
    '[].name',
    '-o',
    'tsv',
  ]);
  if (result.status !== 0) {
    throw new Error(
      `az staticwebapp environment list failed (exit ${result.status}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function deleteSwaEnv(swaName, resourceGroup, envName, runner = runCommand) {
  const result = runner('az', [
    'staticwebapp',
    'environment',
    'delete',
    '--name',
    swaName,
    '--resource-group',
    resourceGroup,
    '--environment-name',
    envName,
    '--yes',
  ]);
  if (result.status !== 0) {
    const combined = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
    if (/not\s*found|notfound|does not exist/i.test(combined)) {
      return { ok: true, alreadyAbsent: true };
    }
    return {
      ok: false,
      message: `az staticwebapp environment delete failed (exit ${result.status}): ${combined}`,
    };
  }
  return { ok: true, alreadyAbsent: false };
}

function deleteCosmosDb(cosmosAccount, resourceGroup, dbName, runner = runCommand) {
  const result = runner('az', [
    'cosmosdb',
    'sql',
    'database',
    'delete',
    '--account-name',
    cosmosAccount,
    '--resource-group',
    resourceGroup,
    '--name',
    dbName,
    '--yes',
  ]);
  if (result.status !== 0) {
    const combined = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
    if (/not\s*found|notfound|does not exist/i.test(combined)) {
      return { ok: true, alreadyAbsent: true };
    }
    return {
      ok: false,
      message: `az cosmosdb sql database delete failed (exit ${result.status}): ${combined}`,
    };
  }
  return { ok: true, alreadyAbsent: false };
}

function emitStepSummary(lines, env = process.env, writer = null) {
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const write =
    writer ??
    (async (path, content) => {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(path, content, 'utf8');
    });
  const body = `${lines.join('\n')}\n`;
  return write(summaryPath, body);
}

export async function cullStalePreviews({
  options,
  logger = console,
  env = process.env,
  runner = runCommand,
  summaryWriter = null,
}) {
  logger.log(
    `cull-stale-previews: swa=${options.swaName} rg=${options.resourceGroup} cosmos=${options.cosmosAccount || '(none)'} dry-run=${options.dryRun} paired-cosmos=${options.pairedCosmos}`,
  );

  const prStateMap = listPrs(runner);
  logger.log(`cull-stale-previews: fetched ${prStateMap.size} PR states`);

  const envNames = listSwaEnvs(options.swaName, options.resourceGroup, runner);
  logger.log(`cull-stale-previews: found ${envNames.length} SWA envs total`);

  let culled = 0;
  let kept = 0;
  let skipped = 0;
  let failed = 0;
  const detailLines = [];

  for (const envName of envNames) {
    const decision = pickCullable(envName, prStateMap);
    if (decision.action === 'skip') {
      skipped += 1;
      logger.log(`cull-stale-previews: SKIP env=${envName} (${decision.reason})`);
      continue;
    }
    if (decision.action === 'keep') {
      kept += 1;
      logger.log(`cull-stale-previews: KEEP env=${envName} (${decision.reason})`);
      detailLines.push(`- KEEP env \`${envName}\`: ${decision.reason}`);
      continue;
    }

    // decision.action === 'cull'
    if (options.dryRun) {
      logger.log(`cull-stale-previews: DRY-RUN would cull env=${envName} (${decision.reason})`);
      detailLines.push(`- DRY-RUN cull env \`${envName}\`: ${decision.reason}`);
      culled += 1;
      continue;
    }

    logger.log(`cull-stale-previews: CULL env=${envName} (${decision.reason})`);
    const swaResult = deleteSwaEnv(options.swaName, options.resourceGroup, envName, runner);
    if (!swaResult.ok) {
      failed += 1;
      logger.log(`cull-stale-previews: FAIL env=${envName}: ${swaResult.message}`);
      detailLines.push(`- FAIL env \`${envName}\` SWA delete: ${swaResult.message}`);
      continue;
    }
    const swaNote = swaResult.alreadyAbsent ? ' (already absent)' : '';
    logger.log(`cull-stale-previews: deleted SWA env ${envName}${swaNote}`);

    if (options.pairedCosmos) {
      const dbName = `jotjson-pr-${envName}`;
      const cosmosResult = deleteCosmosDb(
        options.cosmosAccount,
        options.resourceGroup,
        dbName,
        runner,
      );
      if (!cosmosResult.ok) {
        failed += 1;
        logger.log(`cull-stale-previews: FAIL cosmos=${dbName}: ${cosmosResult.message}`);
        detailLines.push(
          `- PARTIAL env \`${envName}\` SWA deleted but Cosmos delete failed: ${cosmosResult.message}`,
        );
        continue;
      }
      const cosmosNote = cosmosResult.alreadyAbsent ? ' (already absent)' : '';
      logger.log(`cull-stale-previews: deleted Cosmos database ${dbName}${cosmosNote}`);
    }

    culled += 1;
    detailLines.push(`- CULL env \`${envName}\`: ${decision.reason}`);
  }

  const tally = `cull-stale-previews: tally culled=${culled} kept=${kept} skipped=${skipped} failed=${failed}`;
  logger.log(tally);

  const summaryLines = [
    '## Preview env cull',
    '',
    `- swa: \`${options.swaName}\``,
    `- rg: \`${options.resourceGroup}\``,
    `- mode: ${options.dryRun ? 'dry-run' : 'live'}`,
    `- tally: culled=${culled} kept=${kept} skipped=${skipped} failed=${failed}`,
    '',
    ...detailLines,
  ];
  await emitStepSummary(summaryLines, env, summaryWriter);

  if (failed > 0) {
    logger.log(
      `::warning::cull-stale-previews: ${failed} delete operation(s) failed. See step log for details.`,
    );
  }

  return { culled, kept, skipped, failed };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseCliOptions(args);
  await cullStalePreviews({ options, env });
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
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`cull-stale-previews: ${message}`);
    process.exit(1);
  });
}
