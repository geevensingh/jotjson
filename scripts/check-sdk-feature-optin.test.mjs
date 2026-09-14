// Unit tests for scripts/check-sdk-feature-optin.mjs.
//
// Runs under Node's built-in test runner: `node --test`. No external
// dependencies. The script guards `main()` behind an "invoked directly" check,
// so importing it here does not trigger CLI side effects.
//
// Coverage focuses on the pure parse/compare functions. The end-to-end path
// against the real installed SDK is exercised by
// `npm run lint:sdk-feature-optin`.
//
// Background: PR #566. `@microsoft/applicationinsights-web` 3.4.3 added a
// `SdkStats` feature defaulting to `enable`, which emits SDK self-stats onto
// our own connection string. A unit test asserting our own config literal
// cannot detect the NEXT such feature; this gate reads the SDK's own default
// map so that a new or flipped default fails loudly.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FEATURE_POLICY,
  checkDisabledFeaturesDeclared,
  checkFeaturePolicy,
  extractFeatureOptInBlock,
  parseFeatureOptInDefaults,
  parseStringConstants,
} from './check-sdk-feature-optin.mjs';

// A trimmed stand-in for the shape `dist-es5/AISku.js` actually emits.
const SDK_SOURCE = `
var IKEY_USAGE = "iKeyUsage";
var CDN_USAGE = "CdnUsage";
var SDK_LOADER_VER = "SdkLoaderVer";
var ZIP_PAYLOAD = "zipPayload";
var SDK_STATS = "SdkStats";
var defaultConfigValues = {
    connectionString: UNDEFINED_VALUE,
    featureOptIn: (_a = {},
        _a[IKEY_USAGE] = { mode: 3 /* FeatureOptInMode.enable */ },
        _a[CDN_USAGE] = { mode: 2 /* FeatureOptInMode.disable */ },
        _a[SDK_LOADER_VER] = { mode: 2 /* FeatureOptInMode.disable */ },
        _a[ZIP_PAYLOAD] = { mode: 1 /* FeatureOptInMode.none */ },
        _a[SDK_STATS] = { mode: 3 /* FeatureOptInMode.enable */ },
        _a),
    sdkStats: cfgDfMerge({
        int: 900000
    }),
};
`;

// ---------------------------------------------------------------------------
// parseStringConstants
// ---------------------------------------------------------------------------

test('parseStringConstants resolves the feature-name constants', () => {
  const constants = parseStringConstants(SDK_SOURCE);
  assert.equal(constants.get('SDK_STATS'), 'SdkStats');
  assert.equal(constants.get('ZIP_PAYLOAD'), 'zipPayload');
});

test('parseStringConstants handles single quotes', () => {
  assert.equal(parseStringConstants(`var A = 'value';`).get('A'), 'value');
});

test('parseStringConstants ignores non-string declarations', () => {
  const constants = parseStringConstants('var COUNT = 900000;');
  assert.equal(constants.has('COUNT'), false);
});

// ---------------------------------------------------------------------------
// extractFeatureOptInBlock -- must fail closed, never return empty
// ---------------------------------------------------------------------------

test('extractFeatureOptInBlock returns the balanced block', () => {
  const block = extractFeatureOptInBlock(SDK_SOURCE);
  assert.ok(block.startsWith('('));
  assert.ok(block.endsWith(')'));
  assert.ok(block.includes('SDK_STATS'));
  // Must stop at the block, not swallow the sibling sdkStats default.
  assert.equal(block.includes('int: 900000'), false);
});

test('extractFeatureOptInBlock throws when the default is absent', () => {
  assert.throws(
    () => extractFeatureOptInBlock('var defaultConfigValues = { connectionString: 1 };'),
    /could not find a 'featureOptIn:' default/,
  );
});

test('extractFeatureOptInBlock throws on unbalanced parentheses', () => {
  assert.throws(
    () => extractFeatureOptInBlock('featureOptIn: (_a = {}, _a[X] = { mode: 3 },'),
    /never closed its parentheses/,
  );
});

// ---------------------------------------------------------------------------
// parseFeatureOptInDefaults
// ---------------------------------------------------------------------------

test('parseFeatureOptInDefaults reads every key and mode', () => {
  const defaults = parseFeatureOptInDefaults(SDK_SOURCE);
  assert.deepEqual(
    [...defaults.entries()].sort(),
    [
      ['CdnUsage', 2],
      ['SdkLoaderVer', 2],
      ['SdkStats', 3],
      ['iKeyUsage', 3],
      ['zipPayload', 1],
    ].sort(),
  );
});

test('parseFeatureOptInDefaults accepts literal string keys', () => {
  const defaults = parseFeatureOptInDefaults(
    'featureOptIn: (_a = {}, _a["SdkStats"] = { mode: 3 }, _a),',
  );
  assert.equal(defaults.get('SdkStats'), 3);
});

test('parseFeatureOptInDefaults accepts a plain object literal form', () => {
  const defaults = parseFeatureOptInDefaults('featureOptIn: ({ SdkStats: { mode: 3 } }),');
  assert.equal(defaults.get('SdkStats'), 3);
});

test('parseFeatureOptInDefaults throws when an identifier cannot be resolved', () => {
  // Fail closed: an unresolvable key must not be silently skipped, or the
  // gate would report a shorter feature list than the SDK actually ships.
  assert.throws(
    () => parseFeatureOptInDefaults('featureOptIn: (_a = {}, _a[MYSTERY] = { mode: 3 }, _a),'),
    /could not resolve feature key identifier\(s\) MYSTERY/,
  );
});

test('parseFeatureOptInDefaults throws when the block parses to nothing', () => {
  assert.throws(
    () => parseFeatureOptInDefaults('featureOptIn: (_a = {}, _a),'),
    /found no feature entries/,
  );
});

// ---------------------------------------------------------------------------
// checkFeaturePolicy
// ---------------------------------------------------------------------------

const POLICY = Object.freeze({
  SdkStats: { sdkDefaultMode: 3, decision: 'disable', rationale: 'x' },
  zipPayload: { sdkDefaultMode: 1, decision: 'inert-when-dropped', rationale: 'x' },
});

test('checkFeaturePolicy passes when defaults match the policy', () => {
  const defaults = new Map([
    ['SdkStats', 3],
    ['zipPayload', 1],
  ]);
  assert.deepEqual(checkFeaturePolicy(defaults, POLICY), []);
});

test('checkFeaturePolicy flags an unclassified new SDK feature', () => {
  // This is the PR #566 scenario replayed one release later.
  const defaults = new Map([
    ['SdkStats', 3],
    ['zipPayload', 1],
    ['SomethingNew', 3],
  ]);
  const problems = checkFeaturePolicy(defaults, POLICY);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /has not classified: 'SomethingNew' at mode 3 \(enable\)/);
});

test('checkFeaturePolicy flags a changed SDK default mode', () => {
  const defaults = new Map([
    ['SdkStats', 3],
    ['zipPayload', 3],
  ]);
  const problems = checkFeaturePolicy(defaults, POLICY);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /changed its default for 'zipPayload'/);
  assert.match(problems[0], /records 1 \(none\), the installed SDK defaults 3 \(enable\)/);
});

test('checkFeaturePolicy flags a policy entry the SDK dropped', () => {
  // A rename would otherwise leave our opt-out keyed on a dead name.
  const defaults = new Map([['SdkStats', 3]]);
  const problems = checkFeaturePolicy(defaults, POLICY);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /classifies 'zipPayload' but the installed SDK no longer defaults it/);
});

test('checkFeaturePolicy reports an unknown mode number readably', () => {
  const problems = checkFeaturePolicy(new Map([['SdkStats', 9]]), {
    SdkStats: { sdkDefaultMode: 3, decision: 'disable', rationale: 'x' },
  });
  assert.match(problems[0], /9 \(unknown\)/);
});

// ---------------------------------------------------------------------------
// checkDisabledFeaturesDeclared
// ---------------------------------------------------------------------------

test('checkDisabledFeaturesDeclared passes when the opt-out is present', () => {
  const source = 'featureOptIn: { SdkStats: { mode: 2, blockCdnCfg: true } }';
  assert.deepEqual(checkDisabledFeaturesDeclared(POLICY, source), []);
});

test('checkDisabledFeaturesDeclared flags a dropped opt-out', () => {
  const problems = checkDisabledFeaturesDeclared(POLICY, 'connectionString,');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /'SdkStats' is classified 'disable'/);
});

test('checkDisabledFeaturesDeclared ignores inert-when-dropped features', () => {
  // zipPayload is deliberately absent from app-insights-config.ts.
  assert.deepEqual(checkDisabledFeaturesDeclared(POLICY, 'SdkStats'), []);
});

// ---------------------------------------------------------------------------
// The shipped policy itself
// ---------------------------------------------------------------------------

test('FEATURE_POLICY entries are complete and well-formed', () => {
  const decisions = new Set(['disable', 'inert-when-dropped']);
  for (const [name, entry] of Object.entries(FEATURE_POLICY)) {
    assert.ok(decisions.has(entry.decision), `${name} has an unknown decision`);
    assert.equal(typeof entry.sdkDefaultMode, 'number', `${name} is missing sdkDefaultMode`);
    assert.ok(entry.rationale.length > 0, `${name} is missing a rationale`);
  }
});

test('FEATURE_POLICY opts out of SdkStats', () => {
  assert.equal(FEATURE_POLICY.SdkStats.decision, 'disable');
});
