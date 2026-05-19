// Unit tests for scripts/cull-stale-previews.mjs.
//
// Runs under Node's built-in test runner: `node --test`. No external
// dependencies. The script guards `main()` behind an "invoked directly"
// check so importing it does not trigger CLI side effects (spawnSync
// calls, process.exit). All side-effecting paths (`spawnSync`,
// `appendFile`) are exercised through injected runners/writers.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cullStalePreviews,
  isStaleEnvName,
  parseCliOptions,
  pickCullable,
} from './cull-stale-previews.mjs';

const SWA_NAME = 'swa-jotjson-nonprod';
const RESOURCE_GROUP = 'rg-jotjson-nonprod';
const COSMOS_ACCOUNT = 'cosmos-jotjson-nonprod';

function silentLogger() {
  const messages = [];
  return {
    log(...args) {
      messages.push(args.join(' '));
    },
    messages,
  };
}

function makeRunner(plan) {
  // plan is an array of { match: (file, args) => bool, response: { status, stdout?, stderr? } }
  const calls = [];
  const runner = (file, args) => {
    calls.push({ file, args });
    for (const entry of plan) {
      if (entry.match(file, args)) {
        return {
          status: entry.response.status,
          stdout: entry.response.stdout ?? '',
          stderr: entry.response.stderr ?? '',
        };
      }
    }
    throw new Error(`unexpected runner call: ${file} ${args.join(' ')}`);
  };
  return { runner, calls };
}

test('parseCliOptions accepts all valid flags and validates required ones', () => {
  const options = parseCliOptions([
    '--swa-name=swa-x',
    '--rg=rg-x',
    '--cosmos-account=cos-x',
    '--paired-cosmos',
  ]);
  assert.deepEqual(options, {
    swaName: 'swa-x',
    resourceGroup: 'rg-x',
    cosmosAccount: 'cos-x',
    dryRun: false,
    pairedCosmos: true,
  });
});

test('parseCliOptions throws when --swa-name is missing', () => {
  assert.throws(() => parseCliOptions(['--rg=rg-x']), /--swa-name/);
});

test('parseCliOptions throws when --rg is missing', () => {
  assert.throws(() => parseCliOptions(['--swa-name=swa-x']), /--rg/);
});

test('parseCliOptions throws when --paired-cosmos lacks --cosmos-account', () => {
  assert.throws(
    () => parseCliOptions(['--swa-name=swa-x', '--rg=rg-x', '--paired-cosmos']),
    /--cosmos-account/,
  );
});

test('parseCliOptions rejects unknown flags', () => {
  assert.throws(
    () => parseCliOptions(['--swa-name=swa-x', '--rg=rg-x', '--bogus']),
    /Unknown argument.*--bogus/,
  );
});

test('parseCliOptions accepts --dry-run without --cosmos-account when --paired-cosmos absent', () => {
  const options = parseCliOptions(['--swa-name=swa-x', '--rg=rg-x', '--dry-run']);
  assert.equal(options.dryRun, true);
  assert.equal(options.pairedCosmos, false);
});

test('parseCliOptions rejects empty flag values', () => {
  assert.throws(() => parseCliOptions(['--swa-name=', '--rg=rg-x']), /Empty value.*--swa-name/);
});

test('isStaleEnvName matches bare numeric env names only', () => {
  assert.equal(isStaleEnvName('268'), true);
  assert.equal(isStaleEnvName('1'), true);
  assert.equal(isStaleEnvName('default'), false);
  assert.equal(isStaleEnvName('pr-268'), false);
  assert.equal(isStaleEnvName('268-staging'), false);
  assert.equal(isStaleEnvName(''), false);
  assert.equal(isStaleEnvName('268abc'), false);
  assert.equal(isStaleEnvName(null), false);
  assert.equal(isStaleEnvName(undefined), false);
});

test('pickCullable returns SKIP for non-numeric env names', () => {
  const decision = pickCullable('default', new Map());
  assert.equal(decision.action, 'skip');
});

test('pickCullable returns KEEP for OPEN PRs', () => {
  const prMap = new Map([[268, 'OPEN']]);
  const decision = pickCullable('268', prMap);
  assert.equal(decision.action, 'keep');
  assert.match(decision.reason, /OPEN/);
});

test('pickCullable returns CULL for CLOSED PRs', () => {
  const prMap = new Map([[268, 'CLOSED']]);
  const decision = pickCullable('268', prMap);
  assert.equal(decision.action, 'cull');
  assert.match(decision.reason, /CLOSED/);
});

test('pickCullable returns CULL for MERGED PRs', () => {
  const prMap = new Map([[317, 'MERGED']]);
  const decision = pickCullable('317', prMap);
  assert.equal(decision.action, 'cull');
  assert.match(decision.reason, /MERGED/);
});

test('pickCullable returns KEEP defensively when PR is not in the list', () => {
  const decision = pickCullable('999', new Map());
  assert.equal(decision.action, 'keep');
  assert.match(decision.reason, /not found/);
});

test('cullStalePreviews keeps OPEN PRs, culls CLOSED/MERGED PRs, skips default', async () => {
  const prListJson = JSON.stringify([
    { number: 268, state: 'CLOSED' },
    { number: 299, state: 'OPEN' },
    { number: 317, state: 'MERGED' },
  ]);
  const swaListOutput = ['default', '268', '299', '317'].join('\n');
  const { runner, calls } = makeRunner([
    {
      match: (file, args) => file === 'gh' && args[0] === 'pr',
      response: { status: 0, stdout: prListJson },
    },
    {
      match: (file, args) => file === 'az' && args[0] === 'staticwebapp' && args[2] === 'list',
      response: { status: 0, stdout: swaListOutput },
    },
    {
      match: (file, args) => file === 'az' && args[0] === 'staticwebapp' && args[2] === 'delete',
      response: { status: 0, stdout: '' },
    },
    {
      match: (file, args) => file === 'az' && args[0] === 'cosmosdb',
      response: { status: 0, stdout: '' },
    },
  ]);

  const logger = silentLogger();
  const summaryEntries = [];
  const result = await cullStalePreviews({
    options: {
      swaName: SWA_NAME,
      resourceGroup: RESOURCE_GROUP,
      cosmosAccount: COSMOS_ACCOUNT,
      dryRun: false,
      pairedCosmos: true,
    },
    logger,
    env: { GITHUB_STEP_SUMMARY: '/tmp/summary' },
    runner,
    summaryWriter: async (path, content) => {
      summaryEntries.push({ path, content });
    },
  });

  assert.deepEqual(result, { culled: 2, kept: 1, skipped: 1, failed: 0 });
  // Verify one SWA delete per culled env (268, 317) and one Cosmos delete per culled env
  const deleteCalls = calls.filter((c) => c.file === 'az' && c.args[2] === 'delete');
  assert.equal(deleteCalls.length, 2);
  const cosmosCalls = calls.filter((c) => c.file === 'az' && c.args[0] === 'cosmosdb');
  assert.equal(cosmosCalls.length, 2);
  // Summary should be written exactly once
  assert.equal(summaryEntries.length, 1);
  assert.match(summaryEntries[0].content, /culled=2 kept=1 skipped=1 failed=0/);
});

test('cullStalePreviews dry-run does not call delete commands', async () => {
  const prListJson = JSON.stringify([{ number: 268, state: 'CLOSED' }]);
  const swaListOutput = '268\n';
  const { runner, calls } = makeRunner([
    {
      match: (file, args) => file === 'gh' && args[0] === 'pr',
      response: { status: 0, stdout: prListJson },
    },
    {
      match: (file, args) => file === 'az' && args[0] === 'staticwebapp' && args[2] === 'list',
      response: { status: 0, stdout: swaListOutput },
    },
  ]);

  const logger = silentLogger();
  const result = await cullStalePreviews({
    options: {
      swaName: SWA_NAME,
      resourceGroup: RESOURCE_GROUP,
      cosmosAccount: COSMOS_ACCOUNT,
      dryRun: true,
      pairedCosmos: true,
    },
    logger,
    env: {},
    runner,
  });

  assert.deepEqual(result, { culled: 1, kept: 0, skipped: 0, failed: 0 });
  // Only list calls expected; no deletes
  const deleteCalls = calls.filter((c) => c.args.includes('delete'));
  assert.equal(deleteCalls.length, 0);
});

test('cullStalePreviews counts failures and emits warning but returns', async () => {
  const prListJson = JSON.stringify([{ number: 268, state: 'CLOSED' }]);
  const swaListOutput = '268\n';
  const { runner } = makeRunner([
    {
      match: (file, args) => file === 'gh' && args[0] === 'pr',
      response: { status: 0, stdout: prListJson },
    },
    {
      match: (file, args) => file === 'az' && args[0] === 'staticwebapp' && args[2] === 'list',
      response: { status: 0, stdout: swaListOutput },
    },
    {
      match: (file, args) => file === 'az' && args[0] === 'staticwebapp' && args[2] === 'delete',
      response: { status: 1, stderr: 'transient azure error' },
    },
  ]);

  const logger = silentLogger();
  const result = await cullStalePreviews({
    options: {
      swaName: SWA_NAME,
      resourceGroup: RESOURCE_GROUP,
      cosmosAccount: COSMOS_ACCOUNT,
      dryRun: false,
      pairedCosmos: false,
    },
    logger,
    env: {},
    runner,
  });

  assert.deepEqual(result, { culled: 0, kept: 0, skipped: 0, failed: 1 });
  assert.ok(
    logger.messages.some((m) => m.includes('::warning::')),
    'expected ::warning:: annotation on failure',
  );
});

test('cullStalePreviews treats already-absent SWA env as success', async () => {
  const prListJson = JSON.stringify([{ number: 268, state: 'CLOSED' }]);
  const swaListOutput = '268\n';
  const { runner } = makeRunner([
    {
      match: (file, args) => file === 'gh' && args[0] === 'pr',
      response: { status: 0, stdout: prListJson },
    },
    {
      match: (file, args) => file === 'az' && args[0] === 'staticwebapp' && args[2] === 'list',
      response: { status: 0, stdout: swaListOutput },
    },
    {
      match: (file, args) => file === 'az' && args[0] === 'staticwebapp' && args[2] === 'delete',
      response: { status: 1, stderr: 'ResourceNotFound: env does not exist' },
    },
  ]);

  const logger = silentLogger();
  const result = await cullStalePreviews({
    options: {
      swaName: SWA_NAME,
      resourceGroup: RESOURCE_GROUP,
      cosmosAccount: COSMOS_ACCOUNT,
      dryRun: false,
      pairedCosmos: false,
    },
    logger,
    env: {},
    runner,
  });

  assert.deepEqual(result, { culled: 1, kept: 0, skipped: 0, failed: 0 });
});

test('cullStalePreviews throws hard when gh pr list fails', async () => {
  const { runner } = makeRunner([
    {
      match: (file, args) => file === 'gh' && args[0] === 'pr',
      response: { status: 1, stderr: 'gh: not authenticated' },
    },
  ]);

  await assert.rejects(
    () =>
      cullStalePreviews({
        options: {
          swaName: SWA_NAME,
          resourceGroup: RESOURCE_GROUP,
          cosmosAccount: COSMOS_ACCOUNT,
          dryRun: false,
          pairedCosmos: false,
        },
        logger: silentLogger(),
        env: {},
        runner,
      }),
    /gh pr list failed/,
  );
});

test('cullStalePreviews throws hard when az env list fails', async () => {
  const prListJson = JSON.stringify([]);
  const { runner } = makeRunner([
    {
      match: (file, args) => file === 'gh' && args[0] === 'pr',
      response: { status: 0, stdout: prListJson },
    },
    {
      match: (file, args) => file === 'az' && args[0] === 'staticwebapp' && args[2] === 'list',
      response: { status: 1, stderr: 'az: subscription not found' },
    },
  ]);

  await assert.rejects(
    () =>
      cullStalePreviews({
        options: {
          swaName: SWA_NAME,
          resourceGroup: RESOURCE_GROUP,
          cosmosAccount: COSMOS_ACCOUNT,
          dryRun: false,
          pairedCosmos: false,
        },
        logger: silentLogger(),
        env: {},
        runner,
      }),
    /az staticwebapp environment list failed/,
  );
});

test('cullStalePreviews skips Cosmos delete when --paired-cosmos absent', async () => {
  const prListJson = JSON.stringify([{ number: 268, state: 'CLOSED' }]);
  const swaListOutput = '268\n';
  const { runner, calls } = makeRunner([
    {
      match: (file, args) => file === 'gh' && args[0] === 'pr',
      response: { status: 0, stdout: prListJson },
    },
    {
      match: (file, args) => file === 'az' && args[0] === 'staticwebapp' && args[2] === 'list',
      response: { status: 0, stdout: swaListOutput },
    },
    {
      match: (file, args) => file === 'az' && args[0] === 'staticwebapp' && args[2] === 'delete',
      response: { status: 0, stdout: '' },
    },
  ]);

  const result = await cullStalePreviews({
    options: {
      swaName: SWA_NAME,
      resourceGroup: RESOURCE_GROUP,
      cosmosAccount: COSMOS_ACCOUNT,
      dryRun: false,
      pairedCosmos: false,
    },
    logger: silentLogger(),
    env: {},
    runner,
  });

  assert.deepEqual(result, { culled: 1, kept: 0, skipped: 0, failed: 0 });
  const cosmosCalls = calls.filter((c) => c.file === 'az' && c.args[0] === 'cosmosdb');
  assert.equal(cosmosCalls.length, 0);
});

test('cullStalePreviews counts SWA-deleted-but-Cosmos-failed as partial failure', async () => {
  const prListJson = JSON.stringify([{ number: 268, state: 'CLOSED' }]);
  const swaListOutput = '268\n';
  const { runner } = makeRunner([
    {
      match: (file, args) => file === 'gh' && args[0] === 'pr',
      response: { status: 0, stdout: prListJson },
    },
    {
      match: (file, args) => file === 'az' && args[0] === 'staticwebapp' && args[2] === 'list',
      response: { status: 0, stdout: swaListOutput },
    },
    {
      match: (file, args) => file === 'az' && args[0] === 'staticwebapp' && args[2] === 'delete',
      response: { status: 0, stdout: '' },
    },
    {
      match: (file, args) => file === 'az' && args[0] === 'cosmosdb',
      response: { status: 1, stderr: 'cosmos transient error' },
    },
  ]);

  const result = await cullStalePreviews({
    options: {
      swaName: SWA_NAME,
      resourceGroup: RESOURCE_GROUP,
      cosmosAccount: COSMOS_ACCOUNT,
      dryRun: false,
      pairedCosmos: true,
    },
    logger: silentLogger(),
    env: {},
    runner,
  });

  // SWA delete succeeded but Cosmos failed -> not counted as culled, counted as failed
  assert.deepEqual(result, { culled: 0, kept: 0, skipped: 0, failed: 1 });
});
