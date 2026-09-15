// Unit tests for scripts/check-sdk-feature-optin.mjs.
//
// Runs under Node's built-in test runner: `node --test`. The script guards
// `main()` behind an "invoked directly" check, so importing it here does not
// trigger CLI side effects.
//
// Coverage focuses on the parse/compare functions. The end-to-end path against
// the real installed SDK is exercised by `npm run lint:sdk-feature-optin`.
//
// Background: PR #566. `@microsoft/applicationinsights-web` 3.4.3 added a
// `SdkStats` feature defaulting to `enable`, which emits SDK self-stats onto
// our own connection string. A unit test asserting our own config literal
// cannot detect the NEXT such feature; this gate reads the SDK's own default
// map so that a new or flipped default fails loudly.
//
// The fixtures below deliberately include shapes the SDK does NOT currently
// emit in `dist-es5/AISku.js`. A suite built only from the shape the parser
// already handles cannot demonstrate robustness to a shape change -- and the
// first revision of this gate shipped exactly that gap, silently skipping any
// entry whose `mode` was not the first property.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

import {
  checkFeaturePolicy,
  collectStringConstants,
  findFeatureMapInitializer,
  parseSdkFeatureDefaults,
} from './check-sdk-feature-optin.mjs';
import { FEATURE_OPT_IN_MODE, FEATURE_POLICY } from './sdk-feature-policy.mjs';

/** Mirrors the shape of the real `dist-es5/AISku.js` (downleveled ES5). */
const ES5_SOURCE = `
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

/**
 * Mirrors the real minified bundle the same package publishes at
 * `browser/es5/ai.3.4.4.min.js`: comma-joined `var` declarators, no spaces,
 * and one entry rewritten from a computed key to a plain member assignment
 * (`Y1.zipPayload={mode:1}`) -- a form the first revision of this gate did not
 * enumerate at all.
 */
const MINIFIED_SOURCE =
  'var a="dependencies",Xy="iKeyUsage",Jy="CdnUsage",$y="SdkLoaderVer",Gy="SdkStats",' +
  'Qy={featureOptIn:((Y1={})[Xy]={mode:3},Y1[Jy]={mode:2},Y1[$y]={mode:2},' +
  'Y1.zipPayload={mode:1},Y1[Gy]={mode:3},Y1),sdkStats:cfgDfMerge({int:9e5})};';

function sorted(map) {
  return [...map.entries()].sort(([left], [right]) => left.localeCompare(right));
}

const ALL_FIVE = [
  ['CdnUsage', 2],
  ['SdkLoaderVer', 2],
  ['SdkStats', 3],
  ['iKeyUsage', 3],
  ['zipPayload', 1],
].sort(([left], [right]) => left.localeCompare(right));

// ---------------------------------------------------------------------------
// collectStringConstants
// ---------------------------------------------------------------------------

test('collectStringConstants resolves the feature-name constants', () => {
  const sourceFile = ts.createSourceFile(
    'x.js',
    ES5_SOURCE,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const constants = collectStringConstants(sourceFile);
  assert.equal(constants.get('SDK_STATS'), 'SdkStats');
  assert.equal(constants.get('ZIP_PAYLOAD'), 'zipPayload');
});

test('collectStringConstants handles comma-joined declarator lists', () => {
  // The minified bundle emits `var a="x",b="y",...` -- one declaration with
  // many declarators. The first revision's regex required `var` immediately
  // before each name and resolved zero of them.
  const sourceFile = ts.createSourceFile(
    'x.js',
    MINIFIED_SOURCE,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const constants = collectStringConstants(sourceFile);
  assert.equal(constants.get('Gy'), 'SdkStats');
  assert.equal(constants.get('Xy'), 'iKeyUsage');
});

// ---------------------------------------------------------------------------
// parseSdkFeatureDefaults -- the shapes that matter
// ---------------------------------------------------------------------------

test('parses the downleveled ES5 shape the SDK ships today', () => {
  assert.deepEqual(sorted(parseSdkFeatureDefaults(ES5_SOURCE)), ALL_FIVE);
});

test('parses the minified shape, including a dot-assignment entry', () => {
  // Regression: the first revision enumerated only computed-key assignments,
  // so `Y1.zipPayload={mode:1}` vanished from the result while the count
  // stayed nonzero -- a silent under-report.
  assert.deepEqual(sorted(parseSdkFeatureDefaults(MINIFIED_SOURCE)), ALL_FIVE);
});

test('parses an entry whose mode is not the first property', () => {
  // Regression (the reviewer's exact case): `{ blockCdnCfg: false, mode: 3 }`
  // was silently skipped by the regex, which required `{ mode: <digits>`.
  const defaults = parseSdkFeatureDefaults(
    'var A = "SdkStats", B = "NewFeature";\n' +
      'var d = { featureOptIn: (_a = {}, _a[A] = { mode: 2 }, ' +
      '_a[B] = { blockCdnCfg: false, mode: 3 }, _a) };',
  );
  assert.equal(defaults.get('NewFeature'), 3);
  assert.equal(defaults.get('SdkStats'), 2);
});

test('parses a plain object-literal feature map', () => {
  const defaults = parseSdkFeatureDefaults('var d = { featureOptIn: { SdkStats: { mode: 3 } } };');
  assert.equal(defaults.get('SdkStats'), 3);
});

test('parses a computed string-literal key', () => {
  const defaults = parseSdkFeatureDefaults(
    'var d = { featureOptIn: (_a = {}, _a["SdkStats"] = { mode: 3 }, _a) };',
  );
  assert.equal(defaults.get('SdkStats'), 3);
});

test('treats a missing mode as none rather than failing', () => {
  // `IFeatureOptInDetails.mode` is optional in the SDK's own contract, and
  // absence means "fall through to the call-site default". Throwing here
  // would fail CI on a legal bundle.
  const defaults = parseSdkFeatureDefaults(
    'var d = { featureOptIn: (_a = {}, _a["SdkStats"] = { blockCdnCfg: true }, _a) };',
  );
  assert.equal(defaults.get('SdkStats'), FEATURE_OPT_IN_MODE.none);
});

test('does not mistake a nested onCfg object for a feature entry', () => {
  const defaults = parseSdkFeatureDefaults(
    'var d = { featureOptIn: (_a = {}, _a["SdkStats"] = ' +
      '{ mode: 3, onCfg: { someField: 1 }, offCfg: { other: 2 } }, _a) };',
  );
  assert.deepEqual([...defaults.keys()], ['SdkStats']);
});

test('is not confused by comments or braces inside strings', () => {
  // The whole point of parsing with the compiler rather than by hand.
  const defaults = parseSdkFeatureDefaults(
    'var LABEL = "not { a: real } entry"; // featureOptIn: { Decoy: { mode: 3 } }\n' +
      '/* featureOptIn: { AlsoDecoy: { mode: 3 } } */\n' +
      'var d = { featureOptIn: (_a = {}, _a["SdkStats"] = { mode: 3 }, _a) };',
  );
  assert.deepEqual([...defaults.keys()], ['SdkStats']);
});

// ---------------------------------------------------------------------------
// parseSdkFeatureDefaults -- fail-closed behavior
// ---------------------------------------------------------------------------

test('throws on a symbolic mode rather than skipping the entry', () => {
  assert.throws(
    () =>
      parseSdkFeatureDefaults(
        'var d = { featureOptIn: (_a = {}, _a["NewFeature"] = { mode: MODE_ENABLE }, _a) };',
      ),
    /declares a non-literal mode/,
  );
});

test('throws when a key identifier cannot be resolved', () => {
  assert.throws(
    () =>
      parseSdkFeatureDefaults(
        'var d = { featureOptIn: (_a = {}, _a[MYSTERY] = { mode: 3 }, _a) };',
      ),
    /could not resolve feature key identifier 'MYSTERY'/,
  );
});

test('throws when the feature map is absent', () => {
  assert.throws(
    () => parseSdkFeatureDefaults('var defaultConfigValues = { connectionString: 1 };'),
    /could not find a 'featureOptIn:' default/,
  );
});

test('throws when more than one feature map is present', () => {
  assert.throws(
    () =>
      parseSdkFeatureDefaults(
        'var a = { featureOptIn: { X: { mode: 1 } } }, b = { featureOptIn: { Y: { mode: 1 } } };',
      ),
    /expected exactly one/,
  );
});

test('throws when the map parses to zero entries', () => {
  assert.throws(
    () => parseSdkFeatureDefaults('var d = { featureOptIn: (_a = {}, _a) };'),
    /parsed no feature entries/,
  );
});

test('findFeatureMapInitializer is exported for targeted diagnosis', () => {
  assert.equal(typeof findFeatureMapInitializer, 'function');
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
  // The PR #566 scenario replayed one release later.
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
  const problems = checkFeaturePolicy(new Map([['SdkStats', 3]]), POLICY);
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
// The shipped policy itself
// ---------------------------------------------------------------------------

test('FEATURE_POLICY entries are complete and well-formed', () => {
  const decisions = new Set(['disable', 'inert-when-dropped']);
  const modes = new Set(Object.values(FEATURE_OPT_IN_MODE));
  for (const [name, entry] of Object.entries(FEATURE_POLICY)) {
    assert.ok(decisions.has(entry.decision), `${name} has an unknown decision`);
    assert.ok(modes.has(entry.sdkDefaultMode), `${name} has an out-of-range sdkDefaultMode`);
    assert.ok(entry.rationale.length > 0, `${name} is missing a rationale`);
  }
});

test('FEATURE_POLICY opts out of SdkStats', () => {
  assert.equal(FEATURE_POLICY.SdkStats.decision, 'disable');
});

test('the shipped policy accepts the ES5 fixture end to end', () => {
  assert.deepEqual(checkFeaturePolicy(parseSdkFeatureDefaults(ES5_SOURCE), FEATURE_POLICY), []);
});

test('the shipped policy accepts the minified fixture end to end', () => {
  // Same feature set, different bundler output: the policy must not be
  // coupled to one build's syntax.
  assert.deepEqual(
    checkFeaturePolicy(parseSdkFeatureDefaults(MINIFIED_SOURCE), FEATURE_POLICY),
    [],
  );
});
