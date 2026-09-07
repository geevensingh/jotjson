// Unit tests for scripts/check-dependency-overrides.mjs.
//
// Runs under Node's built-in test runner: `node --test`. No external
// dependencies. The test file imports the script as a module; the script
// guards `main()` behind an "invoked directly" check so importing it does
// not trigger CLI side effects (filesystem scans, process.exit).
//
// Coverage focuses on the pure decision functions. The end-to-end scan of
// the shipped Monaco tree is exercised by the real
// `npm run lint:dependency-overrides` and is not unit-tested here.
//
// Background: issue #514. An `overrides` pin for a package that ships
// vendored inside a prebuilt asset changes only node_modules/, never the
// shipped bytes -- so bumping it silences Dependabot without remediating
// anything, and can hide advisories affecting the older shipped copy.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkAssetMapping,
  checkOverrideAgainstShipped,
  checkOverridePolicy,
  checkPolicyVendoredConsistency,
  extractVersionsFromText,
  isNonEmptyString,
  normalizeOverrides,
  normalizePackageKey,
} from './check-dependency-overrides.mjs';

// ---------------------------------------------------------------------------
// normalizePackageKey
// ---------------------------------------------------------------------------

test('normalizePackageKey passes through a bare name', () => {
  assert.equal(normalizePackageKey('dompurify'), 'dompurify');
});

test('normalizePackageKey strips a version selector', () => {
  assert.equal(normalizePackageKey('dompurify@3.2.7'), 'dompurify');
  assert.equal(normalizePackageKey('dompurify@^3'), 'dompurify');
});

test('normalizePackageKey preserves a scoped package name', () => {
  // The leading @ is part of the name, not a selector separator.
  assert.equal(normalizePackageKey('@babel/core'), '@babel/core');
});

test('normalizePackageKey strips a selector from a scoped name', () => {
  assert.equal(normalizePackageKey('@babel/core@7.29.0'), '@babel/core');
});

// ---------------------------------------------------------------------------
// normalizeOverrides -- every form npm accepts can silence an alert
// ---------------------------------------------------------------------------

test('normalizeOverrides handles the flat form', () => {
  const result = normalizeOverrides({ dompurify: '3.4.14' });
  assert.deepEqual([...result.keys()], ['dompurify']);
  assert.deepEqual([...result.get('dompurify')], ['3.4.14']);
});

test('normalizeOverrides handles the nested form', () => {
  // This form bypassed the revision-1 gate design entirely.
  const result = normalizeOverrides({ 'monaco-editor': { dompurify: '3.4.14' } });
  assert.deepEqual([...result.get('dompurify')], ['3.4.14']);
  // The outer key is a scope selector, not an overridden package.
  assert.equal(result.has('monaco-editor'), false);
});

test('normalizeOverrides handles the selector-key form', () => {
  const result = normalizeOverrides({ 'dompurify@3.2.7': '3.4.14' });
  assert.deepEqual([...result.get('dompurify')], ['3.4.14']);
});

test('normalizeOverrides handles the "." self-reference form', () => {
  const result = normalizeOverrides({ 'monaco-editor': { '.': '0.56.0', dompurify: '3.4.14' } });
  assert.deepEqual([...result.get('monaco-editor')], ['0.56.0']);
  assert.deepEqual([...result.get('dompurify')], ['3.4.14']);
});

test('normalizeOverrides collects multiple distinct values for one package', () => {
  const result = normalizeOverrides({
    dompurify: '3.4.14',
    'monaco-editor': { dompurify: '3.4.13' },
  });
  assert.deepEqual([...result.get('dompurify')].sort(), ['3.4.13', '3.4.14']);
});

test('normalizeOverrides handles deep nesting', () => {
  const result = normalizeOverrides({ a: { b: { dompurify: '3.4.14' } } });
  assert.deepEqual([...result.get('dompurify')], ['3.4.14']);
});

test('normalizeOverrides returns empty for empty or non-object input', () => {
  assert.equal(normalizeOverrides({}).size, 0);
  assert.equal(normalizeOverrides(null).size, 0);
  assert.equal(normalizeOverrides(undefined).size, 0);
  assert.equal(normalizeOverrides('nonsense').size, 0);
  assert.equal(normalizeOverrides([1, 2]).size, 0);
});

// ---------------------------------------------------------------------------
// checkOverrideAgainstShipped -- the core issue #514 regression
// ---------------------------------------------------------------------------

test('checkOverrideAgainstShipped passes when the override is absent', () => {
  // The desired steady state: no override, so npm resolves the package from
  // the vendoring package's own declaration.
  const effective = normalizeOverrides({ 'fast-uri': '^3.1.2' });
  assert.equal(checkOverrideAgainstShipped(effective, 'dompurify', '3.2.7'), null);
});

test('checkOverrideAgainstShipped passes when the override equals the shipped version', () => {
  const effective = normalizeOverrides({ dompurify: '3.2.7' });
  assert.equal(checkOverrideAgainstShipped(effective, 'dompurify', '3.2.7'), null);
});

test('checkOverrideAgainstShipped FAILS when the override is bumped above the shipped version', () => {
  // This is precisely the change issue #514 was filed to prevent: it would
  // close all 10 Dependabot alerts while changing zero shipped bytes.
  const effective = normalizeOverrides({ dompurify: '3.4.14' });
  const problem = checkOverrideAgainstShipped(effective, 'dompurify', '3.2.7');
  assert.notEqual(problem, null);
  assert.match(problem, /3\.4\.14/);
  assert.match(problem, /actually ships is 3\.2\.7/);
  assert.match(problem, /does NOT change a single shipped byte/);
  assert.match(problem, /#514/);
});

test('checkOverrideAgainstShipped fails when the override is below the shipped version', () => {
  const effective = normalizeOverrides({ dompurify: '3.0.0' });
  assert.notEqual(checkOverrideAgainstShipped(effective, 'dompurify', '3.2.7'), null);
});

test('checkOverrideAgainstShipped catches the nested form too', () => {
  const effective = normalizeOverrides({ 'monaco-editor': { dompurify: '3.4.14' } });
  assert.notEqual(checkOverrideAgainstShipped(effective, 'dompurify', '3.2.7'), null);
});

test('checkOverrideAgainstShipped reports every mismatched value', () => {
  const effective = normalizeOverrides({
    dompurify: '3.4.14',
    'monaco-editor': { dompurify: '3.4.13' },
  });
  const problem = checkOverrideAgainstShipped(effective, 'dompurify', '3.2.7');
  assert.match(problem, /3\.4\.13/);
  assert.match(problem, /3\.4\.14/);
});

// ---------------------------------------------------------------------------
// checkOverridePolicy -- every override must be classified and justified
// ---------------------------------------------------------------------------

const SAMPLE_POLICY = {
  'fast-uri': { classification: 'dev-only', consumer: 'ajv', rationale: 'schema $ref resolution' },
  hono: {
    classification: 'dev-only',
    consumer: '@hono/node-server',
    rationale: 'dev-server tooling',
  },
};

test('checkOverridePolicy passes when every override is classified', () => {
  const effective = normalizeOverrides({ 'fast-uri': '^3.1.2', hono: '^4.12.16' });
  assert.deepEqual(checkOverridePolicy(effective, SAMPLE_POLICY), []);
});

test('checkOverridePolicy fails on an unclassified override', () => {
  // A new prod-scoped override added without justification -- the recurrence
  // this gate exists to block.
  const effective = normalizeOverrides({
    'fast-uri': '^3.1.2',
    hono: '^4.12.16',
    dompurify: '3.4.14',
  });
  const problems = checkOverridePolicy(effective, SAMPLE_POLICY);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /'dompurify' is not classified/);
});

test('checkOverridePolicy rejects an unknown classification', () => {
  const effective = normalizeOverrides({ 'fast-uri': '^3.1.2' });
  const problems = checkOverridePolicy(effective, {
    'fast-uri': { classification: 'probably-fine', consumer: 'ajv', rationale: 'because' },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unknown classification/);
});

// The named-consumer requirement applies to EVERY classification, not just
// dev-only -- prod-graph and shipped-prebuilt are the more security-relevant
// cases, so exempting them would put the loophole in exactly the wrong place.
for (const classification of ['dev-only', 'prod-graph', 'shipped-prebuilt']) {
  test(`checkOverridePolicy requires a named consumer for '${classification}'`, () => {
    const effective = normalizeOverrides({ 'fast-uri': '^3.1.2' });
    const problems = checkOverridePolicy(effective, {
      'fast-uri': { classification, rationale: 'because' },
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /names no specific consumer/);
  });

  test(`checkOverridePolicy requires a rationale for '${classification}'`, () => {
    const effective = normalizeOverrides({ 'fast-uri': '^3.1.2' });
    const problems = checkOverridePolicy(effective, {
      'fast-uri': { classification, consumer: 'ajv' },
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /has no rationale/);
  });
}

test('checkOverridePolicy rejects a whitespace-only consumer', () => {
  // A truthy check alone would accept '   ' as a "named consumer".
  const effective = normalizeOverrides({ 'fast-uri': '^3.1.2' });
  const problems = checkOverridePolicy(effective, {
    'fast-uri': { classification: 'dev-only', consumer: '   ', rationale: 'because' },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /names no specific consumer/);
});

test('checkOverridePolicy rejects a non-string consumer', () => {
  const effective = normalizeOverrides({ 'fast-uri': '^3.1.2' });
  const problems = checkOverridePolicy(effective, {
    'fast-uri': { classification: 'dev-only', consumer: true, rationale: 'because' },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /names no specific consumer/);
});

test('isNonEmptyString accepts only non-blank strings', () => {
  assert.equal(isNonEmptyString('ajv'), true);
  assert.equal(isNonEmptyString(''), false);
  assert.equal(isNonEmptyString('   '), false);
  assert.equal(isNonEmptyString('\t\n'), false);
  assert.equal(isNonEmptyString(undefined), false);
  assert.equal(isNonEmptyString(null), false);
  assert.equal(isNonEmptyString(42), false);
  assert.equal(isNonEmptyString(true), false);
});

test('checkOverridePolicy flags a stale policy entry with no matching override', () => {
  const effective = normalizeOverrides({ 'fast-uri': '^3.1.2' });
  const problems = checkOverridePolicy(effective, SAMPLE_POLICY);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /lists 'hono' but root package.json has no such override/);
});

// ---------------------------------------------------------------------------
// checkPolicyVendoredConsistency -- both directions
// ---------------------------------------------------------------------------

test('checkPolicyVendoredConsistency passes when the two registries agree', () => {
  const effective = normalizeOverrides({ dompurify: '3.2.7' });
  const policy = {
    dompurify: {
      classification: 'shipped-prebuilt',
      consumer: 'monaco-editor',
      rationale: 'vendored in min/vs',
    },
  };
  assert.deepEqual(checkPolicyVendoredConsistency(effective, policy, ['dompurify']), []);
});

test('checkPolicyVendoredConsistency fails a shipped-prebuilt entry missing from VENDORED_PACKAGES', () => {
  // Forward hole: the classification claims "this pin does not control what
  // ships", but nothing ever reads what ships, because Part B iterates
  // VENDORED_PACKAGES.
  const effective = normalizeOverrides({ 'some-lib': '1.0.0' });
  const policy = {
    'some-lib': {
      classification: 'shipped-prebuilt',
      consumer: 'some-bundler',
      rationale: 'vendored somewhere',
    },
  };
  const problems = checkPolicyVendoredConsistency(effective, policy, ['dompurify']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /absent from/);
  assert.match(problems[0], /VENDORED_PACKAGES/);
});

test('checkPolicyVendoredConsistency fails a vendored package classified as something else', () => {
  // Converse hole, and the subtle one: Part A accepts the classification and
  // Part B's equality check returns null because the pin happens to MATCH the
  // shipped version -- so without this check a materially false classification
  // passes both parts.
  const effective = normalizeOverrides({ dompurify: '3.2.7' });
  const policy = {
    dompurify: {
      classification: 'dev-only',
      consumer: 'monaco-editor',
      rationale: 'looks harmless',
    },
  };
  const problems = checkPolicyVendoredConsistency(effective, policy, ['dompurify']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /classified 'dev-only'/);
  assert.match(problems[0], /must be classified 'shipped-prebuilt'/);
});

test('checkPolicyVendoredConsistency does NOT require a policy entry for a vendored package with no override', () => {
  // This is the desired steady state after issue #514: no override at all, so
  // npm resolves the package from the vendoring package's own declaration.
  assert.deepEqual(checkPolicyVendoredConsistency(new Map(), {}, ['dompurify']), []);
});

test('checkPolicyVendoredConsistency does not double-report an unclassified override', () => {
  // checkOverridePolicy already reports the missing policy entry.
  const effective = normalizeOverrides({ dompurify: '3.4.14' });
  assert.deepEqual(checkPolicyVendoredConsistency(effective, {}, ['dompurify']), []);
});

// ---------------------------------------------------------------------------
// extractVersionsFromText
// ---------------------------------------------------------------------------

function patterns() {
  // Fresh RegExp objects per call: /g patterns carry mutable lastIndex.
  return [/@license\s+DOMPurify\s+(\d+\.\d+\.\d+)/g, /\bversion\s*=\s*"(\d+\.\d+\.\d+)"/g];
}

test('extractVersionsFromText reads the license banner (monaco 0.55.1 shape)', () => {
  const text = '/*! @license DOMPurify 3.2.7 | (c) Cure53 and other contributors */';
  assert.deepEqual([...extractVersionsFromText(text, patterns())], ['3.2.7']);
});

test('extractVersionsFromText reads a bare version literal (monaco 0.56.0 shape)', () => {
  // 0.56.0's minifier strips the @license banner but keeps the literal.
  const text = 'e.isSupported=typeof x=="function",e.version="3.4.8",e.removed=[]';
  assert.deepEqual([...extractVersionsFromText(text, patterns())], ['3.4.8']);
});

test('extractVersionsFromText dedupes banner and literal reporting the same version', () => {
  const text = '/*! @license DOMPurify 3.2.7 */ ... version="3.2.7" ...';
  assert.deepEqual([...extractVersionsFromText(text, patterns())], ['3.2.7']);
});

test('extractVersionsFromText surfaces disagreement as multiple versions', () => {
  // The gate treats size > 1 as ambiguous and fails closed.
  const text = '/*! @license DOMPurify 3.2.7 */ ... version="3.4.8" ...';
  assert.deepEqual([...extractVersionsFromText(text, patterns())].sort(), ['3.2.7', '3.4.8']);
});

test('extractVersionsFromText returns empty when nothing matches', () => {
  assert.equal(extractVersionsFromText('no version information here', patterns()).size, 0);
});

test('extractVersionsFromText is deterministic across repeated calls', () => {
  // Guards the lastIndex reset: a /g regex reused without resetting would
  // return different results on the second call.
  const shared = patterns();
  const text = '/*! @license DOMPurify 3.2.7 */';
  assert.deepEqual([...extractVersionsFromText(text, shared)], ['3.2.7']);
  assert.deepEqual([...extractVersionsFromText(text, shared)], ['3.2.7']);
});

// ---------------------------------------------------------------------------
// checkAssetMapping
// ---------------------------------------------------------------------------

const ANGULAR_WITH_MONACO = {
  projects: {
    jotjson: {
      architect: {
        build: {
          options: {
            assets: [
              { glob: '**/*', input: 'public', output: 'assets' },
              { glob: '**/*', input: 'node_modules/monaco-editor/min/vs', output: 'vs' },
            ],
          },
        },
      },
    },
  },
};

test('checkAssetMapping passes when the asset input is present', () => {
  assert.equal(checkAssetMapping(ANGULAR_WITH_MONACO, 'node_modules/monaco-editor/min/vs'), null);
});

test('checkAssetMapping fails when the asset input is gone', () => {
  // If the assets glob changes, the gate must detach loudly rather than
  // silently verifying a tree that no longer ships.
  const problem = checkAssetMapping(ANGULAR_WITH_MONACO, 'node_modules/monaco-editor/esm/vs');
  assert.notEqual(problem, null);
  assert.match(problem, /no longer copies/);
});

test('checkAssetMapping tolerates trailing slashes and backslashes', () => {
  const angularJson = {
    assets: [{ input: 'node_modules\\monaco-editor\\min\\vs\\', glob: '**/*', output: 'vs' }],
  };
  assert.equal(checkAssetMapping(angularJson, 'node_modules/monaco-editor/min/vs'), null);
});

test('checkAssetMapping rejects a narrowed glob', () => {
  // Copying only CSS would still "copy the tree" by path, but the JavaScript
  // this gate reads a version out of would no longer ship.
  const angularJson = {
    assets: [{ input: 'node_modules/monaco-editor/min/vs', glob: '**/*.css', output: 'vs' }],
  };
  const problem = checkAssetMapping(angularJson, 'node_modules/monaco-editor/min/vs');
  assert.notEqual(problem, null);
  assert.match(problem, /narrowed glob/);
});

test('checkAssetMapping reports "(none)" when there are no asset inputs at all', () => {
  const problem = checkAssetMapping({ projects: {} }, 'node_modules/monaco-editor/min/vs');
  assert.match(problem, /\(none\)/);
});
