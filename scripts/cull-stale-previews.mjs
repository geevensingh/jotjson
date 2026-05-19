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
// per-PR `gh pr view <n> --json state` call. If the PR is CLOSED or
// MERGED, the env is culled. If the PR is OPEN, the env is KEPT. If
// `gh` reports the PR does not exist on this repo, the env is KEPT
// defensively - by convention SWA env names always derive from real
// PR numbers, so a "not found" answer is anomalous and we err on the
// side of false-negative cull rather than risk deleting a live env.
// If `gh` fails transiently (network, rate limit, malformed JSON), the
// env is counted as `failed` and KEPT for this run; the daily cron is
// the safety net.
//
// We previously used a bulk `gh pr list --state all --limit 300` call
// to fetch all states at once. The bulk window meant any leaked env
// older than the most recent 300 PRs could never be culled (Copilot
// review on PR #329). Per-env queries scale linearly with env count
// (capped at 10 by the SWA Standard tier) so the GraphQL spend is
// bounded.
//
// CALLERS: invoked from `cd-preview.yml`'s `build-and-deploy` job as a
// best-effort just-in-time step before SWA deploy (with
// `--skip-env=<current-PR-number>` so the cull never races against
// the same workflow's own upcoming deploy), and from
// `preview-cull.yml`'s daily cron job as a background safety net. Both
// callers wrap this script with `continue-on-error: true` and rely on
// the final exit code (0 on success / partial failure, non-zero on
// hard failure to enumerate state, or a systemic failure where every
// per-PR gh query failed).

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const STALE_ENV_NAME_PATTERN = /^[0-9]+$/;
const VALID_PR_STATES = new Set(['OPEN', 'CLOSED', 'MERGED']);

function readOptionWithOptionalValue(args, optionName) {
  // Adapted from scripts/check-deploy-freshness.mjs. Supports both the
  // `--flag=value` and `--flag value` forms. Unlike the reference helper,
  // this version preserves the cull-script's empty-value rejection so
  // `--swa-name=` (or `--swa-name ''`) still throws a clear error rather
  // than being silently treated as "flag absent".
  const exactPrefix = `${optionName}=`;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument.startsWith(exactPrefix)) {
      return {
        value: argument.slice(exactPrefix.length),
        consumedIndexes: new Set([index]),
      };
    }
    if (argument === optionName) {
      const nextIndex = index + 1;
      const value = args[nextIndex];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(
          `Missing value for ${optionName}. Use ${optionName}=<value> or ${optionName} <value>.`,
        );
      }
      return { value, consumedIndexes: new Set([index, nextIndex]) };
    }
  }
  return { value: null, consumedIndexes: new Set() };
}

function readBooleanFlag(args, flagName) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flagName) {
      return { value: true, consumedIndexes: new Set([index]) };
    }
  }
  return { value: false, consumedIndexes: new Set() };
}

export function parseCliOptions(args = process.argv.slice(2)) {
  const swaNameOption = readOptionWithOptionalValue(args, '--swa-name');
  const rgOption = readOptionWithOptionalValue(args, '--rg');
  const cosmosAccountOption = readOptionWithOptionalValue(args, '--cosmos-account');
  const skipEnvOption = readOptionWithOptionalValue(args, '--skip-env');
  const dryRunOption = readBooleanFlag(args, '--dry-run');
  const pairedCosmosOption = readBooleanFlag(args, '--paired-cosmos');

  const consumed = new Set([
    ...swaNameOption.consumedIndexes,
    ...rgOption.consumedIndexes,
    ...cosmosAccountOption.consumedIndexes,
    ...skipEnvOption.consumedIndexes,
    ...dryRunOption.consumedIndexes,
    ...pairedCosmosOption.consumedIndexes,
  ]);
  for (let index = 0; index < args.length; index += 1) {
    if (!consumed.has(index)) {
      throw new Error(
        `Unknown argument '${args[index]}'. Valid flags: --swa-name=, --rg=, --cosmos-account=, --skip-env=, --dry-run, --paired-cosmos.`,
      );
    }
  }

  // Reject explicit empty values (e.g. `--swa-name=`) with a clearer
  // error than the "missing required flag" path below; preserves
  // existing test contract.
  for (const [optionName, option] of [
    ['--swa-name', swaNameOption],
    ['--rg', rgOption],
    ['--cosmos-account', cosmosAccountOption],
    ['--skip-env', skipEnvOption],
  ]) {
    if (option.consumedIndexes.size > 0 && (option.value ?? '').trim() === '') {
      throw new Error(`Empty value for ${optionName}. Use ${optionName}=<value>.`);
    }
  }

  const swaName = swaNameOption.value?.trim() ?? '';
  const resourceGroup = rgOption.value?.trim() ?? '';
  const cosmosAccount = cosmosAccountOption.value?.trim() ?? '';
  const skipEnv = skipEnvOption.value?.trim() ?? '';

  if (!swaName) {
    throw new Error('Missing required flag --swa-name=<name>.');
  }
  if (!resourceGroup) {
    throw new Error('Missing required flag --rg=<resource-group>.');
  }
  if (pairedCosmosOption.value && !cosmosAccount) {
    throw new Error(
      'Missing required flag --cosmos-account=<account> (required with --paired-cosmos).',
    );
  }

  return {
    swaName,
    resourceGroup,
    cosmosAccount,
    skipEnv,
    dryRun: dryRunOption.value,
    pairedCosmos: pairedCosmosOption.value,
  };
}

export function isStaleEnvName(envName) {
  if (typeof envName !== 'string') return false;
  return STALE_ENV_NAME_PATTERN.test(envName);
}

// pickCullable classifies a single env name + (optionally) its PR state
// result. Pure function for test ergonomics; the orchestrator is
// responsible for the actual gh I/O via getPrState.
//
// `prStateResult` shape:
//   - `null` when envName is non-numeric (no state needed; SKIP)
//   - `{ ok: true, state: 'OPEN' | 'CLOSED' | 'MERGED' }`
//   - `{ ok: false, transient: false, reason: string }` - definitive
//     "PR does not exist on this repo". By convention SWA env names
//     always derive from real PR numbers, so this is anomalous; we
//     KEEP defensively to avoid deleting a live env behind a naming
//     drift we don't yet understand.
//   - `{ ok: false, transient: true, reason: string }` - transient
//     gh failure (network, malformed JSON, unexpected exit). Counted
//     as FAIL by the caller; KEEP for this run.
export function pickCullable(envName, prStateResult, skipSet = new Set()) {
  if (!isStaleEnvName(envName)) {
    return { action: 'skip', reason: 'non-numeric env name (e.g. default); never touched' };
  }
  if (skipSet.has(envName)) {
    return { action: 'skip', reason: 'env explicitly excluded via --skip-env' };
  }
  if (prStateResult === null || prStateResult === undefined) {
    throw new Error(`pickCullable: missing prStateResult for env '${envName}'`);
  }
  if (!prStateResult.ok) {
    if (prStateResult.transient) {
      return { action: 'fail', reason: prStateResult.reason };
    }
    return { action: 'keep', reason: prStateResult.reason };
  }
  if (prStateResult.state === 'OPEN') {
    return { action: 'keep', reason: `PR #${envName} is OPEN` };
  }
  if (prStateResult.state === 'CLOSED' || prStateResult.state === 'MERGED') {
    return { action: 'cull', reason: `PR #${envName} is ${prStateResult.state}` };
  }
  return {
    action: 'keep',
    reason: `PR #${envName} has unrecognized state '${prStateResult.state}' (keeping defensively)`,
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

export function getPrState(prNumber, runner = runCommand) {
  const result = runner('gh', ['pr', 'view', String(prNumber), '--json', 'state']);
  if (result.status === 0) {
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        transient: true,
        reason: `gh pr view ${prNumber} returned invalid JSON: ${message}`,
      };
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.state === 'string' &&
      VALID_PR_STATES.has(parsed.state)
    ) {
      return { ok: true, state: parsed.state };
    }
    return {
      ok: false,
      transient: true,
      reason: `gh pr view ${prNumber} returned unexpected JSON: ${(result.stdout || '').trim()}`,
    };
  }
  const combined = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
  // gh CLI surfaces a missing PR via stderr text. We match the common
  // shapes - GraphQL "Could not resolve to a PullRequest", REST "no
  // pull requests found", and the generic "not found" string.
  if (/could not resolve|no pull requests|not found/i.test(combined)) {
    return {
      ok: false,
      transient: false,
      reason: `PR #${prNumber} does not exist on this repo (anomalous; keeping env defensively)`,
    };
  }
  return {
    ok: false,
    transient: true,
    reason: `gh pr view ${prNumber} failed (exit ${result.status}): ${combined}`,
  };
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
    `cull-stale-previews: swa=${options.swaName} rg=${options.resourceGroup} cosmos=${options.cosmosAccount || '(none)'} skip-env=${options.skipEnv || '(none)'} dry-run=${options.dryRun} paired-cosmos=${options.pairedCosmos}`,
  );

  const skipSet = options.skipEnv ? new Set([options.skipEnv]) : new Set();
  const envNames = listSwaEnvs(options.swaName, options.resourceGroup, runner);
  logger.log(`cull-stale-previews: found ${envNames.length} SWA envs total`);

  let culled = 0;
  let kept = 0;
  let skipped = 0;
  let failed = 0;
  let numericEnvsQueried = 0;
  const detailLines = [];

  for (const envName of envNames) {
    if (!isStaleEnvName(envName)) {
      skipped += 1;
      logger.log(`cull-stale-previews: SKIP env=${envName} (non-numeric)`);
      continue;
    }
    if (skipSet.has(envName)) {
      skipped += 1;
      logger.log(`cull-stale-previews: SKIP env=${envName} (--skip-env: current deploy's own env)`);
      continue;
    }

    numericEnvsQueried += 1;
    const prStateResult = getPrState(Number(envName), runner);
    const decision = pickCullable(envName, prStateResult, skipSet);

    if (decision.action === 'fail') {
      failed += 1;
      logger.log(`cull-stale-previews: FAIL env=${envName}: ${decision.reason}`);
      detailLines.push(`- FAIL env \`${envName}\` PR state lookup: ${decision.reason}`);
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
      `::warning::cull-stale-previews: ${failed} operation(s) failed. See step log for details.`,
    );
  }

  // Systemic failure: every numeric env we tried to evaluate produced
  // a transient gh failure (or downstream Azure failure with zero
  // successes). Distinguishes "cull was a no-op because nothing to do"
  // from "cull was a no-op because the whole pipeline is broken".
  const systemicFailure = numericEnvsQueried > 0 && failed > 0 && culled === 0 && kept === 0;

  return { culled, kept, skipped, failed, systemicFailure };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseCliOptions(args);
  const result = await cullStalePreviews({ options, env });
  if (result.systemicFailure) {
    throw new Error(
      `systemic failure: ${result.failed} per-PR gh queries failed with 0 conclusive answers. Likely auth/network issue; investigate manually.`,
    );
  }
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
