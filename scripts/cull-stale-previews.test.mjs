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
  getPrState,
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

// makeRunner builds a mock spawnSync runner that dispatches by predicate.
// Each entry's `match(file, args) => bool` is evaluated in order; the
// first match wins. The mock supports the per-PR `gh pr view <n>` path
// added in PR #329's review-feedback fix: tests pass an explicit
// matcher per PR number, so a missing matcher throws and surfaces a
// dispatch gap immediately.
function makeRunner(plan) {
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

function ghPrViewMatcher(prNumber) {
  return (file, args) =>
    file === 'gh' && args[0] === 'pr' && args[1] === 'view' && args[2] === String(prNumber);
}

function swaListMatcher() {
  return (file, args) =>
    file === 'az' && args[0] === 'staticwebapp' && args[1] === 'environment' && args[2] === 'list';
}

function swaDeleteMatcher() {
  return (file, args) =>
    file === 'az' &&
    args[0] === 'staticwebapp' &&
    args[1] === 'environment' &&
    args[2] === 'delete';
}

function cosmosDeleteMatcher() {
  return (file, args) => file === 'az' && args[0] === 'cosmosdb' && args.includes('delete');
}

// --- parseCliOptions --------------------------------------------------

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
    skipEnv: '',
    dryRun: false,
    pairedCosmos: true,
  });
});

test('parseCliOptions accepts space-separated flag values', () => {
  // PR #329 review: `--swa-name foo` previously hit the "Missing required
  // flag" path; now mirrors the `--swa-name=foo` form.
  const options = parseCliOptions(['--swa-name', 'swa-x', '--rg', 'rg-x']);
  assert.equal(options.swaName, 'swa-x');
  assert.equal(options.resourceGroup, 'rg-x');
});

test('parseCliOptions throws when --swa-name has no value (bare flag at end)', () => {
  assert.throws(() => parseCliOptions(['--rg=rg-x', '--swa-name']), /Missing value for --swa-name/);
});

test('parseCliOptions throws when --swa-name is missing entirely', () => {
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

test('parseCliOptions rejects empty --skip-env value', () => {
  assert.throws(
    () => parseCliOptions(['--swa-name=swa-x', '--rg=rg-x', '--skip-env=']),
    /Empty value.*--skip-env/,
  );
});

test('parseCliOptions accepts --skip-env=<n>', () => {
  const options = parseCliOptions(['--swa-name=swa-x', '--rg=rg-x', '--skip-env=329']);
  assert.equal(options.skipEnv, '329');
});

// --- isStaleEnvName / pickCullable -----------------------------------

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
  const decision = pickCullable('default', null);
  assert.equal(decision.action, 'skip');
});

test('pickCullable returns SKIP when env is in skipSet', () => {
  const decision = pickCullable('329', { ok: true, state: 'OPEN' }, new Set(['329']));
  assert.equal(decision.action, 'skip');
  assert.match(decision.reason, /--skip-env/);
});

test('pickCullable returns KEEP for OPEN PRs', () => {
  const decision = pickCullable('268', { ok: true, state: 'OPEN' });
  assert.equal(decision.action, 'keep');
  assert.match(decision.reason, /OPEN/);
});

test('pickCullable returns CULL for CLOSED PRs', () => {
  const decision = pickCullable('268', { ok: true, state: 'CLOSED' });
  assert.equal(decision.action, 'cull');
  assert.match(decision.reason, /CLOSED/);
});

test('pickCullable returns CULL for MERGED PRs', () => {
  const decision = pickCullable('317', { ok: true, state: 'MERGED' });
  assert.equal(decision.action, 'cull');
  assert.match(decision.reason, /MERGED/);
});

test('pickCullable returns KEEP defensively when PR does not exist (definitive not-found)', () => {
  const decision = pickCullable('999', {
    ok: false,
    transient: false,
    reason: 'PR #999 does not exist on this repo (anomalous; keeping env defensively)',
  });
  assert.equal(decision.action, 'keep');
  assert.match(decision.reason, /does not exist/);
});

test('pickCullable returns FAIL on transient gh failure', () => {
  const decision = pickCullable('268', {
    ok: false,
    transient: true,
    reason: 'gh pr view 268 failed (exit 1): network error',
  });
  assert.equal(decision.action, 'fail');
  assert.match(decision.reason, /network error/);
});

test('pickCullable returns KEEP on unrecognized PR state', () => {
  const decision = pickCullable('268', { ok: true, state: 'DRAFT' });
  assert.equal(decision.action, 'keep');
  assert.match(decision.reason, /unrecognized/);
});

// --- getPrState ------------------------------------------------------

test('getPrState returns ok=true with state on gh success', () => {
  const { runner } = makeRunner([
    {
      match: ghPrViewMatcher(268),
      response: { status: 0, stdout: JSON.stringify({ state: 'CLOSED' }) },
    },
  ]);
  const result = getPrState(268, runner);
  assert.deepEqual(result, { ok: true, state: 'CLOSED' });
});

test('getPrState returns ok=false transient=false on definitive not-found', () => {
  const { runner } = makeRunner([
    {
      match: ghPrViewMatcher(999),
      response: {
        status: 1,
        stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 999.',
      },
    },
  ]);
  const result = getPrState(999, runner);
  assert.equal(result.ok, false);
  assert.equal(result.transient, false);
  assert.match(result.reason, /does not exist/);
});

test('getPrState returns ok=false transient=true on network failure', () => {
  const { runner } = makeRunner([
    {
      match: ghPrViewMatcher(268),
      response: { status: 1, stderr: 'connection refused' },
    },
  ]);
  const result = getPrState(268, runner);
  assert.equal(result.ok, false);
  assert.equal(result.transient, true);
  assert.match(result.reason, /connection refused/);
});

test('getPrState returns ok=false transient=true on malformed JSON', () => {
  const { runner } = makeRunner([
    {
      match: ghPrViewMatcher(268),
      response: { status: 0, stdout: 'not-json{' },
    },
  ]);
  const result = getPrState(268, runner);
  assert.equal(result.ok, false);
  assert.equal(result.transient, true);
  assert.match(result.reason, /invalid JSON/);
});

test('getPrState returns ok=false transient=true on unrecognized state', () => {
  const { runner } = makeRunner([
    {
      match: ghPrViewMatcher(268),
      response: { status: 0, stdout: JSON.stringify({ state: 'DRAFT' }) },
    },
  ]);
  const result = getPrState(268, runner);
  assert.equal(result.ok, false);
  assert.equal(result.transient, true);
  assert.match(result.reason, /unexpected JSON/);
});

// --- cullStalePreviews -----------------------------------------------

test('cullStalePreviews keeps OPEN PRs, culls CLOSED/MERGED PRs, skips default', async () => {
  const swaListOutput = ['default', '268', '299', '317'].join('\n');
  const { runner, calls } = makeRunner([
    {
      match: ghPrViewMatcher(268),
      response: { status: 0, stdout: JSON.stringify({ state: 'CLOSED' }) },
    },
    {
      match: ghPrViewMatcher(299),
      response: { status: 0, stdout: JSON.stringify({ state: 'OPEN' }) },
    },
    {
      match: ghPrViewMatcher(317),
      response: { status: 0, stdout: JSON.stringify({ state: 'MERGED' }) },
    },
    { match: swaListMatcher(), response: { status: 0, stdout: swaListOutput } },
    { match: swaDeleteMatcher(), response: { status: 0, stdout: '' } },
    { match: cosmosDeleteMatcher(), response: { status: 0, stdout: '' } },
  ]);

  const logger = silentLogger();
  const summaryEntries = [];
  const result = await cullStalePreviews({
    options: {
      swaName: SWA_NAME,
      resourceGroup: RESOURCE_GROUP,
      cosmosAccount: COSMOS_ACCOUNT,
      skipEnv: '',
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

  assert.deepEqual(result, {
    culled: 2,
    kept: 1,
    skipped: 1,
    failed: 0,
    systemicFailure: false,
  });
  const deleteCalls = calls.filter((c) => c.file === 'az' && c.args[2] === 'delete');
  assert.equal(deleteCalls.length, 2);
  const cosmosCalls = calls.filter((c) => c.file === 'az' && c.args[0] === 'cosmosdb');
  assert.equal(cosmosCalls.length, 2);
  assert.equal(summaryEntries.length, 1);
  assert.match(summaryEntries[0].content, /culled=2 kept=1 skipped=1 failed=0/);
});

test('cullStalePreviews honors --skip-env (current PR own env)', async () => {
  // Scenario: cd-preview is deploying PR #329, which has just been
  // closed (race). Without --skip-env, cull would delete its own env
  // mid-deploy. With --skip-env=329, the deploy's own env is skipped.
  const swaListOutput = ['default', '268', '329'].join('\n');
  const { runner, calls } = makeRunner([
    {
      match: ghPrViewMatcher(268),
      response: { status: 0, stdout: JSON.stringify({ state: 'CLOSED' }) },
    },
    { match: swaListMatcher(), response: { status: 0, stdout: swaListOutput } },
    { match: swaDeleteMatcher(), response: { status: 0, stdout: '' } },
  ]);

  const result = await cullStalePreviews({
    options: {
      swaName: SWA_NAME,
      resourceGroup: RESOURCE_GROUP,
      cosmosAccount: COSMOS_ACCOUNT,
      skipEnv: '329',
      dryRun: false,
      pairedCosmos: false,
    },
    logger: silentLogger(),
    env: {},
    runner,
  });

  // Only 268 evaluated; 329 skipped, default skipped.
  assert.deepEqual(result, {
    culled: 1,
    kept: 0,
    skipped: 2,
    failed: 0,
    systemicFailure: false,
  });
  // Critical assertion: no `gh pr view 329` call ever happens.
  const view329 = calls.filter((c) => c.file === 'gh' && c.args[0] === 'pr' && c.args[2] === '329');
  assert.equal(view329.length, 0);
});

test('cullStalePreviews dry-run does not call delete commands', async () => {
  const swaListOutput = '268\n';
  const { runner, calls } = makeRunner([
    {
      match: ghPrViewMatcher(268),
      response: { status: 0, stdout: JSON.stringify({ state: 'CLOSED' }) },
    },
    { match: swaListMatcher(), response: { status: 0, stdout: swaListOutput } },
  ]);

  const result = await cullStalePreviews({
    options: {
      swaName: SWA_NAME,
      resourceGroup: RESOURCE_GROUP,
      cosmosAccount: COSMOS_ACCOUNT,
      skipEnv: '',
      dryRun: true,
      pairedCosmos: true,
    },
    logger: silentLogger(),
    env: {},
    runner,
  });

  assert.deepEqual(result, {
    culled: 1,
    kept: 0,
    skipped: 0,
    failed: 0,
    systemicFailure: false,
  });
  const deleteCalls = calls.filter((c) => c.args.includes('delete'));
  assert.equal(deleteCalls.length, 0);
});

test('cullStalePreviews counts SWA delete failure and emits warning', async () => {
  const swaListOutput = '268\n';
  const { runner } = makeRunner([
    {
      match: ghPrViewMatcher(268),
      response: { status: 0, stdout: JSON.stringify({ state: 'CLOSED' }) },
    },
    { match: swaListMatcher(), response: { status: 0, stdout: swaListOutput } },
    { match: swaDeleteMatcher(), response: { status: 1, stderr: 'transient azure error' } },
  ]);

  const logger = silentLogger();
  const result = await cullStalePreviews({
    options: {
      swaName: SWA_NAME,
      resourceGroup: RESOURCE_GROUP,
      cosmosAccount: COSMOS_ACCOUNT,
      skipEnv: '',
      dryRun: false,
      pairedCosmos: false,
    },
    logger,
    env: {},
    runner,
  });

  // Note: when SWA delete fails, this counts as both 0 culled and
  // 1 failed; since culled+kept===0 and failed>0, this trips
  // systemicFailure (only one numeric env, all attempts failed).
  assert.deepEqual(result, {
    culled: 0,
    kept: 0,
    skipped: 0,
    failed: 1,
    systemicFailure: true,
  });
  assert.ok(
    logger.messages.some((m) => m.includes('::warning::')),
    'expected ::warning:: annotation on failure',
  );
});

test('cullStalePreviews treats already-absent SWA env as success', async () => {
  const swaListOutput = '268\n';
  const { runner } = makeRunner([
    {
      match: ghPrViewMatcher(268),
      response: { status: 0, stdout: JSON.stringify({ state: 'CLOSED' }) },
    },
    { match: swaListMatcher(), response: { status: 0, stdout: swaListOutput } },
    {
      match: swaDeleteMatcher(),
      response: { status: 1, stderr: 'ResourceNotFound: env does not exist' },
    },
  ]);

  const result = await cullStalePreviews({
    options: {
      swaName: SWA_NAME,
      resourceGroup: RESOURCE_GROUP,
      cosmosAccount: COSMOS_ACCOUNT,
      skipEnv: '',
      dryRun: false,
      pairedCosmos: false,
    },
    logger: silentLogger(),
    env: {},
    runner,
  });

  assert.deepEqual(result, {
    culled: 1,
    kept: 0,
    skipped: 0,
    failed: 0,
    systemicFailure: false,
  });
});

test('cullStalePreviews keeps env defensively when gh reports PR not found', async () => {
  // Anomalous: SWA env named "999" but no PR #999 on the repo. We err
  // toward KEEP rather than risk deleting an env that was created
  // outside our naming convention.
  const swaListOutput = '999\n';
  const { runner } = makeRunner([
    {
      match: ghPrViewMatcher(999),
      response: {
        status: 1,
        stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 999.',
      },
    },
    { match: swaListMatcher(), response: { status: 0, stdout: swaListOutput } },
  ]);

  const result = await cullStalePreviews({
    options: {
      swaName: SWA_NAME,
      resourceGroup: RESOURCE_GROUP,
      cosmosAccount: COSMOS_ACCOUNT,
      skipEnv: '',
      dryRun: false,
      pairedCosmos: false,
    },
    logger: silentLogger(),
    env: {},
    runner,
  });

  assert.deepEqual(result, {
    culled: 0,
    kept: 1,
    skipped: 0,
    failed: 0,
    systemicFailure: false,
  });
});

test('cullStalePreviews single transient gh failure among many is partial (not systemic)', async () => {
  // 268 closed, 299 transient gh failure, 317 merged - mix of
  // successes and one transient failure. Cull proceeds for 268+317;
  // 299 counted as failed. systemicFailure stays false because we have
  // conclusive answers (culled+kept > 0).
  const swaListOutput = '268\n299\n317\n';
  const { runner } = makeRunner([
    {
      match: ghPrViewMatcher(268),
      response: { status: 0, stdout: JSON.stringify({ state: 'CLOSED' }) },
    },
    {
      match: ghPrViewMatcher(299),
      response: { status: 1, stderr: 'connection refused' },
    },
    {
      match: ghPrViewMatcher(317),
      response: { status: 0, stdout: JSON.stringify({ state: 'MERGED' }) },
    },
    { match: swaListMatcher(), response: { status: 0, stdout: swaListOutput } },
    { match: swaDeleteMatcher(), response: { status: 0, stdout: '' } },
  ]);

  const result = await cullStalePreviews({
    options: {
      swaName: SWA_NAME,
      resourceGroup: RESOURCE_GROUP,
      cosmosAccount: COSMOS_ACCOUNT,
      skipEnv: '',
      dryRun: false,
      pairedCosmos: false,
    },
    logger: silentLogger(),
    env: {},
    runner,
  });

  assert.deepEqual(result, {
    culled: 2,
    kept: 0,
    skipped: 0,
    failed: 1,
    systemicFailure: false,
  });
});

test('cullStalePreviews flags systemicFailure when every gh query fails', async () => {
  // All gh pr view calls fail transiently - likely auth issue. Tally
  // is 0 culled, 0 kept, N failed; the caller can use systemicFailure
  // to exit non-zero so the cron run is loudly red.
  const swaListOutput = '268\n299\n';
  const { runner } = makeRunner([
    {
      match: ghPrViewMatcher(268),
      response: { status: 4, stderr: 'gh: error: not authenticated' },
    },
    {
      match: ghPrViewMatcher(299),
      response: { status: 4, stderr: 'gh: error: not authenticated' },
    },
    { match: swaListMatcher(), response: { status: 0, stdout: swaListOutput } },
  ]);

  const result = await cullStalePreviews({
    options: {
      swaName: SWA_NAME,
      resourceGroup: RESOURCE_GROUP,
      cosmosAccount: COSMOS_ACCOUNT,
      skipEnv: '',
      dryRun: false,
      pairedCosmos: false,
    },
    logger: silentLogger(),
    env: {},
    runner,
  });

  assert.deepEqual(result, {
    culled: 0,
    kept: 0,
    skipped: 0,
    failed: 2,
    systemicFailure: true,
  });
});

test('cullStalePreviews throws hard when az env list fails', async () => {
  const { runner } = makeRunner([
    {
      match: swaListMatcher(),
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
          skipEnv: '',
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
  const swaListOutput = '268\n';
  const { runner, calls } = makeRunner([
    {
      match: ghPrViewMatcher(268),
      response: { status: 0, stdout: JSON.stringify({ state: 'CLOSED' }) },
    },
    { match: swaListMatcher(), response: { status: 0, stdout: swaListOutput } },
    { match: swaDeleteMatcher(), response: { status: 0, stdout: '' } },
  ]);

  const result = await cullStalePreviews({
    options: {
      swaName: SWA_NAME,
      resourceGroup: RESOURCE_GROUP,
      cosmosAccount: COSMOS_ACCOUNT,
      skipEnv: '',
      dryRun: false,
      pairedCosmos: false,
    },
    logger: silentLogger(),
    env: {},
    runner,
  });

  assert.deepEqual(result, {
    culled: 1,
    kept: 0,
    skipped: 0,
    failed: 0,
    systemicFailure: false,
  });
  const cosmosCalls = calls.filter((c) => c.file === 'az' && c.args[0] === 'cosmosdb');
  assert.equal(cosmosCalls.length, 0);
});

test('cullStalePreviews counts SWA-deleted-but-Cosmos-failed as partial failure', async () => {
  const swaListOutput = '268\n';
  const { runner } = makeRunner([
    {
      match: ghPrViewMatcher(268),
      response: { status: 0, stdout: JSON.stringify({ state: 'CLOSED' }) },
    },
    { match: swaListMatcher(), response: { status: 0, stdout: swaListOutput } },
    { match: swaDeleteMatcher(), response: { status: 0, stdout: '' } },
    {
      match: cosmosDeleteMatcher(),
      response: { status: 1, stderr: 'cosmos transient error' },
    },
  ]);

  const result = await cullStalePreviews({
    options: {
      swaName: SWA_NAME,
      resourceGroup: RESOURCE_GROUP,
      cosmosAccount: COSMOS_ACCOUNT,
      skipEnv: '',
      dryRun: false,
      pairedCosmos: true,
    },
    logger: silentLogger(),
    env: {},
    runner,
  });

  // SWA delete succeeded but Cosmos failed -> not counted as culled,
  // counted as failed. Only numeric env tried, no conclusive answer
  // (no culled, no kept), so this is also systemic in this minimal
  // test fixture.
  assert.deepEqual(result, {
    culled: 0,
    kept: 0,
    skipped: 0,
    failed: 1,
    systemicFailure: true,
  });
});
