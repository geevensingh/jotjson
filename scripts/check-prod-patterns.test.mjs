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

import { matchesPragma, scanText } from './check-prod-patterns.mjs';

// --- matchesPragma --------------------------------------------------------

test('matchesPragma accepts a literal-string pragma via includes', () => {
  assert.equal(matchesPragma('// allow:foo', 'some code // allow:foo'), true);
  assert.equal(matchesPragma('// allow:foo', 'some code'), false);
});

test('matchesPragma accepts a RegExp pragma via test', () => {
  const pragma = /\/\/\s*allow:selected-path-set\s+(?:helper|system-clear)\b/;
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

test('selected-path-set: programmatic-immediate and -clear and retry-pending-apply pass', () => {
  for (const reason of ['programmatic-immediate', 'programmatic-clear', 'retry-pending-apply']) {
    const text = `this.selectedPath.set(x); // allow:selected-path-set ${reason}\n`;
    const violations = scanText(text, JSON_TREE_PATH).filter((v) =>
      v.snippet.includes('selectedPath'),
    );
    assert.equal(violations.length, 0, `reason '${reason}' should pass`);
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
  // Anti-regression: the v1 plan used `system-write`; the v2 plan
  // tightened the vocabulary to `system-clear`. A stale `system-write`
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
