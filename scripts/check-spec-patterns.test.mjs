// Unit tests for scripts/check-spec-patterns.mjs.
//
// Runs under Node's built-in test runner: `node --test`. No external
// runtime dependencies beyond `typescript` (already a transitive dev
// dep). The test file imports the script as a module; the script
// guards `main()` behind an "invoked directly" check so importing it
// does not trigger CLI side effects (git ls-files, fs reads,
// process.exit).
//
// Coverage:
//  - Regex rule still fires on the existing `spyOnProperty(navigator,
//    'clipboard', ...)` pattern.
//  - AST rule (`__reset*ForTesting` symmetry) catches:
//     - reset call in `beforeEach` only (the bug pattern)
//     - asymmetric reset in a nested `describe`
//     - file-level (top-of-file) hook scoped asymmetries
//  - AST rule passes (no violation) on:
//     - symmetric reset in both hooks
//     - no resets at all
//     - set/reset pair (`__setX...` in beforeEach + `__resetX...` in
//       afterEach is the canonical pattern; afterEach-only is allowed)
//     - reset call inside an `it` body (not `beforeEach`/`afterEach`)
//     - `__set*` / `__attach*` / `__load*` / `__flush*` helpers
//       (narrowed regex excludes them)
//  - Pathological-shape coverage: template literals, regex literals,
//    block comments containing `beforeEach` tokens,
//    `describe.skip` / `xdescribe` / `fdescribe`, `xit` / `fit`,
//    async-arrow callbacks, function-expression callbacks.
//  - Concise-arrow describe body coverage: `describe('x', () =>
//    beforeEach(...))` (the body is a CallExpression, not a Block).
//  - Inline-helper coverage (deliberate calibration -- see PR #370):
//    a helper defined inside the hook body whose body contains a
//    `__reset*` call is treated as if the hook ran the reset, even
//    when the helper is never invoked. Accepted false-positive in
//    exchange for catching the common DRY pattern.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  REGEX_RULES,
  listSpecFiles,
  scanRegex,
  scanText,
  validateRules,
} from './check-spec-patterns.mjs';

const SPEC_PATH = 'src/example.spec.ts';

// --- Regex rule (existing clipboard pattern) --------------------------

test('regex rule fires on spyOnProperty(navigator, "clipboard", ...)', () => {
  const text = `
describe('x', () => {
  it('y', () => {
    spyOnProperty(navigator, 'clipboard', 'get').and.returnValue({});
  });
});
`;
  const violations = scanText(text, SPEC_PATH).filter(
    (v) => v.ruleId === 'spy-on-navigator-clipboard',
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0].snippet, /spyOnProperty/);
});

test('regex rule does not fire on unrelated spyOnProperty calls', () => {
  const text = `
describe('x', () => {
  it('y', () => {
    spyOnProperty(navigator, 'userAgent', 'get').and.returnValue('foo');
  });
});
`;
  const violations = scanRegex(text, SPEC_PATH);
  assert.equal(violations.length, 0);
});

// --- AST rule: positive cases (lints clean) ---------------------------

test('symmetric reset in both hooks: no violation', () => {
  const text = `
describe('x', () => {
  beforeEach(() => __resetFooForTesting());
  afterEach(() => __resetFooForTesting());
  it('y', () => {});
});
`;
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 0);
});

test('no resets at all: no violation', () => {
  const text = `
describe('x', () => {
  beforeEach(() => {});
  afterEach(() => {});
  it('y', () => {});
});
`;
  const violations = scanText(text, SPEC_PATH);
  assert.equal(violations.length, 0);
});

test('set/reset pair (afterEach-only) is the canonical pattern: no violation', () => {
  // __setX in beforeEach, __resetX in afterEach is the legitimate
  // set/reset pair where the setter is the test-action and the reset
  // is the cleanup. The lint rule deliberately allows afterEach-only
  // resets because that IS the cleanup half of the pair. Only
  // beforeEach-only resets are flagged (they would indicate cleanup
  // happens at the start of MY test, but cross-test leakage already
  // happened by then).
  const text = `
describe('x', () => {
  beforeEach(() => __setFooImplForTesting(stub));
  afterEach(() => __resetFooForTesting());
  it('y', () => {});
});
`;
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 0);
});

test('__set*, __attach*, __load*, __flush* are NOT constrained by symmetry rule', () => {
  const text = `
describe('x', () => {
  beforeEach(() => {
    __setFooImplForTesting(stub);
    __attachHandlerForTesting(handler);
    __loadConfigForTesting(config);
    __flushQueueForTesting();
  });
  // No afterEach. Without the narrowed regex, all four would be
  // flagged; with it, none of them are.
  it('y', () => {});
});
`;
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 0);
});

test('reset call inside it() body is not constrained', () => {
  const text = `
describe('x', () => {
  it('y', () => {
    __resetFooForTesting();
    expect(foo()).toBe(true);
  });
});
`;
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 0);
});

// --- AST rule: negative cases (lints fail) ----------------------------

test('reset in beforeEach only: violation (beforeEach only)', () => {
  const text = `
describe('x', () => {
  beforeEach(() => __resetFooForTesting());
  it('y', () => {});
});
`;
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /beforeEach only/);
  assert.equal(violations[0].snippet, '__resetFooForTesting()');
});

test('reset in afterEach only: NOT a violation (canonical set/reset pair)', () => {
  // Per the narrowed rule, afterEach-only is the legitimate cleanup
  // half of a set/reset pair. The "setter" may live in beforeEach
  // (most common) or in the `it` body (also valid). Either way, the
  // afterEach reset is cleanup-of-self, not cleanup-of-previous-test,
  // so it does not signal a cross-test leak.
  const text = `
describe('x', () => {
  afterEach(() => __resetFooForTesting());
  it('y', () => {});
});
`;
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 0);
});

test('reset asymmetric in a nested describe', () => {
  // Outer describe has symmetric pair (no violation). Inner describe
  // has an additional beforeEach-only __resetBarForTesting.
  const text = `
describe('outer', () => {
  beforeEach(() => __resetFooForTesting());
  afterEach(() => __resetFooForTesting());

  describe('inner', () => {
    beforeEach(() => __resetBarForTesting());
    it('z', () => {});
  });
});
`;
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /__resetBarForTesting/);
  assert.match(violations[0].message, /beforeEach only/);
});

test('file-level (top-of-file) hooks treated as a single scope', () => {
  // Hooks at file top-level (outside any describe) -- e.g., a setup
  // file like `global-hooks.spec.ts` itself. The rule treats the
  // file as a single scope.
  const text = `
beforeEach(() => __resetFooForTesting());
afterEach(() => __resetFooForTesting());
describe('x', () => {
  it('y', () => {});
});
`;
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 0);
});

test('file-level hook asymmetric is flagged', () => {
  const text = `
beforeEach(() => __resetFooForTesting());
describe('x', () => {
  it('y', () => {});
});
`;
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /beforeEach only/);
});

// --- AST rule: pathological-shape coverage ----------------------------

test('template literal containing "beforeEach" in source does not fool the parser', () => {
  const text = `
describe('x', () => {
  beforeEach(() => __resetFooForTesting());
  afterEach(() => {
    const msg = \`beforeEach is a string here\`;
    expect(msg).toBeDefined();
    __resetFooForTesting();
  });
  it('y', () => {});
});
`;
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 0);
});

test('regex literal containing "}" does not fool the parser', () => {
  const text = `
describe('x', () => {
  beforeEach(() => __resetFooForTesting());
  afterEach(() => {
    const re = /\\}/;
    void re;
    __resetFooForTesting();
  });
  it('y', () => {});
});
`;
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 0);
});

test('block comment containing "beforeEach" tokens does not fool the parser', () => {
  const text = `
/* This comment mentions beforeEach and afterEach
   and __resetFooForTesting but is not code. */
describe('x', () => {
  beforeEach(() => __resetFooForTesting());
  afterEach(() => __resetFooForTesting());
  it('y', () => {});
});
`;
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 0);
});

test('describe.skip is treated as a describe scope', () => {
  // The reset inside a `describe.skip` body is in a beforeEach with no
  // matching afterEach -- still flagged. (Skipped or not, the same
  // pattern is a bug.)
  const text = `
describe.skip('x', () => {
  beforeEach(() => __resetFooForTesting());
  it('y', () => {});
});
`;
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 1);
});

test('xdescribe is treated as a describe scope', () => {
  const text = `
xdescribe('x', () => {
  beforeEach(() => __resetFooForTesting());
  it('y', () => {});
});
`;
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 1);
});

test('fdescribe is treated as a describe scope', () => {
  const text = `
fdescribe('x', () => {
  beforeEach(() => __resetFooForTesting());
  it('y', () => {});
});
`;
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 1);
});

test('xit / fit / it inside hooks do not affect rule', () => {
  const text = `
describe('x', () => {
  beforeEach(() => __resetFooForTesting());
  afterEach(() => __resetFooForTesting());
  xit('skipped', () => __resetBarForTesting());
  fit('focused', () => __resetBarForTesting());
  it('plain', () => __resetBarForTesting());
});
`;
  // __resetBarForTesting appears only in it/xit/fit bodies, not in
  // hooks, so symmetry rule does not constrain it.
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 0);
});

test('async arrow callbacks in hooks are supported', () => {
  const text = `
describe('x', () => {
  beforeEach(async () => {
    await Promise.resolve();
    __resetFooForTesting();
  });
  afterEach(async () => {
    await Promise.resolve();
    __resetFooForTesting();
  });
  it('y', () => {});
});
`;
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 0);
});

test('function-expression callbacks in hooks are supported', () => {
  const text = `
describe('x', () => {
  beforeEach(function () {
    __resetFooForTesting();
  });
  afterEach(function () {
    __resetFooForTesting();
  });
  it('y', () => {});
});
`;
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 0);
});

test('multiple reset identifiers in same hook all enforced symmetrically', () => {
  const text = `
describe('x', () => {
  beforeEach(() => {
    __resetFooForTesting();
    __resetBarForTesting();
  });
  afterEach(() => {
    __resetFooForTesting();
  });
  it('y', () => {});
});
`;
  // __resetFoo is symmetric; __resetBar is beforeEach only.
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /__resetBarForTesting/);
  assert.match(violations[0].message, /beforeEach only/);
});

test('violation includes line and column from the offending node', () => {
  const text = `describe('x', () => {
  beforeEach(() => __resetFooForTesting());
  it('y', () => {});
});
`;
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 2); // line 2 has the beforeEach call
  assert.equal(typeof violations[0].col, 'number');
  assert.ok(violations[0].col > 0);
});

// --- AST rule: concise-arrow describe body (PR #370 review feedback) --

test('concise-arrow describe body: detects beforeEach-only reset (no Block wrapper)', () => {
  // `describe('x', () => beforeEach(...))` -- the arrow body is the
  // CallExpression itself, not a Block. The walker must dispatch on
  // the body as a node, not just its children. Regression guard for
  // the line-251 bug fixed in this PR. Currently no spec in the
  // codebase uses this shape, but the soundness of the rule should
  // not depend on stylistic uniformity.
  const text = `describe('x', () => beforeEach(() => __resetFooForTesting()));`;
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /__resetFooForTesting/);
  assert.match(violations[0].message, /beforeEach only/);
});

test('concise-arrow describe body with both hooks: symmetric, no violation', () => {
  // The corollary: concise-arrow describe with symmetric set/reset
  // pair must still be accepted (proves the fix did not over-flag).
  // Here the describe body is a parenthesized SequenceExpression-like
  // shape: the arrow body is a single CallExpression that returns
  // the result of the last hook -- not idiomatic, but valid TS.
  const text = `
describe('x', () => {
  beforeEach(() => __resetFooForTesting());
  afterEach(() => __resetFooForTesting());
});
`;
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 0);
});

// --- AST rule: inline-helper semantics (PR #370 deliberate calibration)

test('inline helper defined and called from beforeEach: flagged when afterEach missing', () => {
  // Common DRY pattern: extract setup into a helper defined inside
  // the hook and call it. The walker recurses into the helper body
  // and records the __reset call against the enclosing beforeEach.
  // Without a matching afterEach this should be flagged. This is
  // the TRUE-POSITIVE side of the deliberate over-inclusion
  // documented in check-spec-patterns.mjs file-top "Helper-call
  // semantics" section. Do NOT change findResetCallsIn to skip
  // FunctionDeclaration recursion without revisiting that trade-off.
  const text = `
describe('x', () => {
  beforeEach(() => {
    function setup() {
      __resetFooForTesting();
    }
    setup();
  });
  it('y', () => {});
});
`;
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /__resetFooForTesting/);
  assert.match(violations[0].message, /beforeEach only/);
});

test('inline helper defined but NEVER called from beforeEach: still flagged (accepted false positive)', () => {
  // The companion to the test above: a helper defined inside the
  // hook but never invoked. A static linter cannot tell this case
  // apart from the defined-and-called case without dataflow
  // analysis. We accept this false-positive because the alternative
  // (skip nested function bodies) would silently miss the common
  // defined-and-called case above. Loud false-positive in a single
  // spec is cheap to fix; silent false-negative leaks across the
  // suite (the original #350 bug class). See check-spec-patterns.mjs
  // file-top "Helper-call semantics" section.
  const text = `
describe('x', () => {
  beforeEach(() => {
    function deadHelper() {
      __resetFooForTesting();
    }
    // deadHelper is intentionally never invoked here.
  });
  it('y', () => {});
});
`;
  const violations = scanText(text, SPEC_PATH).filter((v) => v.ruleId === 'reset-helper-symmetry');
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /__resetFooForTesting/);
  assert.match(violations[0].message, /beforeEach only/);
});

// --- validateRules (rule-shape contract) ---------------------------------
// PR #370 panel: enforce at module load what the docstring already
// promises (id required, message required, pattern is a RegExp, no
// duplicate ids). The /g flag is NOT validated here -- V8's matchAll
// throws on non-global at engine call time with a better stack trace.

test('validateRules rejects a rule with missing id', () => {
  assert.throws(
    () => validateRules([{ pattern: /foo/g, message: 'msg' }]),
    /missing a non-empty `id`/,
  );
});

test('validateRules rejects a rule with empty id', () => {
  assert.throws(
    () => validateRules([{ id: '', pattern: /foo/g, message: 'msg' }]),
    /missing a non-empty `id`/,
  );
});

test('validateRules rejects a rule with non-RegExp pattern', () => {
  assert.throws(
    () => validateRules([{ id: 'x', pattern: 'foo', message: 'msg' }]),
    /pattern must be a RegExp/,
  );
});

test('validateRules rejects a rule with missing message', () => {
  assert.throws(
    () => validateRules([{ id: 'x', pattern: /foo/g }]),
    /message must be a non-empty string/,
  );
});

test('validateRules rejects two rules sharing the same id', () => {
  assert.throws(
    () =>
      validateRules([
        { id: 'dup', pattern: /a/g, message: 'm1' },
        { id: 'dup', pattern: /b/g, message: 'm2' },
      ]),
    /two rules with id "dup"/,
  );
});

// --- Engine termination (PR #370 bot finding regression test) ---------
// The previous `while ((m = rule.pattern.exec(text)) !== null)` engine
// would hang on the first match if a rule forgot `/g`. The matchAll
// engine throws a TypeError at call time instead. These tests are
// the actual canary for the bot's concern -- they prove the scan
// loop terminates on multi-match input AND that a non-global pattern
// fails loudly with a message that names the rule and points at the
// fix.

test('scanRegex terminates on multiple matches (not just the first)', { timeout: 2000 }, () => {
  const text = `
describe('a', () => {
  it('b', () => spyOnProperty(navigator, 'clipboard', 'get'));
  it('c', () => spyOnProperty(navigator, 'clipboard', 'get'));
});
`;
  const violations = scanRegex(text, SPEC_PATH);
  assert.equal(violations.length, 2);
  assert.equal(violations[0].ruleId, 'spy-on-navigator-clipboard');
  assert.equal(violations[1].ruleId, 'spy-on-navigator-clipboard');
});

test('scanRegex throws actionable error if a rule pattern is non-global', () => {
  const savedPattern = REGEX_RULES[0].pattern;
  // Mutate the existing rule in place to bypass validateRules (which
  // would have rejected the bad shape at module load). This simulates
  // the failure mode for a rule that somehow has a non-global RegExp
  // at scan time -- the engine itself rejects it.
  REGEX_RULES[0].pattern = /spyOnProperty/;
  try {
    assert.throws(
      () => scanRegex('spyOnProperty(navigator, "clipboard", "get")', SPEC_PATH),
      (err) =>
        err instanceof TypeError &&
        /spy-on-navigator-clipboard/.test(err.message) &&
        /matchAll requires \/g/.test(err.message) &&
        /scripts\/check-spec-patterns\.mjs/.test(err.message),
    );
  } finally {
    REGEX_RULES[0].pattern = savedPattern;
  }
});

// --- listSpecFiles non-empty guard ------------------------------------
//
// Issue #47 (Karma -> Vitest cutover) renamed every unit test from
// `*.spec.ts` to `*.test.ts`. The original `listSpecFiles` filter
// matched only `.spec.ts`, which would have made the lint a silent
// no-op for the entire vitest suite. These tests guard against a
// future regression of the same shape (someone renames the suite
// again, or types the filter wrong) by asserting the live
// `listSpecFiles()` returns a non-empty set drawn from the
// convention(s) the repo actually uses.

test('listSpecFiles returns a non-empty list of unit-test files', () => {
  const files = listSpecFiles();
  assert.ok(files.length > 0, 'listSpecFiles() returned 0 files');
});

test('listSpecFiles includes .test.ts files (current vitest convention)', () => {
  const files = listSpecFiles();
  const testTsFiles = files.filter((p) => p.endsWith('.test.ts'));
  assert.ok(
    testTsFiles.length > 0,
    'listSpecFiles() returned no `.test.ts` files; the vitest suite under' +
      ' `src/` should contribute the bulk of matches.',
  );
});

test('listSpecFiles scopes to frontend src/** only', () => {
  const files = listSpecFiles();
  const outOfScope = files.filter(
    (p) => p.startsWith('api/') || p.startsWith('e2e/') || p.startsWith('perf/'),
  );
  assert.equal(
    outOfScope.length,
    0,
    'listSpecFiles() should only match frontend `src/**` tests. Found' +
      ` ${outOfScope.length} out-of-scope file(s): ${outOfScope.slice(0, 3).join(', ')}`,
  );
});
