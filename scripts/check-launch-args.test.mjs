// Tests for scripts/check-launch-args.mjs. Run via
// `node --test scripts/check-launch-args.test.mjs` or
// `npm run test:scripts`.
//
// The gate parses with the TypeScript compiler rather than scanning text,
// so most of these cases are regressions from the four regex-based
// revisions that preceded it -- each one accepted or rejected valid source
// that a real parser handles for free.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EXPECTED_COMMON_LAUNCH_ARGS,
  lintInstancesLaunch,
  lintRepo,
  lintSharedConfig,
  listVitestConfigs,
} from './check-launch-args.mjs';

const ARGS_DECL = [
  'export const COMMON_LAUNCH_ARGS: readonly string[] = [',
  ...EXPECTED_COMMON_LAUNCH_ARGS.map((flag) => `  '${flag}',`),
  '];',
].join('\n');

const GOOD_RETURN =
  'return { provider: playwright({ launchOptions: { args: [...COMMON_LAUNCH_ARGS, ...extraArgs] } }) };';

/** Builds a shared-config source with a custom helper body. */
function helper(body, argsDecl = ARGS_DECL) {
  return [argsDecl, 'export function makeBrowserConfig(extraArgs = []) {', `  ${body}`, '}'].join(
    '\n',
  );
}

test('clean source produces no violations', () => {
  assert.deepEqual(lintSharedConfig(helper(GOOD_RETURN)), []);
});

test('accepts an arrow helper with a parenthesized object body', () => {
  const source = [
    ARGS_DECL,
    'export const makeBrowserConfig = (extraArgs = []) => ({',
    '  provider: playwright({ launchOptions: { args: [...COMMON_LAUNCH_ARGS, ...extraArgs] } }),',
    '});',
  ].join('\n');
  assert.deepEqual(lintSharedConfig(source), []);
});

// ---- COMMON_LAUNCH_ARGS -----------------------------------------------

test('flags a missing COMMON_LAUNCH_ARGS declaration', () => {
  const source = helper(GOOD_RETURN, '');
  const violations = lintSharedConfig(source);
  assert.ok(violations.some((v) => /could not find a .*COMMON_LAUNCH_ARGS/.test(v)));
});

test('flags a dropped flag', () => {
  const decl = "export const COMMON_LAUNCH_ARGS = ['--no-sandbox', '--disable-gpu'];";
  const violations = lintSharedConfig(helper(GOOD_RETURN, decl));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /--disable-dev-shm-usage/);
});

test('flags a reordered flag list (argv order is load-bearing)', () => {
  const decl =
    "export const COMMON_LAUNCH_ARGS = ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'];";
  const violations = lintSharedConfig(helper(GOOD_RETURN, decl));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /but expected/);
});

test('flags an added unexpected flag', () => {
  const decl =
    "export const COMMON_LAUNCH_ARGS = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--single-process'];";
  const violations = lintSharedConfig(helper(GOOD_RETURN, decl));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /--single-process/);
});

// A spread lets the runtime array carry flags the gate never sees. The
// previous revision collected only quoted literals and ignored the rest.
test('flags a spread inside COMMON_LAUNCH_ARGS', () => {
  const decl =
    "export const COMMON_LAUNCH_ARGS = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', ...MORE_FLAGS];";
  const violations = lintSharedConfig(helper(GOOD_RETURN, decl));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /only direct string literals/);
  assert.match(violations[0], /\.\.\.MORE_FLAGS/);
});

test('flags a function call inside COMMON_LAUNCH_ARGS', () => {
  const decl =
    "export const COMMON_LAUNCH_ARGS = ['--no-sandbox', '--disable-gpu', computeFlag()];";
  const violations = lintSharedConfig(helper(GOOD_RETURN, decl));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /only direct string literals/);
});

test('flags a non-array COMMON_LAUNCH_ARGS', () => {
  const violations = lintSharedConfig(helper(GOOD_RETURN, 'export const COMMON_LAUNCH_ARGS = x;'));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /must be an array literal/);
});

// ---- the returned provider --------------------------------------------

test('flags a reversed composition', () => {
  const body =
    'return { provider: playwright({ launchOptions: { args: [...extraArgs, ...COMMON_LAUNCH_ARGS] } }) };';
  const violations = lintSharedConfig(helper(body));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /out of order or carry extra entries/);
});

test('flags a dropped COMMON_LAUNCH_ARGS spread', () => {
  const body = 'return { provider: playwright({ launchOptions: { args: [...extraArgs] } }) };';
  const violations = lintSharedConfig(helper(body));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /does not spread COMMON_LAUNCH_ARGS/);
});

test('flags a dropped extraArgs spread -- breaks ensureGc()', () => {
  const body =
    'return { provider: playwright({ launchOptions: { args: [...COMMON_LAUNCH_ARGS] } }) };';
  const violations = lintSharedConfig(helper(body));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /does not spread extraArgs/);
});

test('flags an extra inline entry in the composition', () => {
  const body =
    "return { provider: playwright({ launchOptions: { args: [...COMMON_LAUNCH_ARGS, '--x', ...extraArgs] } }) };";
  const violations = lintSharedConfig(helper(body));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /out of order or carry extra entries/);
});

test('flags an empty args array', () => {
  const body = 'return { provider: playwright({ launchOptions: { args: [] } }) };';
  const violations = lintSharedConfig(helper(body));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /spreads neither/);
});

test('flags a missing makeBrowserConfig helper outright', () => {
  const violations = lintSharedConfig(ARGS_DECL);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /could not find a .*makeBrowserConfig/);
});

// A whole-tree, last-match lookup let a nested declaration with the
// expected shape mask a bad top-level one -- the gate passed while the
// runtime used the bad exported value.
test('a nested declaration cannot shadow a bad top-level one', () => {
  const source = [
    "export const COMMON_LAUNCH_ARGS: readonly string[] = ['--wrong'];",
    'export function makeBrowserConfig(extraArgs = []) {',
    '  return { provider: someOtherProvider() };',
    '}',
    'function decoyScope() {',
    "  const COMMON_LAUNCH_ARGS = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];",
    '  function makeBrowserConfig(extraArgs = []) {',
    '    return { provider: playwright({ launchOptions: { args: [...COMMON_LAUNCH_ARGS, ...extraArgs] } }) };',
    '  }',
    '}',
  ].join('\n');
  const violations = lintSharedConfig(source);
  assert.equal(violations.length, 2, `expected both invariants to fail: ${violations.join(' | ')}`);
  assert.ok(violations.some((v) => /--wrong/.test(v)));
  assert.ok(violations.some((v) => /must be a `playwright/.test(v)));
});

test('rejects duplicate top-level COMMON_LAUNCH_ARGS declarations', () => {
  const source = [ARGS_DECL, "const COMMON_LAUNCH_ARGS = ['--other'];", ''].join('\n');
  const violations = lintSharedConfig(source + helper(GOOD_RETURN, ''));
  assert.ok(violations.some((v) => /2 top-level `COMMON_LAUNCH_ARGS` declarations/.test(v)));
});

test('rejects duplicate top-level makeBrowserConfig declarations', () => {
  const source = [
    ARGS_DECL,
    'export function makeBrowserConfig(extraArgs = []) {',
    `  ${GOOD_RETURN}`,
    '}',
    'function makeBrowserConfig(extraArgs = []) {',
    '  return { provider: other() };',
    '}',
  ].join('\n');
  const violations = lintSharedConfig(source);
  assert.ok(
    violations.some((v) => /2 top-level `makeBrowserConfig\(\.\.\.\)` declarations/.test(v)),
  );
});

test('flags a helper that returns no object literal', () => {
  const violations = lintSharedConfig(helper('return buildConfig(extraArgs);'));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /does not return an object literal/);
});

// EVERY return path is the object Vitest might receive. Iterating only the
// block's own statements missed a return nested in an `if`, and keeping the
// last match let an early conditional return ship a bad provider.
test('flags an early conditional return with a non-playwright provider', () => {
  const body = ['if (fallback) return { provider: webdriverio({}) };', `  ${GOOD_RETURN}`].join(
    '\n',
  );
  const violations = lintSharedConfig(helper(body));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /must be a `playwright/);
  assert.match(violations[0], /return path 1 of 2/);
});

test('flags an early conditional return that drops COMMON_LAUNCH_ARGS', () => {
  const body = [
    'if (fallback) { return { provider: playwright({ launchOptions: { args: [...extraArgs] } }) }; }',
    `  ${GOOD_RETURN}`,
  ].join('\n');
  const violations = lintSharedConfig(helper(body));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /does not spread COMMON_LAUNCH_ARGS/);
  assert.match(violations[0], /return path 1 of 2/);
});

test('accepts a helper whose every return path is correct', () => {
  const body = [`if (fallback) ${GOOD_RETURN}`, `  ${GOOD_RETURN}`].join('\n');
  assert.deepEqual(lintSharedConfig(helper(body)), []);
});

// A spread after a protected field lets a caller replace it, and the gate
// -- which validates the literal -- would still pass. This is the hole that
// existed in vitest.shared.mts itself: `...overrides` came last.
test('flags a spread after the provider property', () => {
  const body = `return { ${GOOD_RETURN.slice('return { '.length, -3)}, ...overrides };`;
  const violations = lintSharedConfig(helper(body));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /spreads `overrides` after `provider`/);
});

test('flags a spread after the instances property', () => {
  const body = [
    'return {',
    '    provider: playwright({ launchOptions: { args: [...COMMON_LAUNCH_ARGS, ...extraArgs] } }),',
    "    instances: [{ browser: 'chromium' }],",
    '    ...overrides,',
    '  };',
  ].join('\n');
  const violations = lintSharedConfig(helper(body));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /after `provider`|after `instances`/);
});

test('accepts a spread that comes before the protected fields', () => {
  const body = [
    'return {',
    '    ...overrides,',
    '    provider: playwright({ launchOptions: { args: [...COMMON_LAUNCH_ARGS, ...extraArgs] } }),',
    "    instances: [{ browser: 'chromium' }],",
    '  };',
  ].join('\n');
  assert.deepEqual(lintSharedConfig(helper(body)), []);
});

test('flags a bare `return;` path', () => {
  const body = ['if (skip) return;', `  ${GOOD_RETURN}`].join('\n');
  const violations = lintSharedConfig(helper(body));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /does not return an object literal/);
});

// A nested callback's `return` belongs to the callback, not the helper.
test('ignores returns inside a nested function', () => {
  const body = [
    'const pick = () => { return { provider: webdriverio({}) }; };',
    `  ${GOOD_RETURN}`,
  ].join('\n');
  assert.deepEqual(lintSharedConfig(helper(body)), []);
});

test('flags a returned object with no provider property', () => {
  const violations = lintSharedConfig(helper('return { headless: true };'));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /no top-level `provider` property/);
});

test('flags a provider that is not a playwright() call', () => {
  const violations = lintSharedConfig(helper('return { provider: webdriverio({}) };'));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /must be a `playwright\(\{ \.\.\. \}\)` call/);
});

test('flags a playwright() call with no launchOptions.args', () => {
  const violations = lintSharedConfig(helper('return { provider: playwright({}) };'));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /no `launchOptions.args`/);
});

// ---- decoys (regressions from the regex-based revisions) ---------------

test('a quoted decoy cannot satisfy the provider check', () => {
  const body = [
    'const help = "provider: playwright({ launchOptions: { args: [...COMMON_LAUNCH_ARGS, ...extraArgs] } })";',
    '  return { provider: somethingElse(), help };',
  ].join('\n');
  const violations = lintSharedConfig(helper(body));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /must be a `playwright/);
});

test('an unused helper with the right shape does not satisfy the gate', () => {
  const source = [
    ARGS_DECL,
    'const unused = playwright({ launchOptions: { args: [...COMMON_LAUNCH_ARGS, ...extraArgs] } });',
    'export function makeBrowserConfig(extraArgs = []) {',
    '  return { provider: webdriverio({ launchOptions: { args: [] } }) };',
    '}',
  ].join('\n');
  const violations = lintSharedConfig(source);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /must be a `playwright/);
});

test('an in-helper decoy does not satisfy the gate', () => {
  const body = [
    'const unused = { provider: playwright({ launchOptions: { args: [...COMMON_LAUNCH_ARGS, ...extraArgs] } }) };',
    '  return { provider: someOtherProvider() };',
  ].join('\n');
  const violations = lintSharedConfig(helper(body));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /must be a `playwright/);
});

// The returned object itself can carry a nested decoy: only the TOP-LEVEL
// `provider` is the property Vitest consumes.
test('a nested provider inside the returned object does not satisfy the gate', () => {
  const body = [
    'return {',
    '    options: { provider: playwright({ launchOptions: { args: [...COMMON_LAUNCH_ARGS, ...extraArgs] } }) },',
    '    provider: someOtherProvider(),',
    '  };',
  ].join('\n');
  const violations = lintSharedConfig(helper(body));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /must be a `playwright/);
});

test('`myprovider:` does not satisfy the provider check', () => {
  const body =
    'return { myprovider: playwright({ launchOptions: { args: [...COMMON_LAUNCH_ARGS, ...extraArgs] } }) };';
  const violations = lintSharedConfig(helper(body));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /no top-level `provider` property/);
});

// ---- instances[].launch ------------------------------------------------

test('lintInstancesLaunch accepts an instances entry with no launch field', () => {
  const source = "const c = { instances: [{ browser: 'chromium' }] };";
  assert.deepEqual(lintInstancesLaunch(source, 'x.mts'), []);
});

test('lintInstancesLaunch flags the PR #418 regression shape', () => {
  const source = "const c = { instances: [{ browser: 'chromium', launch: { args: [] } }] };";
  const violations = lintInstancesLaunch(source, 'x.mts');
  assert.equal(violations.length, 1);
  assert.match(violations[0], /PR #418/);
});

test('lintInstancesLaunch flags launch nested deeper inside the array', () => {
  const source = "const c = { instances: [{ browser: 'chromium', opts: { launch: {} } }] };";
  assert.equal(lintInstancesLaunch(source, 'x.mts').length, 1);
});

test('lintInstancesLaunch ignores a launch key AFTER the instances array closes', () => {
  const source =
    "const c = { instances: [{ browser: 'chromium' }], server: { launch: 'unrelated' } };";
  assert.deepEqual(lintInstancesLaunch(source, 'x.mts'), []);
});

test('lintInstancesLaunch ignores `launch:` inside a string-valued option', () => {
  const source =
    "const c = { instances: [{ browser: 'chromium', note: 'do not use launch: here' }] };";
  assert.deepEqual(lintInstancesLaunch(source, 'x.mts'), []);
});

test('lintInstancesLaunch ignores the shape inside a template literal', () => {
  const source =
    "const c = { instances: [{ browser: 'chromium' }], msg: `write instances: [{ launch: {} }] never` };";
  assert.deepEqual(lintInstancesLaunch(source, 'x.mts'), []);
});

// A regex literal is neither a string nor a comment, so a hand-rolled
// scanner treated its contents as code.
test('lintInstancesLaunch ignores the shape inside a regex literal', () => {
  const source = [
    'const pattern = /instances: [{ launch: {} }]/;',
    "const c = { instances: [{ browser: 'chromium' }] };",
  ].join('\n');
  assert.deepEqual(lintInstancesLaunch(source, 'x.mts'), []);
});

test('lintInstancesLaunch ignores a commented-out launch', () => {
  const source = "// instances: [{ browser: 'chromium', launch: { args: [] } }],";
  assert.deepEqual(lintInstancesLaunch(source, 'x.mts'), []);
});

// `['launch']` creates exactly the same runtime property as `launch:`, and
// @vitest/browser-playwright ignores it identically.
test('lintInstancesLaunch flags a computed string key', () => {
  const source = "const c = { instances: [{ browser: 'chromium', ['launch']: { args: [] } }] };";
  assert.equal(lintInstancesLaunch(source, 'x.mts').length, 1);
});

test('lintInstancesLaunch flags a computed template key', () => {
  const source = 'const c = { instances: [{ [`launch`]: {} }] };';
  assert.equal(lintInstancesLaunch(source, 'x.mts').length, 1);
});

// A shorthand assignment puts the array in a separate binding, which the
// gate previously skipped entirely.
test('lintInstancesLaunch resolves a shorthand instances binding', () => {
  const source = [
    'const instances = [{ launch: {} }];',
    'export default defineConfig({ instances });',
  ].join('\n');
  assert.equal(lintInstancesLaunch(source, 'x.mts').length, 1);
});

test('lintInstancesLaunch resolves a named instances binding', () => {
  const source = [
    'const list = [{ launch: {} }];',
    'export default defineConfig({ instances: list });',
  ].join('\n');
  assert.equal(lintInstancesLaunch(source, 'x.mts').length, 1);
});

test('lintInstancesLaunch accepts a clean shorthand binding', () => {
  const source = [
    "const instances = [{ browser: 'chromium' }];",
    'export default defineConfig({ instances });',
  ].join('\n');
  assert.deepEqual(lintInstancesLaunch(source, 'x.mts'), []);
});

// An unresolvable value is reported rather than assumed clean -- the gate
// cannot rule out the #418 shape behind a function call.
test('lintInstancesLaunch reports an unresolvable instances value', () => {
  const source = 'export default defineConfig({ instances: buildInstances() });';
  const violations = lintInstancesLaunch(source, 'x.mts');
  assert.equal(violations.length, 1);
  assert.match(violations[0], /cannot resolve/);
});

test('lintInstancesLaunch still flags a real launch beside a string decoy', () => {
  const source =
    "const c = { instances: [{ browser: 'chromium', note: 'launch: mentioned', launch: { args: [] } }] };";
  assert.equal(lintInstancesLaunch(source, 'x.mts').length, 1);
});

test('lintInstancesLaunch scans every instances array, not just the first', () => {
  const source = [
    "const a = { instances: [{ browser: 'chromium' }] };",
    "const b = { instances: [{ browser: 'firefox', launch: {} }] };",
  ].join('\n');
  assert.equal(lintInstancesLaunch(source, 'x.mts').length, 1);
});

// ---- repo wiring -------------------------------------------------------

test('listVitestConfigs finds the real repo configs including the shared substrate', () => {
  const configs = listVitestConfigs();
  for (const name of ['vitest.shared.mts', 'vitest.config.mts', 'vitest.perf.config.mts']) {
    assert.ok(configs.includes(name), `expected ${name}`);
  }
});

test('the real repo passes every invariant', () => {
  const { violations, scanned } = lintRepo();
  assert.deepEqual(violations, [], `expected a clean repo, got: ${violations.join(' | ')}`);
  assert.ok(scanned >= 3, `expected at least 3 vitest configs, scanned ${scanned}`);
});
