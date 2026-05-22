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

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scanRegex, scanText } from './check-spec-patterns.mjs';

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
