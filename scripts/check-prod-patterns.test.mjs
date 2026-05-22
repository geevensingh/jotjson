// Unit tests for scripts/check-prod-patterns.mjs.
//
// Runs under Node's built-in test runner: `node --test`. No external
// dependencies. The test file imports the script as a module; the script
// guards `main()` behind an "invoked directly" check so importing it does
// not trigger CLI side effects (git ls-files, fs reads, process.exit).
//
// Coverage focuses on the issue #274 additions:
//  - `matchesPragma` accepts both string and RegExp pragmas
//  - `scanText` enforces the closed-enum reason vocabulary for the
//    selected-path-set rule
//  - The pragmaAllowedPaths gate still rejects a stray pragma in a
//    non-allow-listed file

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { matchesPragma, RULES, scanText, validateRules } from './check-prod-patterns.mjs';

// --- matchesPragma --------------------------------------------------------

test('matchesPragma accepts a literal-string pragma via includes', () => {
  assert.equal(matchesPragma('// allow:foo', 'some code // allow:foo'), true);
  assert.equal(matchesPragma('// allow:foo', 'some code'), false);
});

test('matchesPragma accepts a RegExp pragma via test', () => {
  const pragma = /\/\/\s*allow:selected-path-set\s+(?:helper|system-clear)(?![-\w])/;
  assert.equal(matchesPragma(pragma, 'code; // allow:selected-path-set helper'), true);
  assert.equal(matchesPragma(pragma, 'code; // allow:selected-path-set system-clear'), true);
  assert.equal(matchesPragma(pragma, 'code; // allow:selected-path-set yolo'), false);
  assert.equal(matchesPragma(pragma, 'code; // allow:selected-path-set TODO-figure-out'), false);
});

test('matchesPragma throws on non-string non-RegExp pragma', () => {
  assert.throws(() => matchesPragma(123, 'anything'), TypeError);
  assert.throws(() => matchesPragma({}, 'anything'), TypeError);
  assert.throws(() => matchesPragma(null, 'anything'), TypeError);
});

// --- scanText: selected-path-set rule -------------------------------------

const JSON_TREE_PATH = 'src/app/shared/components/json-tree/json-tree.component.ts';
const HOME_PATH = 'src/app/features/home/home.component.ts';
const COSMOS_PATH = 'api/src/shared/cosmos.ts';

test('selected-path-set: helper-pragma write in json-tree.component.ts passes', () => {
  const text = `class Foo {
  helper() {
    this.selectedPath.set(path); // allow:selected-path-set helper
  }
}
`;
  const violations = scanText(text, JSON_TREE_PATH).filter((v) =>
    v.snippet.includes('selectedPath'),
  );
  assert.equal(violations.length, 0);
});

test('selected-path-set: system-clear pragma in json-tree.component.ts passes', () => {
  const text = `if (!root) {
  this.selectedPath.set(null); // allow:selected-path-set system-clear
}
`;
  const violations = scanText(text, JSON_TREE_PATH).filter((v) =>
    v.snippet.includes('selectedPath'),
  );
  assert.equal(violations.length, 0);
});

test('selected-path-set: programmatic-immediate / -clear / retry-pending-apply NO LONGER pass', () => {
  // Anti-regression: the v1 vocabulary documented 5 reasons; PR #286
  // review feedback tightened to 2 (`helper`, `system-clear`) once
  // Resolution B routed the programmatic + retry-pending sites
  // through `setUserSelection` instead of carrying their own pragmas.
  // A stale `programmatic-immediate` / `programmatic-clear` /
  // `retry-pending-apply` comment must NOT pass.
  for (const reason of ['programmatic-immediate', 'programmatic-clear', 'retry-pending-apply']) {
    const text = `this.selectedPath.set(x); // allow:selected-path-set ${reason}\n`;
    const violations = scanText(text, JSON_TREE_PATH).filter((v) =>
      v.snippet.includes('selectedPath'),
    );
    assert.equal(violations.length, 1, `reason '${reason}' should now fail`);
  }
});

test('selected-path-set: word-char suffix on a valid reason fails (e.g. "helpers")', () => {
  // The `(?![-\w])` lookahead must reject a typo where the reason is
  // a longer word that happens to start with `helper` or `system-clear`.
  for (const bogus of ['helpers', 'helper-typo', 'system-clear-foo', 'system-clears']) {
    const text = `this.selectedPath.set(x); // allow:selected-path-set ${bogus}\n`;
    const violations = scanText(text, JSON_TREE_PATH).filter((v) =>
      v.snippet.includes('selectedPath'),
    );
    assert.equal(violations.length, 1, `reason '${bogus}' should fail`);
  }
});

test('selected-path-set: pragma followed by punctuation / whitespace / EOF passes', () => {
  // The `(?![-\w])` lookahead must allow the natural terminators
  // appearing in source: trailing whitespace before EOL, tab, CRLF,
  // EOF without a newline, or punctuation like `.` / `;`.
  const passes = [
    'this.selectedPath.set(x); // allow:selected-path-set helper\n',
    'this.selectedPath.set(x); // allow:selected-path-set helper\r\n',
    'this.selectedPath.set(x); // allow:selected-path-set helper\t\n',
    'this.selectedPath.set(x); // allow:selected-path-set helper ',
    'this.selectedPath.set(x); // allow:selected-path-set helper.',
    'this.selectedPath.set(x); // allow:selected-path-set helper',
    'this.selectedPath.set(x); // allow:selected-path-set system-clear\n',
  ];
  for (const text of passes) {
    const violations = scanText(text, JSON_TREE_PATH).filter((v) =>
      v.snippet.includes('selectedPath'),
    );
    assert.equal(
      violations.length,
      0,
      `text ${JSON.stringify(text)} should pass but had ${violations.length} violations`,
    );
  }
});

test('selected-path-set: unknown reason fails even in json-tree.component.ts', () => {
  const text = `this.selectedPath.set(x); // allow:selected-path-set yolo\n`;
  const violations = scanText(text, JSON_TREE_PATH).filter((v) =>
    v.snippet.includes('selectedPath'),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /closed-vocabulary pragma/);
});

test('selected-path-set: old generic "system-write" reason no longer passes', () => {
  // Anti-regression: an early plan used `system-write`; the final
  // vocabulary is `{helper, system-clear}`. A stale `system-write`
  // comment must NOT pass.
  const text = `this.selectedPath.set(null); // allow:selected-path-set system-write\n`;
  const violations = scanText(text, JSON_TREE_PATH).filter((v) =>
    v.snippet.includes('selectedPath'),
  );
  assert.equal(violations.length, 1);
});

test('selected-path-set: raw write with no pragma in json-tree.component.ts fails', () => {
  const text = `this.selectedPath.set(x);\n`;
  const violations = scanText(text, JSON_TREE_PATH).filter((v) =>
    v.snippet.includes('selectedPath'),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /setUserSelection\(\)/);
});

test('selected-path-set: pragma in a NON-allow-listed file is still a violation', () => {
  // The home component grabs `viewChild(JsonTreeComponent)`. A stray
  // `child.selectedPath.set(...)` here, even with the helper pragma,
  // must fail because the pragmaAllowedPaths filter scopes the
  // safe-harbor to json-tree.component.ts only.
  const text = `this.tree()?.selectedPath.set(null); // allow:selected-path-set helper\n`;
  const violations = scanText(text, HOME_PATH).filter((v) => v.snippet.includes('selectedPath'));
  assert.equal(violations.length, 1);
});

test('selected-path-set: raw write in any non-allow-listed file fails', () => {
  const text = `this.tree()?.selectedPath.set('x');\n`;
  const violations = scanText(text, HOME_PATH).filter((v) => v.snippet.includes('selectedPath'));
  assert.equal(violations.length, 1);
});

test('selected-path-set: `.update(...)` raw write in json-tree.component.ts fails', () => {
  // Issue #274 + PR #286 review: the rule must cover `.update` not
  // just `.set`. A signal computed-update like
  // `this.selectedPath.update((prev) => ...)` is functionally an
  // intentional write and must route through `setUserSelection`.
  const text = `this.selectedPath.update((p) => p);\n`;
  const violations = scanText(text, JSON_TREE_PATH).filter((v) =>
    v.snippet.includes('selectedPath'),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /setUserSelection\(\)/);
});

test('selected-path-set: `.update(...)` with helper pragma in json-tree.component.ts passes', () => {
  const text = `this.selectedPath.update((p) => p); // allow:selected-path-set helper\n`;
  const violations = scanText(text, JSON_TREE_PATH).filter((v) =>
    v.snippet.includes('selectedPath'),
  );
  assert.equal(violations.length, 0);
});

test('selected-path-set: `.update(...)` with pragma in NON-allow-listed file still fails', () => {
  // Symmetric with the `.set` cross-file test: pragma alone is not
  // enough; the file must also be on `pragmaAllowedPaths`.
  const text = `this.tree()?.selectedPath.update((p) => p); // allow:selected-path-set helper\n`;
  const violations = scanText(text, HOME_PATH).filter((v) => v.snippet.includes('selectedPath'));
  assert.equal(violations.length, 1);
});

test('selected-path-set: `.update(...)` raw write in any non-allow-listed file fails', () => {
  const text = `this.tree()?.selectedPath.update((p) => p);\n`;
  const violations = scanText(text, HOME_PATH).filter((v) => v.snippet.includes('selectedPath'));
  assert.equal(violations.length, 1);
});

test('selected-path-set: comment lines are not scanned for violations', () => {
  // Documentation referencing the banned pattern must be allowed so
  // the doc block at `selectedPath`'s declaration does not trip the
  // lint. The existing `^\s*(\*|//)` skip handles both `//`-prefixed
  // line comments and `*`-prefixed JSDoc continuation lines.
  const text =
    `// Reference: this.selectedPath.set(x) bypasses #266.
 * ` +
    `Also, this.selectedPath.set(x) is fine in JSDoc.
`;
  const violations = scanText(text, JSON_TREE_PATH).filter((v) =>
    v.snippet.includes('selectedPath'),
  );
  assert.equal(violations.length, 0);
});

// --- scanText: backwards-compat with rule #2 ('cosmos-replace') -----------

test('cosmos-replace: string pragma still works after the engine change', () => {
  const text = `await container.item('id', 'pk').replace<Doc>(updated); // allow:cosmos-replace internal-only\n`;
  const violations = scanText(text, COSMOS_PATH);
  assert.equal(violations.length, 0);
});

test('cosmos-replace: string pragma in non-allow-listed file is rejected', () => {
  const text = `await container.item('id', 'pk').replace<Doc>(updated); // allow:cosmos-replace internal-only\n`;
  const violations = scanText(text, 'api/src/blobs/index.ts');
  assert.equal(violations.length, 1);
});

// --- validateRules (rule-shape contract) ---------------------------------
// PR #370 panel: enforce at module load that each rule has a RegExp
// pattern and a non-empty message. The /g flag is NOT validated
// here -- V8's matchAll throws on non-global at engine call time
// with a better stack trace.

test('validateRules rejects a rule with non-RegExp pattern', () => {
  assert.throws(
    () => validateRules([{ pattern: 'foo', message: 'msg' }]),
    /pattern must be a RegExp/,
  );
});

test('validateRules rejects a rule with missing message', () => {
  assert.throws(() => validateRules([{ pattern: /foo/g }]), /missing or empty `message`/);
});

test('validateRules rejects a rule with empty message', () => {
  assert.throws(
    () => validateRules([{ pattern: /foo/g, message: '' }]),
    /missing or empty `message`/,
  );
});

// --- Engine termination (PR #370 bot finding regression test) ---------
// The previous `while ((m = rule.pattern.exec(text)) !== null)` engine
// would hang on the first match if a rule forgot `/g`. The matchAll
// engine throws a TypeError at call time instead. These tests are
// the actual canary for the bot's concern -- they prove the scan
// loop terminates on multi-match input AND that a non-global pattern
// fails loudly with a message that points at the fix.

test('scanText terminates on multiple matches (not just the first)', { timeout: 2000 }, () => {
  const text = `
const a = foo as TelemetryMessageId;
const b = bar as TelemetryMessageId;
const c = baz as TelemetryMessageId;
`;
  const violations = scanText(text, 'src/app/example.ts');
  assert.equal(violations.length, 3);
});

test('scanText throws actionable error if a rule pattern is non-global', () => {
  // Find the TelemetryMessageId rule (rule #1, no `paths` filter so
  // it fires on any src/ path).
  const telemetryRule = RULES.find((r) => /TelemetryMessageId/.test(r.pattern.source));
  assert.ok(telemetryRule, 'expected a TelemetryMessageId rule');
  const savedPattern = telemetryRule.pattern;
  // Mutate the existing rule in place to bypass validateRules.
  telemetryRule.pattern = /TelemetryMessageId/;
  try {
    assert.throws(
      () => scanText('const x = y as TelemetryMessageId;', 'src/app/example.ts'),
      (err) =>
        err instanceof TypeError &&
        /matchAll requires \/g/.test(err.message) &&
        /scripts\/check-prod-patterns\.mjs/.test(err.message),
    );
  } finally {
    telemetryRule.pattern = savedPattern;
  }
});
