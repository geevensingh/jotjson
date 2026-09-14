#!/usr/bin/env node
// Application Insights SDK feature-flag gate.
//
// Motivating incident: PR #566. Bumping `@microsoft/applicationinsights-web`
// 3.4.1 -> 3.4.4 crossed 3.4.3, which added a `SdkStats` feature to the SDK's
// default `featureOptIn` map with mode `enable`. Left alone it registers a
// notification listener that reports Item_Success/Dropped/Retry_Count as
// MetricData through `core.track()` -- i.e. onto our own connection string,
// into `customMetrics`, a table our telemetry inventory does not document and
// our frozen messageId catalog does not cover.
//
// Nothing in the repo noticed. The manifest diff was two lines; the behavior
// change was in the dependency's defaults. `src/app/core/telemetry/
// app-insights-config.ts` now opts out explicitly, and its unit test asserts
// that. But that test compares our literal against our literal: it cannot fail
// when a FUTURE SDK release adds the next opt-out-by-default feature, or flips
// an existing default from off to on. The detection surface would be "a human
// reads a changelog", which is exactly what failed here.
//
// AGENTS.md Section 6 states the doctrine for this repo's supply-chain rules:
// prevention and detection ship as a pair ("the group is prevention ...; the
// check-lockfile.mjs assertion is detection"). This gate is the detection half.
//
// It reads the SDK's OWN default map out of the installed
// `dist-es5/AISku.js` -- the same "read the vendor artifact, because the
// dependency graph cannot see this" idiom `check-dependency-overrides.mjs`
// uses against Monaco's prebuilt bundle -- and requires that every feature key
// the SDK defaults has an explicit, justified decision in FEATURE_POLICY
// below. Four things fail the gate:
//
//   A. The SDK defaults a feature we have not classified  -> decide about it.
//   B. FEATURE_POLICY names a feature the SDK no longer    -> policy is stale;
//      defaults (renamed or removed)                          re-verify.
//   C. The SDK changed its default mode for a feature      -> a default may
//                                                              have flipped on.
//   D. A feature we classified 'disable' is not named in   -> the opt-out was
//      app-insights-config.ts                                  dropped.
//
// The gate FAILS CLOSED throughout: a missing file, an unparseable default
// map, or an unresolvable key name all fail loudly rather than silently going
// stale.
//
// Runs with zero dependencies on Node 24+. Invoke directly or via:
//   npm run lint:sdk-feature-optin

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SDK_DEFAULTS_FILE = join(
  REPO_ROOT,
  'node_modules',
  '@microsoft',
  'applicationinsights-web',
  'dist-es5',
  'AISku.js',
);

const APP_CONFIG_FILE = join(
  REPO_ROOT,
  'src',
  'app',
  'core',
  'telemetry',
  'app-insights-config.ts',
);

/**
 * FeatureOptInMode, mirrored from the SDK's ambient const enum. Mirrored
 * rather than imported because it is not exported from the web package and
 * `applicationinsights-core-js` is not a declared dependency.
 */
const MODE_NAMES = Object.freeze({ 1: 'none', 2: 'disable', 3: 'enable' });

/**
 * Every feature key the installed SDK carries in its default `featureOptIn`
 * map needs an entry here.
 *
 * `sdkDefaultMode` records what the SDK defaults TODAY. It is not a
 * preference -- it is a tripwire. When the SDK changes a default, the gate
 * fails and a human decides whether the new default is acceptable.
 *
 * `decision` is what WE do about it:
 *   'disable'            - we explicitly opt out in app-insights-config.ts.
 *                          The gate asserts the key is named there.
 *   'inert-when-dropped' - we do not name it. Because our `featureOptIn`
 *                          object REPLACES the SDK's default map rather than
 *                          merging into it (the SDK's default is a plain
 *                          object, not a `cfgDfMerge` default), dropping the
 *                          key means each call site falls back to its own
 *                          default state. `rationale` must say why that is
 *                          harmless for this app.
 */
const FEATURE_POLICY = Object.freeze({
  SdkStats: {
    sdkDefaultMode: 3,
    decision: 'disable',
    rationale:
      'Emits Item_Success/Dropped/Retry_Count as MetricData via core.track() on our own ' +
      'connection string, into customMetrics -- uncatalogued, and outside LoggerService and ' +
      'the frozen messageId union. Our telemetry inventory is manual-only.',
  },
  iKeyUsage: {
    sdkDefaultMode: 3,
    decision: 'inert-when-dropped',
    rationale:
      'Gates an instrumentation-key deprecation message. Dropping the key falls back to the ' +
      'same enabled state, and the message is additionally gated on there being no ' +
      'connectionString. We always configure a connection string, so it never fires.',
  },
  CdnUsage: {
    sdkDefaultMode: 2,
    decision: 'inert-when-dropped',
    rationale:
      'Gates a CDN deprecation message. Dropping the key falls back to enabled, but the ' +
      'message is additionally gated on the SDK source URL containing az416426 (the CDN ' +
      'snippet). We load the SDK from npm, so it never fires.',
  },
  SdkLoaderVer: {
    sdkDefaultMode: 2,
    decision: 'inert-when-dropped',
    rationale:
      'Gates a snippet-loader upgrade message. Dropping the key falls back to enabled, but ' +
      'the message is additionally gated on snippet version < 6, and the snippet version is ' +
      'empty (NaN) for npm initialization. It never fires.',
  },
  zipPayload: {
    sdkDefaultMode: 1,
    decision: 'inert-when-dropped',
    rationale:
      'Defaults to mode `none`, which already falls through to each call site default, so ' +
      'dropping the key changes nothing.',
  },
});

/**
 * Collects `var NAME = "value";` string constants from an ES5 bundle.
 *
 * The SDK writes its default map with constant identifiers as computed keys
 * (`_a[SDK_STATS] = { mode: 3 }`), so the identifiers have to be resolved back
 * to the wire names before anything can be compared.
 */
export function parseStringConstants(source) {
  const constants = new Map();
  const pattern = /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])((?:(?!\2)[^\\]|\\.)*)\2\s*;/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    constants.set(match[1], match[3]);
  }
  return constants;
}

/**
 * Extracts the `featureOptIn` block from `defaultConfigValues`.
 *
 * Returns the raw block text. Throws when the block cannot be located or its
 * parenthesis nesting does not close -- both mean the bundle shape changed and
 * the caller must not assume an empty result means "no features".
 */
export function extractFeatureOptInBlock(source) {
  const start = source.indexOf('featureOptIn:');
  if (start === -1) {
    throw new Error(
      "could not find a 'featureOptIn:' default in the SDK bundle. The bundle shape changed; " +
        're-verify defaultConfigValues by hand and update this gate.',
    );
  }
  // The block is an IIFE-ish comma expression: `(_a = {}, _a[K] = {...}, _a)`.
  // Walk from the first `(` and stop when the nesting closes.
  const open = source.indexOf('(', start);
  if (open === -1) {
    throw new Error("found 'featureOptIn:' but no opening parenthesis followed it.");
  }
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error("the 'featureOptIn' block never closed its parentheses.");
}

/**
 * Parses the SDK's default feature map into `{ name -> mode }`.
 *
 * Handles both the computed-identifier form the minifier emits
 * (`_a[SDK_STATS] = { mode: 3 }`) and the literal forms
 * (`_a["SdkStats"] = ...`, `SdkStats: { mode: 3 }`) so the gate survives a
 * change in bundler output rather than silently reporting zero features.
 */
export function parseFeatureOptInDefaults(source) {
  const block = extractFeatureOptInBlock(source);
  const constants = parseStringConstants(source);
  const defaults = new Map();
  const unresolved = [];

  const computed = /\[\s*([A-Za-z_$][\w$]*)\s*\]\s*=\s*\{\s*mode\s*:\s*(\d+)/g;
  let match;
  while ((match = computed.exec(block)) !== null) {
    const name = constants.get(match[1]);
    if (name === undefined) {
      unresolved.push(match[1]);
      continue;
    }
    defaults.set(name, Number(match[2]));
  }

  const literal =
    /(?:\[\s*(["'])(.+?)\1\s*\]|(?:^|[,{\s])([A-Za-z_$][\w$]*))\s*[=:]\s*\{\s*mode\s*:\s*(\d+)/g;
  while ((match = literal.exec(block)) !== null) {
    const name = match[2] ?? match[3];
    if (name === undefined) continue;
    if (!defaults.has(name)) defaults.set(name, Number(match[4]));
  }

  if (unresolved.length > 0) {
    throw new Error(
      `could not resolve feature key identifier(s) ${unresolved.join(', ')} to string ` +
        'literals. The bundle shape changed; re-verify by hand and update this gate.',
    );
  }
  if (defaults.size === 0) {
    throw new Error(
      'parsed the featureOptIn block but found no feature entries. The bundle shape changed; ' +
        're-verify by hand and update this gate.',
    );
  }
  return defaults;
}

function describeMode(mode) {
  return `${mode} (${MODE_NAMES[mode] ?? 'unknown'})`;
}

/**
 * Compares the SDK's defaults against FEATURE_POLICY in both directions, and
 * checks the recorded default mode for drift.
 */
export function checkFeaturePolicy(sdkDefaults, policy) {
  const problems = [];

  for (const [name, mode] of sdkDefaults) {
    const entry = policy[name];
    if (!entry) {
      problems.push(
        `the SDK defaults a feature this repo has not classified: '${name}' at mode ` +
          `${describeMode(mode)}.\n` +
          `    Decide what it does to our telemetry inventory, then add it to FEATURE_POLICY\n` +
          `    in scripts/check-sdk-feature-optin.mjs. If it emits anything, opt out in\n` +
          `    src/app/core/telemetry/app-insights-config.ts as well.`,
      );
      continue;
    }
    if (entry.sdkDefaultMode !== mode) {
      problems.push(
        `the SDK changed its default for '${name}': FEATURE_POLICY records ` +
          `${describeMode(entry.sdkDefaultMode)}, the installed SDK defaults ` +
          `${describeMode(mode)}.\n` +
          `    A default may have flipped on. Re-verify and update FEATURE_POLICY.`,
      );
    }
  }

  for (const name of Object.keys(policy)) {
    if (!sdkDefaults.has(name)) {
      problems.push(
        `FEATURE_POLICY classifies '${name}' but the installed SDK no longer defaults it.\n` +
          `    It was renamed or removed -- an opt-out keyed on the old name is now a no-op.\n` +
          `    Re-verify and update FEATURE_POLICY and app-insights-config.ts together.`,
      );
    }
  }

  return problems;
}

/**
 * Asserts that every feature classified 'disable' is actually named in the app
 * config. Deliberately a presence check: the exact mode and `blockCdnCfg` are
 * asserted by app-insights-config.test.ts, which can read the real value
 * instead of pattern-matching TypeScript source.
 */
export function checkDisabledFeaturesDeclared(policy, configSource) {
  const problems = [];
  for (const [name, entry] of Object.entries(policy)) {
    if (entry.decision !== 'disable') continue;
    if (!configSource.includes(name)) {
      problems.push(
        `'${name}' is classified 'disable' in FEATURE_POLICY but is not named in\n` +
          `    src/app/core/telemetry/app-insights-config.ts. The opt-out is missing, so the\n` +
          `    SDK falls back to its own default state.`,
      );
    }
  }
  return problems;
}

function readOrFail(path, label) {
  if (!existsSync(path)) {
    throw new Error(
      `${label} not found at ${path}.\n` +
        '    Run `npm ci` first -- this gate reads the installed SDK, not the lockfile.',
    );
  }
  return readFileSync(path, 'utf8');
}

function main() {
  let problems;
  let sdkDefaults;
  try {
    const sdkSource = readOrFail(SDK_DEFAULTS_FILE, 'the Application Insights SDK bundle');
    const configSource = readOrFail(APP_CONFIG_FILE, 'app-insights-config.ts');
    sdkDefaults = parseFeatureOptInDefaults(sdkSource);
    problems = [
      ...checkFeaturePolicy(sdkDefaults, FEATURE_POLICY),
      ...checkDisabledFeaturesDeclared(FEATURE_POLICY, configSource),
    ];
  } catch (error) {
    console.error('');
    console.error('check-sdk-feature-optin: FAILED');
    console.error(`  - ${error instanceof Error ? error.message : String(error)}`);
    console.error('');
    return 1;
  }

  if (problems.length > 0) {
    console.error('');
    console.error('check-sdk-feature-optin: FAILED');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('');
    console.error('  See docs/telemetry.md for the SPA telemetry inventory this protects.');
    return 1;
  }

  const disabled = Object.values(FEATURE_POLICY).filter(
    (entry) => entry.decision === 'disable',
  ).length;
  console.log(
    `check-sdk-feature-optin: OK (${sdkDefaults.size} SDK feature default(s) classified, ` +
      `${disabled} opted out)`,
  );
  return 0;
}

export { FEATURE_POLICY };

// Only invoke main() when executed directly. The unit test imports this module
// solely for its exports and must not trigger CLI side effects.
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
