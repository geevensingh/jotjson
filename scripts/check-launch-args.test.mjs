// Tests for scripts/check-launch-args.mjs. Run via
// `node --test scripts/check-launch-args.test.mjs` or
// `npm run test:scripts`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EXPECTED_COMMON_LAUNCH_ARGS,
  extractInstancesArrays,
  lintInstancesLaunch,
  lintRepo,
  lintSharedConfig,
  listVitestConfigs,
  maskStringLiterals,
  parseArrayLiterals,
  stripComments,
} from './check-launch-args.mjs';

/** A minimal source that satisfies every invariant. */
function goodSource({
  args = EXPECTED_COMMON_LAUNCH_ARGS,
  composition = '...COMMON_LAUNCH_ARGS, ...extraArgs',
} = {}) {
  return `
export const COMMON_LAUNCH_ARGS: readonly string[] = [
${args.map((flag) => `  '${flag}',`).join('\n')}
];

export function makeBrowserConfig(extraArgs = [], overrides = {}) {
  return {
    enabled: true,
    provider: playwright({
      launchOptions: {
        args: [${composition}],
      },
    }),
    instances: [{ browser: 'chromium' }],
    ...overrides,
  };
}
`;
}

test('clean source produces no violations', () => {
  assert.deepEqual(lintSharedConfig(goodSource()), []);
});

test('flags a missing COMMON_LAUNCH_ARGS declaration', () => {
  const source = goodSource().replace(/export const COMMON_LAUNCH_ARGS[\s\S]*?\];/, '');
  const violations = lintSharedConfig(source);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /could not find an .*COMMON_LAUNCH_ARGS/);
});

test('flags a dropped flag', () => {
  const violations = lintSharedConfig(goodSource({ args: ['--no-sandbox', '--disable-gpu'] }));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /but expected/);
  assert.match(violations[0], /--disable-dev-shm-usage/);
});

test('flags a reordered flag list (argv order is load-bearing)', () => {
  const reordered = ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'];
  const violations = lintSharedConfig(goodSource({ args: reordered }));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /but expected/);
});

test('flags an added unexpected flag', () => {
  const extra = [...EXPECTED_COMMON_LAUNCH_ARGS, '--single-process'];
  const violations = lintSharedConfig(goodSource({ args: extra }));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /--single-process/);
});

test('flags a dropped COMMON_LAUNCH_ARGS spread -- the silent-strip regression', () => {
  const violations = lintSharedConfig(goodSource({ composition: '...extraArgs' }));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /does not spread COMMON_LAUNCH_ARGS/);
});

test('flags a dropped extraArgs spread -- breaks ensureGc()', () => {
  const violations = lintSharedConfig(goodSource({ composition: '...COMMON_LAUNCH_ARGS' }));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /does not spread extraArgs/);
});

// Order is load-bearing: `args` is a flat argv and Chromium honors the last
// occurrence of a repeated switch, so extraArgs must be appended, not
// prepended. An earlier revision tested for the two spreads independently
// and accepted this.
test('flags a reversed composition even though both spreads are present', () => {
  const violations = lintSharedConfig(
    goodSource({ composition: '...extraArgs, ...COMMON_LAUNCH_ARGS' }),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /out of order or carry extra entries/);
});

test('flags a duplicated spread', () => {
  const violations = lintSharedConfig(
    goodSource({ composition: '...COMMON_LAUNCH_ARGS, ...COMMON_LAUNCH_ARGS, ...extraArgs' }),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /out of order or carry extra entries/);
});

test('flags an extra inline entry smuggled into the composition', () => {
  const violations = lintSharedConfig(
    goodSource({ composition: "...COMMON_LAUNCH_ARGS, '--single-process', ...extraArgs" }),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /out of order or carry extra entries/);
});

test('flags an empty args array', () => {
  const violations = lintSharedConfig(goodSource({ composition: '' }));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /spreads neither/);
});

test('accepts a trailing comma in the composition', () => {
  assert.deepEqual(
    lintSharedConfig(goodSource({ composition: '...COMMON_LAUNCH_ARGS, ...extraArgs,' })),
    [],
  );
});

test('flags a missing playwright() factory call', () => {
  const source = goodSource().replace(
    /provider: playwright\([\s\S]*?\}\),/,
    'provider: someOtherProvider(),',
  );
  const violations = lintSharedConfig(source);
  assert.ok(violations.some((v) => /could not find a .*playwright\(/.test(v)));
});

test('accepts whitespace and newline variation inside the factory call', () => {
  const source = goodSource({
    composition: '\n        ...COMMON_LAUNCH_ARGS,\n        ...extraArgs,\n      ',
  });
  assert.deepEqual(lintSharedConfig(source), []);
});

// stripComments keeps string contents by design, so the structural matchers
// run against masked literals. Without that, a quoted decoy satisfies the
// gate while the real provider is broken -- a false negative in the guard.
test('a quoted decoy cannot satisfy the provider check', () => {
  const source = `
export const COMMON_LAUNCH_ARGS: readonly string[] = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
];

export function makeBrowserConfig(extraArgs = []) {
  const help = "provider: playwright({ launchOptions: { args: [...COMMON_LAUNCH_ARGS, ...extraArgs] } })";
  return { provider: somethingElse(), help };
}
`;
  const violations = lintSharedConfig(source);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /could not find a .*provider: playwright/);
});

test('a quoted decoy cannot mask a reversed real composition', () => {
  const source = `
export const COMMON_LAUNCH_ARGS: readonly string[] = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
];

export function makeBrowserConfig(extraArgs = []) {
  const doc = \`provider: playwright({ launchOptions: { args: [...COMMON_LAUNCH_ARGS, ...extraArgs] } })\`;
  return {
    provider: playwright({ launchOptions: { args: [...extraArgs, ...COMMON_LAUNCH_ARGS] } }),
    doc,
  };
}
`;
  const violations = lintSharedConfig(source);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /out of order or carry extra entries/);
});

// An unanchored playwright(...) matcher would be satisfied by an unused
// helper while makeBrowserConfig actually returned a different provider.
test('an unused helper with the right shape does not satisfy the gate', () => {
  const source = `
export const COMMON_LAUNCH_ARGS: readonly string[] = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
];

const unused = playwright({ launchOptions: { args: [...COMMON_LAUNCH_ARGS, ...extraArgs] } });

export function makeBrowserConfig(extraArgs = []) {
  return { provider: webdriverio({ launchOptions: { args: [] } }) };
}
`;
  const violations = lintSharedConfig(source);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /could not find a .*provider: playwright/);
});

test('the real flag literals are still read through the mask', () => {
  // Masking preserves length, so capture offsets index the unmasked source.
  // If that slicing were wrong, the declared flags would read as empty and
  // this would report a mismatch instead of passing.
  assert.deepEqual(lintSharedConfig(goodSource()), []);
  const violations = lintSharedConfig(goodSource({ args: ['--no-sandbox', '--disable-gpu'] }));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /--disable-dev-shm-usage/);
});

test('maskStringLiterals preserves length and blanks only literal contents', () => {
  const source = `const a = "hello"; const b = 1;`;
  const masked = maskStringLiterals(source);
  assert.equal(masked.length, source.length);
  assert.ok(!masked.includes('hello'), 'literal content should be masked');
  assert.ok(masked.includes('const b = 1;'), 'code outside literals is untouched');
});

test('maskStringLiterals is not fooled by an escaped quote', () => {
  const source = 'const a = "he\\"llo world"; const b = 2;';
  const masked = maskStringLiterals(source);
  assert.equal(masked.length, source.length);
  assert.ok(!masked.includes('world'), 'escaped quote must not end the literal early');
  assert.ok(masked.includes('const b = 2;'));
});

test('lintInstancesLaunch accepts an instances entry with no launch field', () => {
  assert.deepEqual(lintInstancesLaunch(goodSource(), 'vitest.config.mts'), []);
});

test('lintInstancesLaunch flags the PR #418 regression shape', () => {
  const source = `
  instances: [{ browser: 'chromium', launch: { args: ['--no-sandbox'] } }],
`;
  const violations = lintInstancesLaunch(source, 'vitest.config.mts');
  assert.equal(violations.length, 1);
  assert.match(violations[0], /instances/);
  assert.match(violations[0], /PR #418/);
});

test('lintInstancesLaunch flags `launch :` with stray whitespace', () => {
  const source = `instances: [{ browser: 'chromium', launch : {} }],`;
  assert.equal(lintInstancesLaunch(source, 'x.mts').length, 1);
});

// Regression: the first revision matched with an unbounded `[\s\S]*?`, which
// ran past the array's closing `]` and flagged an unrelated later `launch:`.
// A false positive in a lint gate blocks valid work, which is worse than the
// miss it guards against.
test('lintInstancesLaunch ignores a launch key AFTER the instances array closes', () => {
  const source = [
    "instances: [{ browser: 'chromium' }],",
    '  onConsoleLog: () => {},',
    "  server: { launch: 'unrelated property' },",
  ].join('\n');
  assert.deepEqual(lintInstancesLaunch(source, 'x.mts'), []);
});

test('lintInstancesLaunch still flags launch nested deeper inside the array', () => {
  const source = "instances: [{ browser: 'chromium', opts: { launch: { args: [] } } }],";
  assert.equal(lintInstancesLaunch(source, 'x.mts').length, 1);
});

test('lintInstancesLaunch is not fooled by a bracket inside a string literal', () => {
  const source = ["instances: [{ browser: 'chrom]ium' }],", "  other: { launch: 'x' },"].join('\n');
  assert.deepEqual(lintInstancesLaunch(source, 'x.mts'), []);
});

test('lintInstancesLaunch scans every instances array, not just the first', () => {
  const source = [
    "instances: [{ browser: 'chromium' }],",
    'other: 1,',
    "instances: [{ browser: 'firefox', launch: {} }],",
  ].join('\n');
  assert.equal(lintInstancesLaunch(source, 'x.mts').length, 1);
});

test('extractInstancesArrays returns one body per instances array', () => {
  const bodies = extractInstancesArrays(
    'instances: [{ a: 1 }], x: 2, instances: [{ b: [3, 4] }], y: 3',
  );
  assert.equal(bodies.length, 2);
  assert.match(bodies[0], /a: 1/);
  assert.match(bodies[1], /b: \[3, 4\]/);
  assert.ok(!bodies[0].includes('x: 2'), 'first body must stop at its closing bracket');
});

// Regression: opener discovery used a plain regex, which matched inside
// string literals. `stripComments` preserves string contents by design, so
// a log message or error string quoting the shape looked like a real array.
test('lintInstancesLaunch ignores the full violating shape inside a string literal', () => {
  const source = [
    "instances: [{ browser: 'chromium' }],",
    '  onConsoleLog: (line) => {',
    '    report("bad config: instances: [{ launch: { args: [] } }]");',
    '  },',
  ].join('\n');
  assert.deepEqual(lintInstancesLaunch(source, 'x.mts'), []);
});

test('lintInstancesLaunch ignores the shape inside a template literal', () => {
  const source = [
    "instances: [{ browser: 'chromium' }],",
    '  message: `do not write instances: [{ launch: {} }] here`,',
  ].join('\n');
  assert.deepEqual(lintInstancesLaunch(source, 'x.mts'), []);
});

test('lintInstancesLaunch still flags a real array that follows a quoted decoy', () => {
  const source = [
    'message: "instances: [{ launch: {} }]",',
    "instances: [{ browser: 'chromium', launch: { args: [] } }],",
  ].join('\n');
  assert.equal(lintInstancesLaunch(source, 'x.mts').length, 1);
});

test('extractInstancesArrays does not treat a quoted opener as an array', () => {
  assert.deepEqual(extractInstancesArrays('const s = "instances: [{ a: 1 }]";'), []);
});

test('extractInstancesArrays requires an identifier boundary', () => {
  assert.deepEqual(extractInstancesArrays('myinstances: [{ a: 1 }]'), []);
});

test('extractInstancesArrays tolerates an unbalanced array', () => {
  const bodies = extractInstancesArrays("instances: [{ browser: 'chromium' }");
  assert.equal(bodies.length, 1);
  assert.match(bodies[0], /chromium/);
});

test('parseArrayLiterals extracts single, double, and backtick literals', () => {
  assert.deepEqual(parseArrayLiterals(`'a', "b", \`c\``), ['a', 'b', 'c']);
});

// Regression: the first revision of this gate matched the shape quoted
// in `vitest.shared.mts`'s own JSDoc instead of the real factory call,
// and reported a false violation against a clean repo.
test('ignores a correct-looking shape quoted in a block comment', () => {
  const source = `
/**
 * Launch options are read only from the
 * \`playwright({ launchOptions: { args: [...] } })\` factory argument.
 */
export const COMMON_LAUNCH_ARGS: readonly string[] = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
];
export function makeBrowserConfig(extraArgs = []) {
  return {
    provider: playwright({ launchOptions: { args: [...COMMON_LAUNCH_ARGS, ...extraArgs] } }),
  };
}
`;
  assert.deepEqual(lintSharedConfig(source), []);
});

test('a commented-out instances[].launch does not trip the #418 guard', () => {
  const source = `// instances: [{ browser: 'chromium', launch: { args: [] } }],`;
  assert.deepEqual(lintInstancesLaunch(source, 'x.mts'), []);
});

test('stripComments removes comments but preserves string contents', () => {
  assert.equal(stripComments(`const a = 1; // trailing`).trim(), 'const a = 1;');
  assert.equal(stripComments(`/* block */const b = 2;`).trim(), 'const b = 2;');
  assert.equal(stripComments(`const url = 'http://x/y';`).trim(), `const url = 'http://x/y';`);
  assert.equal(
    stripComments(`const s = "a /* not a comment */ b";`).trim(),
    `const s = "a /* not a comment */ b";`,
  );
});

test('stripComments preserves newlines so line numbers stay meaningful', () => {
  const stripped = stripComments('a\n/* one\ntwo\nthree */\nb');
  assert.equal(stripped.split('\n').length, 5);
});

test('listVitestConfigs finds the real repo configs including the shared substrate', () => {
  const configs = listVitestConfigs();
  assert.ok(configs.includes('vitest.shared.mts'), 'expected vitest.shared.mts');
  assert.ok(configs.includes('vitest.config.mts'), 'expected vitest.config.mts');
  assert.ok(configs.includes('vitest.perf.config.mts'), 'expected vitest.perf.config.mts');
});

test('the real repo passes every invariant', () => {
  const { violations, scanned } = lintRepo();
  assert.deepEqual(violations, [], `expected a clean repo, got: ${violations.join(' | ')}`);
  assert.ok(scanned >= 3, `expected at least 3 vitest configs, scanned ${scanned}`);
});
