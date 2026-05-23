#!/usr/bin/env node
// scripts/migrate-region.mjs
//
// Region migration cutover runbook. Idempotent, fails loudly.
//
// Phases of the cutover. Preflight checks (Node version, paramfile
// readability, App Insights paramfile-pair contract, and -- when an
// az-using phase is requested -- az CLI authentication, plus
// azcopy-on-PATH when --azcopy-blobs is requested) always run first
// as an implicit safety gate. The --preflight flag means "run only
// the preflight checks; do nothing else" -- preflight runs whether
// or not this flag is passed.
//
// Operational phase flags (each is independent; combine as needed):
//   --preflight        Run only the preflight checks; do nothing else.
//   --predelete-cosmos Delete the Phase-1-created cosmos-jotjson-prod
//                      and any rehearse account. Polls until names freed.
//   --restore-cosmos   Invoke az cosmosdb restore against the captured
//                      freeze-instant timestamp (--restore-timestamp).
//                      Validates the timestamp >= earliest-restorable.
//   --regrant-cosmos-role
//                      Re-run swaCosmosRole Bicep module against the
//                      restored account, using the new SWA's
//                      identity.principalId.
//   --azcopy-blobs     Run azcopy sync for avatars, exports, sourcemaps.
//   --verify-sha       Invoke scripts/check-deploy-freshness.mjs to
//                      verify the new SWA serves the expected SHA.
//
// Required environment / args:
//   --src-account / --dst-account  Cosmos account names (old/new).
//   --src-storage / --dst-storage  Storage account names.
//   --src-rg / --dst-rg            Resource group names.
//   --restore-timestamp <ISO8601>  Required for --restore-cosmos.
//   --expected-sha <git-sha>       Required for --verify-sha.
//   --new-swa-hostname <host>      Required for --verify-sha.
//   --paramfile <path>             prod.bicepparam for pre-flight check.
//                                  Relative paths resolve against the
//                                  repository root (not CWD).
//
// Additional phase-specific args:
//   --new-swa-name <name>          Required for --regrant-cosmos-role.
//   --rehearsal-pinned-minutes <n> Required for --restore-cosmos warning
//                                  threshold (warn at 2x runtime).
//
// Abort procedure (in-window, before apex rebind):
//   - Cosmos PITR cannot be cancelled once it starts. If you abort after
//     PITR begins, let the restore finish, keep or restore traffic on the
//     OLD SWA, then delete the orphaned restored account during cleanup.
//   - If cutover fails before apex rebind, restore the OLD SWA deploy
//     token, re-run the old deployment if needed, and leave the new stack
//     running for operator cleanup.
//
// Exits non-zero on any error. All operations log to stderr; structured
// progress events to stdout (JSONL).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const REPO_ROOT = resolve(__dirname, '..');
const CHECK_DEPLOY_FRESHNESS = resolve(REPO_ROOT, 'scripts', 'check-deploy-freshness.mjs');
const MAIN_BICEP = resolve(REPO_ROOT, 'infra', 'main.bicep');
const MIN_NODE_MAJOR = 24;
const PREDELETE_POLL_INTERVAL_MS = 30_000;
const PREDELETE_TIMEOUT_MS = 45 * 60 * 1_000;
const RESTORE_POLL_INTERVAL_MS = 30_000;
const REHEARSE_SUFFIX = '-rehearse';
export const BLOB_CONTAINERS = Object.freeze(['avatars', 'exports', 'sourcemaps']);

const USAGE = `Usage:
  node scripts/migrate-region.mjs --preflight --paramfile <path>
  node scripts/migrate-region.mjs --predelete-cosmos --dst-account <name> --dst-rg <rg> --paramfile <path>
  node scripts/migrate-region.mjs --restore-cosmos --src-account <name> --src-rg <rg> --dst-account <name> --dst-rg <rg> --restore-timestamp <ISO8601> --rehearsal-pinned-minutes <minutes> --paramfile <path>
  node scripts/migrate-region.mjs --regrant-cosmos-role --new-swa-name <name> --dst-rg <rg> --paramfile <path>
  node scripts/migrate-region.mjs --azcopy-blobs --src-storage <name> --dst-storage <name> --paramfile <path>
  node scripts/migrate-region.mjs --verify-sha --new-swa-hostname <host> --expected-sha <sha> --paramfile <path>

Flags:
  --help
  --preflight
  --predelete-cosmos
  --restore-cosmos
  --regrant-cosmos-role
  --azcopy-blobs
  --verify-sha
  --src-account <name>
  --dst-account <name>
  --src-storage <name>
  --dst-storage <name>
  --src-rg <name>
  --dst-rg <name>
  --restore-timestamp <ISO8601>
  --expected-sha <git-sha>
  --new-swa-hostname <host>
  --new-swa-name <name>
  --rehearsal-pinned-minutes <minutes>
  --paramfile <path>

Notes:
  - Relative --paramfile paths resolve against the repository root,
    not the current working directory. Absolute paths are honored.
  - Preflight checks run unconditionally as a safety gate before any
    other phase; --preflight by itself means "preflight only."

Abort notes:
  - PITR cannot be cancelled once az cosmosdb restore starts.
  - If restore runtime exceeds 2x the rehearsal-pinned estimate, the script
    warns and keeps polling; the operator decides whether to abort the window.
  - If you abort before apex rebind, restore the OLD SWA deploy token and
    keep traffic on the OLD SWA while the new stack is cleaned up.
`;

const CLI_OPTIONS = {
  help: { type: 'boolean' },
  preflight: { type: 'boolean' },
  'predelete-cosmos': { type: 'boolean' },
  'restore-cosmos': { type: 'boolean' },
  'regrant-cosmos-role': { type: 'boolean' },
  'azcopy-blobs': { type: 'boolean' },
  'verify-sha': { type: 'boolean' },
  'src-account': { type: 'string' },
  'dst-account': { type: 'string' },
  'src-storage': { type: 'string' },
  'dst-storage': { type: 'string' },
  'src-rg': { type: 'string' },
  'dst-rg': { type: 'string' },
  'restore-timestamp': { type: 'string' },
  'expected-sha': { type: 'string' },
  'new-swa-hostname': { type: 'string' },
  'new-swa-name': { type: 'string' },
  'rehearsal-pinned-minutes': { type: 'string' },
  paramfile: { type: 'string' },
};

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveRepoRelativePath(pathValue) {
  if (!pathValue) return '';
  return resolve(REPO_ROOT, pathValue);
}

function stderrLine(message, runtime = defaultRuntime()) {
  runtime.stderr.write(`migrate-region: ${message}\n`);
}

function emitProgress(event, fields = {}, runtime = defaultRuntime()) {
  runtime.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields })}\n`,
  );
}

function commandToString(file, args) {
  return [file, ...args].join(' ');
}

export function getBlobContainers() {
  return [...BLOB_CONTAINERS];
}

export function getCosmosAccountsToDelete(dstAccount) {
  return [dstAccount, `${dstAccount}${REHEARSE_SUFFIX}`];
}

export function parseAppInsightsPairFromText(paramFileText) {
  const nameMatch = /^\s*param\s+existingAppInsightsName\s*=\s*'([^']*)'\s*$/m.exec(paramFileText);
  const rgMatch = /^\s*param\s+existingAppInsightsRg\s*=\s*'([^']*)'\s*$/m.exec(paramFileText);
  const name = nameMatch?.[1] ?? null;
  const resourceGroup = rgMatch?.[1] ?? null;
  const nameIsSet = trimString(name ?? '') !== '';
  const resourceGroupIsSet = trimString(resourceGroup ?? '') !== '';
  return {
    name,
    resourceGroup,
    nameIsSet,
    resourceGroupIsSet,
  };
}

export function assertAppInsightsPair(pair) {
  if (pair.nameIsSet !== pair.resourceGroupIsSet) {
    throw new Error(
      'Paramfile contract violated: existingAppInsightsName and existingAppInsightsRg must be both set or both empty.',
    );
  }
}

export function assertNodeVersion(nodeVersion = process.versions.node) {
  const major = Number.parseInt(String(nodeVersion).split('.')[0] ?? '', 10);
  if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) {
    throw new Error(
      `Node ${MIN_NODE_MAJOR}+ is required by package.json engines; found ${JSON.stringify(nodeVersion)}.`,
    );
  }
}

export function parseIsoTimestamp(value, label) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${label} ${JSON.stringify(value)}. Expected an ISO8601 timestamp.`);
  }
  return parsed;
}

export function validateRestoreTimestamp(restoreTimestamp, earliestRestorableTimestamp) {
  const requestedAt = parseIsoTimestamp(restoreTimestamp, '--restore-timestamp');
  const earliestAt = parseIsoTimestamp(earliestRestorableTimestamp, 'earliest-restorable-time');
  if (requestedAt.getTime() < earliestAt.getTime()) {
    throw new Error(
      `Restore timestamp ${requestedAt.toISOString()} is earlier than earliest-restorable-time ${earliestAt.toISOString()}.`,
    );
  }
  return {
    requestedAt,
    earliestAt,
  };
}

export function normalizeHostname(hostname) {
  const raw = trimString(hostname);
  if (!raw) return '';
  if (/^http:\/\//i.test(raw)) {
    throw new Error(
      `Invalid --new-swa-hostname ${JSON.stringify(hostname)}: explicit http:// scheme not allowed; use https:// or omit the scheme.`,
    );
  }
  const hasHttpsScheme = /^https:\/\//i.test(raw);
  const toParse = hasHttpsScheme ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(toParse);
  } catch {
    throw new Error(
      `Invalid --new-swa-hostname ${JSON.stringify(hostname)}: not a valid hostname.`,
    );
  }
  if (!parsed.hostname) {
    throw new Error(`Invalid --new-swa-hostname ${JSON.stringify(hostname)}: hostname is empty.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      `Invalid --new-swa-hostname ${JSON.stringify(hostname)}: userinfo (user:pass@) is not allowed.`,
    );
  }
  if (parsed.pathname && parsed.pathname !== '/') {
    throw new Error(
      `Invalid --new-swa-hostname ${JSON.stringify(hostname)}: path components are not allowed.`,
    );
  }
  if (parsed.search) {
    throw new Error(
      `Invalid --new-swa-hostname ${JSON.stringify(hostname)}: query string is not allowed.`,
    );
  }
  if (parsed.hash) {
    throw new Error(
      `Invalid --new-swa-hostname ${JSON.stringify(hostname)}: fragment is not allowed.`,
    );
  }
  return parsed.host;
}

function parsePositiveInteger(value, label) {
  const raw = trimString(value);
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${label} ${JSON.stringify(value)}. Expected a positive integer.`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed <= 0) {
    throw new Error(`Invalid ${label} ${JSON.stringify(value)}. Expected a positive integer.`);
  }
  return parsed;
}

function requireFlagValue(value, label, reason) {
  if (!value) {
    throw new Error(`Missing required flag ${label}${reason ? ` (${reason})` : ''}.`);
  }
}

export function parseCliOptions(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: CLI_OPTIONS,
    strict: true,
    allowPositionals: false,
  });

  const options = {
    help: values.help === true,
    preflight: values.preflight === true,
    predeleteCosmos: values['predelete-cosmos'] === true,
    restoreCosmos: values['restore-cosmos'] === true,
    regrantCosmosRole: values['regrant-cosmos-role'] === true,
    azcopyBlobs: values['azcopy-blobs'] === true,
    verifySha: values['verify-sha'] === true,
    srcAccount: trimString(values['src-account']),
    dstAccount: trimString(values['dst-account']),
    srcStorage: trimString(values['src-storage']),
    dstStorage: trimString(values['dst-storage']),
    srcRg: trimString(values['src-rg']),
    dstRg: trimString(values['dst-rg']),
    restoreTimestamp: trimString(values['restore-timestamp']),
    expectedSha: trimString(values['expected-sha']),
    newSwaHostname: normalizeHostname(values['new-swa-hostname']),
    newSwaName: trimString(values['new-swa-name']),
    rehearsalPinnedMinutes: parsePositiveInteger(
      values['rehearsal-pinned-minutes'],
      '--rehearsal-pinned-minutes',
    ),
    paramfile: resolveRepoRelativePath(trimString(values.paramfile)),
  };

  if (options.help) {
    return options;
  }

  const hasOperationalPhase =
    options.predeleteCosmos ||
    options.restoreCosmos ||
    options.regrantCosmosRole ||
    options.azcopyBlobs ||
    options.verifySha;

  if (!options.preflight && !hasOperationalPhase) {
    throw new Error(
      'Choose at least one phase flag: --preflight, --predelete-cosmos, --restore-cosmos, --regrant-cosmos-role, --azcopy-blobs, or --verify-sha.',
    );
  }

  requireFlagValue(options.paramfile, '--paramfile=<path>', 'required for pre-flight validation');

  if (options.predeleteCosmos) {
    requireFlagValue(
      options.dstAccount,
      '--dst-account=<name>',
      'required with --predelete-cosmos',
    );
    requireFlagValue(options.dstRg, '--dst-rg=<name>', 'required with --predelete-cosmos');
  }

  if (options.restoreCosmos) {
    requireFlagValue(options.srcAccount, '--src-account=<name>', 'required with --restore-cosmos');
    requireFlagValue(options.srcRg, '--src-rg=<name>', 'required with --restore-cosmos');
    requireFlagValue(options.dstAccount, '--dst-account=<name>', 'required with --restore-cosmos');
    requireFlagValue(options.dstRg, '--dst-rg=<name>', 'required with --restore-cosmos');
    requireFlagValue(
      options.restoreTimestamp,
      '--restore-timestamp=<ISO8601>',
      'required with --restore-cosmos',
    );
    if (options.rehearsalPinnedMinutes === null) {
      throw new Error(
        'Missing required flag --rehearsal-pinned-minutes=<minutes> (required with --restore-cosmos).',
      );
    }
  }

  if (options.regrantCosmosRole) {
    requireFlagValue(
      options.newSwaName,
      '--new-swa-name=<name>',
      'required with --regrant-cosmos-role',
    );
    requireFlagValue(options.dstRg, '--dst-rg=<name>', 'required with --regrant-cosmos-role');
  }

  if (options.azcopyBlobs) {
    requireFlagValue(options.srcStorage, '--src-storage=<name>', 'required with --azcopy-blobs');
    requireFlagValue(options.dstStorage, '--dst-storage=<name>', 'required with --azcopy-blobs');
  }

  if (options.verifySha) {
    requireFlagValue(
      options.newSwaHostname,
      '--new-swa-hostname=<host>',
      'required with --verify-sha',
    );
    requireFlagValue(options.expectedSha, '--expected-sha=<git-sha>', 'required with --verify-sha');
  }

  return options;
}

export function printUsage(runtime = defaultRuntime()) {
  runtime.stdout.write(USAGE);
}

function buildRuntime(overrides = {}) {
  return {
    commandRunner: runCommand,
    sleep,
    now: () => Date.now(),
    stdout: process.stdout,
    stderr: process.stderr,
    nodeVersion: process.versions.node,
    repoRoot: REPO_ROOT,
    execPath: process.execPath,
    ...overrides,
  };
}

let runtimeSingleton = null;

function defaultRuntime() {
  runtimeSingleton ??= buildRuntime();
  return runtimeSingleton;
}

export function normalizeSpawnResult(rawResult, file, args) {
  if (rawResult.error) {
    throw new Error(`Failed to spawn ${commandToString(file, args)}: ${rawResult.error.message}`);
  }
  if (rawResult.status === null) {
    const signal = rawResult.signal ? ` by signal ${rawResult.signal}` : '';
    throw new Error(`${commandToString(file, args)} terminated${signal} without an exit status.`);
  }
  return {
    status: rawResult.status,
    stdout: rawResult.stdout ?? '',
    stderr: rawResult.stderr ?? '',
  };
}

export function runCommand(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    shell: false,
    cwd: options.cwd ?? REPO_ROOT,
    stdio: options.stdio ?? 'pipe',
  });
  return normalizeSpawnResult(result, file, args);
}

function runChecked(runtime, file, args, options = {}) {
  const result = runtime.commandRunner(file, args, options);
  if (result.status !== 0) {
    const combined = [trimString(result.stderr), trimString(result.stdout)]
      .filter(Boolean)
      .join('\n');
    throw new Error(
      `${commandToString(file, args)} failed with exit ${result.status}${combined ? `:\n${combined}` : '.'}`,
    );
  }
  return result;
}

function phaseBanner(phase, message, runtime) {
  stderrLine(`[${phase}] ${message}`, runtime);
  stderrLine(
    `[${phase}] Abort notes: PITR cannot be cancelled once started; if you abort before apex rebind, restore traffic on the OLD SWA and clean up the new stack afterward.`,
    runtime,
  );
  emitProgress('phase.start', { phase }, runtime);
}

function checkCliAuthentication(runtime) {
  runChecked(runtime, 'az', ['account', 'show', '-o', 'json']);
}

function checkAzcopyOnPath(runtime) {
  runChecked(runtime, 'azcopy', ['--version']);
}

function readParamfile(paramfile) {
  if (!existsSync(paramfile)) {
    throw new Error(`Paramfile not found: ${paramfile}`);
  }
  return readFileSync(paramfile, 'utf8');
}

export async function runPreflight(options, runtime = defaultRuntime()) {
  phaseBanner('preflight', 'Validating prerequisites. This phase makes no Azure changes.', runtime);
  assertNodeVersion(runtime.nodeVersion);
  stderrLine(`[preflight] node ${runtime.nodeVersion} satisfies >=${MIN_NODE_MAJOR}.`, runtime);
  const paramFileText = readParamfile(options.paramfile);
  const pair = parseAppInsightsPairFromText(paramFileText);
  assertAppInsightsPair(pair);
  stderrLine(
    `[preflight] existingAppInsights pair is ${pair.nameIsSet ? 'both set' : 'both empty or absent'}.`,
    runtime,
  );
  const azRequired = options.predeleteCosmos || options.restoreCosmos || options.regrantCosmosRole;
  if (azRequired) {
    checkCliAuthentication(runtime);
    stderrLine('[preflight] az CLI is installed and authenticated.', runtime);
  }
  if (options.azcopyBlobs) {
    checkAzcopyOnPath(runtime);
    stderrLine('[preflight] azcopy is installed.', runtime);
  }
  emitProgress(
    'phase.complete',
    {
      phase: 'preflight',
      paramfile: options.paramfile,
      azRequired,
      azcopyRequired: options.azcopyBlobs,
    },
    runtime,
  );
}

function parseBooleanTsv(rawValue, label) {
  const normalized = trimString(rawValue).toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`Unexpected boolean output for ${label}: ${JSON.stringify(rawValue)}.`);
}

function cosmosNameExists(accountName, runtime) {
  const result = runChecked(runtime, 'az', [
    'cosmosdb',
    'check-name-exists',
    '-n',
    accountName,
    '--query',
    'nameExists',
    '-o',
    'tsv',
  ]);
  return parseBooleanTsv(result.stdout, `az cosmosdb check-name-exists -n ${accountName}`);
}

export async function waitForCosmosNamesFreed(
  accountNames,
  runtime = defaultRuntime(),
  timeoutMs = PREDELETE_TIMEOUT_MS,
  pollIntervalMs = PREDELETE_POLL_INTERVAL_MS,
) {
  const startedAtMs = runtime.now();
  while (true) {
    const nameStates = accountNames.map((name) => ({
      name,
      exists: cosmosNameExists(name, runtime),
    }));
    for (const nameState of nameStates) {
      emitProgress(
        'cosmos.name-state',
        { phase: 'predelete-cosmos', name: nameState.name, exists: nameState.exists },
        runtime,
      );
    }
    if (nameStates.every((nameState) => !nameState.exists)) {
      return;
    }
    const elapsedMs = runtime.now() - startedAtMs;
    if (elapsedMs >= timeoutMs) {
      const stillAllocated = nameStates
        .filter((nameState) => nameState.exists)
        .map((nameState) => nameState.name);
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for Cosmos names to free: ${stillAllocated.join(', ')}.`,
      );
    }
    stderrLine(
      `[predelete-cosmos] Names still allocated: ${nameStates
        .filter((nameState) => nameState.exists)
        .map((nameState) => nameState.name)
        .join(', ')}. Waiting ${pollIntervalMs / 1000}s before the next poll.`,
      runtime,
    );
    await runtime.sleep(pollIntervalMs);
  }
}

export async function runPredeleteCosmos(options, runtime = defaultRuntime()) {
  phaseBanner(
    'predelete-cosmos',
    'Deleting the destination Cosmos account and its rehearse twin (if present), then waiting for the global names to free.',
    runtime,
  );
  const accountNames = getCosmosAccountsToDelete(options.dstAccount);
  for (const accountName of accountNames) {
    const exists = cosmosNameExists(accountName, runtime);
    if (!exists) {
      stderrLine(`[predelete-cosmos] ${accountName} is already free; skipping delete.`, runtime);
      emitProgress('cosmos.delete-skip', { phase: 'predelete-cosmos', name: accountName }, runtime);
      continue;
    }
    stderrLine(
      `[predelete-cosmos] Starting delete for ${accountName} in ${options.dstRg}.`,
      runtime,
    );
    runChecked(runtime, 'az', [
      'cosmosdb',
      'delete',
      '-n',
      accountName,
      '-g',
      options.dstRg,
      '--yes',
      '--no-wait',
    ]);
    emitProgress(
      'cosmos.delete-started',
      { phase: 'predelete-cosmos', name: accountName },
      runtime,
    );
  }
  await waitForCosmosNamesFreed(accountNames, runtime);
  stderrLine('[predelete-cosmos] Both Cosmos names are free.', runtime);
  emitProgress('phase.complete', { phase: 'predelete-cosmos' }, runtime);
}

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function getCosmosShowValue(resourceGroup, accountName, query, runtime) {
  const result = runChecked(runtime, 'az', [
    'cosmosdb',
    'show',
    '-g',
    resourceGroup,
    '-n',
    accountName,
    '--query',
    query,
    '-o',
    'tsv',
  ]);
  return trimString(result.stdout);
}

function getSourceLocation(resourceGroup, accountName, runtime) {
  const directLocation = getCosmosShowValue(resourceGroup, accountName, 'location', runtime);
  if (directLocation) {
    return directLocation;
  }
  const fallbackLocation = getCosmosShowValue(
    resourceGroup,
    accountName,
    'locations[0].locationName',
    runtime,
  );
  if (!fallbackLocation) {
    throw new Error(`Could not determine source location for Cosmos account ${accountName}.`);
  }
  return fallbackLocation;
}

function getDestinationLocation(resourceGroup, runtime) {
  const result = runChecked(runtime, 'az', [
    'group',
    'show',
    '--name',
    resourceGroup,
    '--query',
    'location',
    '-o',
    'tsv',
  ]);
  const location = trimString(result.stdout);
  if (!location) {
    throw new Error(
      `Could not determine destination location for resource group ${resourceGroup}.`,
    );
  }
  return location;
}

export function deriveEarliestRestorable(restorableAccounts, srcAccount) {
  if (!Array.isArray(restorableAccounts) || restorableAccounts.length === 0) {
    throw new Error(`No restorable-database-account entries found for ${srcAccount}.`);
  }
  const timestamps = restorableAccounts
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const creationTime = trimString(entry.creationTime);
      return creationTime || null;
    })
    .filter((value) => value !== null);
  if (timestamps.length === 0) {
    throw new Error(
      `Restorable-database-account entries for ${srcAccount} did not include creationTime.`,
    );
  }
  timestamps.sort();
  return timestamps[0];
}

export function parseAzcopySyncSummary(output) {
  const patterns = [
    /Number of Transfers Completed:\s*(\d+)/i,
    /Files Transferred:\s*(\d+)/i,
    /Number of File Transfers:\s*(\d+)/i,
    /Transfers Completed:\s*(\d+)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(output);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return null;
}

function maybeWarnRestoreOverrun(startedAtMs, rehearsalPinnedMinutes, runtime, alreadyWarned) {
  if (alreadyWarned || rehearsalPinnedMinutes === null) {
    return alreadyWarned;
  }
  const warningThresholdMs = rehearsalPinnedMinutes * 2 * 60 * 1_000;
  if (runtime.now() - startedAtMs < warningThresholdMs) {
    return false;
  }
  stderrLine(
    `[restore-cosmos] WARNING: runtime exceeded 2x the rehearsal-pinned estimate (${rehearsalPinnedMinutes}m -> warn at ${rehearsalPinnedMinutes * 2}m). PITR cannot be cancelled; operator must decide whether to abort the window manually.`,
    runtime,
  );
  emitProgress(
    'restore.warning-threshold',
    {
      phase: 'restore-cosmos',
      rehearsalPinnedMinutes,
      thresholdMinutes: rehearsalPinnedMinutes * 2,
    },
    runtime,
  );
  return true;
}

function readProvisioningState(resourceGroup, accountName, runtime) {
  const result = runtime.commandRunner(
    'az',
    [
      'cosmosdb',
      'show',
      '-g',
      resourceGroup,
      '-n',
      accountName,
      '--query',
      'provisioningState',
      '-o',
      'tsv',
    ],
    {},
  );
  if (result.status === 0) {
    return trimString(result.stdout) || 'Unknown';
  }
  const combined = `${result.stderr}\n${result.stdout}`;
  if (/could not be found|not found|was not found/i.test(combined)) {
    return 'NotFound';
  }
  throw new Error(
    `${commandToString('az', ['cosmosdb', 'show', '-g', resourceGroup, '-n', accountName])} failed with exit ${result.status}: ${trimString(combined)}`,
  );
}

export async function waitForRestoreCompletion(options, runtime = defaultRuntime()) {
  const startedAtMs = runtime.now();
  let warned = false;
  while (true) {
    const provisioningState = readProvisioningState(options.dstRg, options.dstAccount, runtime);
    emitProgress(
      'restore.poll',
      { phase: 'restore-cosmos', account: options.dstAccount, provisioningState },
      runtime,
    );
    if (provisioningState === 'Succeeded') {
      return;
    }
    if (provisioningState === 'Failed') {
      throw new Error(`Cosmos restore for ${options.dstAccount} entered Failed provisioningState.`);
    }
    warned = maybeWarnRestoreOverrun(startedAtMs, options.rehearsalPinnedMinutes, runtime, warned);
    stderrLine(
      `[restore-cosmos] provisioningState=${provisioningState}. Waiting ${RESTORE_POLL_INTERVAL_MS / 1000}s before the next poll.`,
      runtime,
    );
    await runtime.sleep(RESTORE_POLL_INTERVAL_MS);
  }
}

export async function runRestoreCosmos(options, runtime = defaultRuntime()) {
  phaseBanner(
    'restore-cosmos',
    'Starting Cosmos PITR. This phase is irreversible after az cosmosdb restore begins.',
    runtime,
  );
  const backupTier = getCosmosShowValue(
    options.srcRg,
    options.srcAccount,
    'backupPolicy.continuousModeProperties.tier',
    runtime,
  );
  if (!backupTier) {
    throw new Error(
      `Source Cosmos account ${options.srcAccount} does not report a continuous backup tier.`,
    );
  }
  const sourceLocation = getSourceLocation(options.srcRg, options.srcAccount, runtime);
  const destinationLocation = getDestinationLocation(options.dstRg, runtime);
  const restorableAccountsResult = runChecked(runtime, 'az', [
    'cosmosdb',
    'restorable-database-account',
    'list',
    '-l',
    sourceLocation,
    '--query',
    `[?accountName=='${options.srcAccount}'].{creationTime:creationTime}`,
    '-o',
    'json',
  ]);
  const earliestRestorableTime = deriveEarliestRestorable(
    parseJsonOutput(restorableAccountsResult, 'az cosmosdb restorable-database-account list'),
    options.srcAccount,
  );
  validateRestoreTimestamp(options.restoreTimestamp, earliestRestorableTime);

  if (cosmosNameExists(options.dstAccount, runtime)) {
    throw new Error(
      `Destination account name ${options.dstAccount} is still allocated. Run --predelete-cosmos and wait for the namespace to free before PITR.`,
    );
  }

  stderrLine(
    `[restore-cosmos] Source backup tier=${backupTier}; source location=${sourceLocation}; destination location=${destinationLocation}; earliest-restorable-time=${earliestRestorableTime}.`,
    runtime,
  );
  stderrLine(
    '[restore-cosmos] Cosmos PITR cannot be cancelled once invoked. If you abort the cutover, let the restore finish and delete the orphaned account during cleanup.',
    runtime,
  );

  runChecked(runtime, 'az', [
    'cosmosdb',
    'restore',
    '--location',
    destinationLocation,
    '--target-database-account-name',
    options.dstAccount,
    '--account-name',
    options.srcAccount,
    '--restore-timestamp',
    options.restoreTimestamp,
    '--resource-group',
    options.dstRg,
  ]);
  emitProgress(
    'restore.started',
    {
      phase: 'restore-cosmos',
      sourceAccount: options.srcAccount,
      destinationAccount: options.dstAccount,
      restoreTimestamp: options.restoreTimestamp,
      earliestRestorableTime,
      destinationLocation,
    },
    runtime,
  );
  await waitForRestoreCompletion(options, runtime);
  stderrLine(`[restore-cosmos] Restore completed for ${options.dstAccount}.`, runtime);
  emitProgress('phase.complete', { phase: 'restore-cosmos' }, runtime);
}

export async function runRegrantCosmosRole(options, runtime = defaultRuntime()) {
  phaseBanner(
    'regrant-cosmos-role',
    'Reading the new SWA managed identity, then redeploying infra/main.bicep to reconcile swaCosmosRole idempotently.',
    runtime,
  );
  const principalIdResult = runChecked(runtime, 'az', [
    'staticwebapp',
    'show',
    '-n',
    options.newSwaName,
    '-g',
    options.dstRg,
    '--query',
    'identity.principalId',
    '-o',
    'tsv',
  ]);
  const principalId = trimString(principalIdResult.stdout);
  if (!principalId) {
    throw new Error(`Static Web App ${options.newSwaName} does not have identity.principalId.`);
  }
  stderrLine(
    `[regrant-cosmos-role] New SWA principalId=${principalId}. Running full main.bicep redeploy (idempotent) so swaCosmosRole reconciles against the restored account.`,
    runtime,
  );
  runChecked(runtime, 'az', [
    'deployment',
    'group',
    'create',
    '--resource-group',
    options.dstRg,
    '--template-file',
    MAIN_BICEP,
    '--parameters',
    options.paramfile,
  ]);
  emitProgress(
    'phase.complete',
    { phase: 'regrant-cosmos-role', newSwaName: options.newSwaName, principalId },
    runtime,
  );
}

export async function runAzcopyBlobs(options, runtime = defaultRuntime()) {
  phaseBanner('azcopy-blobs', 'Running azcopy sync for avatars, exports, and sourcemaps.', runtime);
  for (const container of getBlobContainers()) {
    const sourceUrl = `https://${options.srcStorage}.blob.core.windows.net/${container}`;
    const destinationUrl = `https://${options.dstStorage}.blob.core.windows.net/${container}`;
    stderrLine(`[azcopy-blobs] Syncing ${container}: ${sourceUrl} -> ${destinationUrl}.`, runtime);
    const result = runChecked(runtime, 'azcopy', [
      'sync',
      sourceUrl,
      destinationUrl,
      '--delete-destination=false',
    ]);
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    const syncedBlobs = parseAzcopySyncSummary(combinedOutput);
    if (syncedBlobs === null) {
      throw new Error(`Could not parse azcopy sync statistics for container ${container}.`);
    }
    stderrLine(`[azcopy-blobs] ${container}: synced ${syncedBlobs} blobs.`, runtime);
    emitProgress(
      'azcopy.container-complete',
      { phase: 'azcopy-blobs', container, syncedBlobs },
      runtime,
    );
  }
  emitProgress('phase.complete', { phase: 'azcopy-blobs' }, runtime);
}

export async function runVerifySha(options, runtime = defaultRuntime()) {
  phaseBanner(
    'verify-sha',
    'Delegating SHA verification to scripts/check-deploy-freshness.mjs. This script does not reimplement that logic.',
    runtime,
  );
  const origin = `https://${options.newSwaHostname}`;
  stderrLine(
    `[verify-sha] Running ${CHECK_DEPLOY_FRESHNESS} against ${origin} for expected SHA ${options.expectedSha}.`,
    runtime,
  );
  const result = runtime.commandRunner(
    runtime.execPath,
    [CHECK_DEPLOY_FRESHNESS, '--origin', origin, '--expected-sha', options.expectedSha],
    {
      cwd: runtime.repoRoot,
      stdio: 'inherit',
    },
  );
  if (result.status !== 0) {
    throw new Error(`check-deploy-freshness.mjs exited with ${result.status}.`);
  }
  emitProgress('phase.complete', { phase: 'verify-sha', origin }, runtime);
}

export async function executeRequestedPhases(options, handlers) {
  await handlers.preflight(options);
  if (options.predeleteCosmos) {
    await handlers.predeleteCosmos(options);
  }
  if (options.restoreCosmos) {
    await handlers.restoreCosmos(options);
  }
  if (options.regrantCosmosRole) {
    await handlers.regrantCosmosRole(options);
  }
  if (options.azcopyBlobs) {
    await handlers.azcopyBlobs(options);
  }
  if (options.verifySha) {
    await handlers.verifySha(options);
  }
}

function buildPhaseHandlers(runtime) {
  return {
    preflight: (options) => runPreflight(options, runtime),
    predeleteCosmos: (options) => runPredeleteCosmos(options, runtime),
    restoreCosmos: (options) => runRestoreCosmos(options, runtime),
    regrantCosmosRole: (options) => runRegrantCosmosRole(options, runtime),
    azcopyBlobs: (options) => runAzcopyBlobs(options, runtime),
    verifySha: (options) => runVerifySha(options, runtime),
  };
}

export async function main(args = process.argv.slice(2), runtimeOverrides = {}) {
  const options = parseCliOptions(args);
  if (options.help) {
    printUsage(buildRuntime(runtimeOverrides));
    return 0;
  }
  const runtime = buildRuntime(runtimeOverrides);
  await executeRequestedPhases(options, buildPhaseHandlers(runtime));
  stderrLine('All requested phases completed successfully.', runtime);
  emitProgress('run.complete', { requestedPhases: args }, runtime);
  return 0;
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
    process.stderr.write(`migrate-region: ${message}\n`);
    process.exit(1);
  });
}
