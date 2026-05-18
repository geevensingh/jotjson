// Tests for scripts/check-tree-row-grid.mjs. Run via
// `node --test scripts/check-tree-row-grid.test.mjs` or
// `npm run test:scripts`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  countTreeRowAttributes,
  DIRECT_CHILD_ALLOWLIST,
  FLEX_SHRINK_GUARDS,
  lintCanonicalFiles,
  lintTemplate,
} from './check-tree-row-grid.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(scriptDir, 'check-tree-row-grid.fixtures');

function readFixture(name) {
  return readFileSync(resolve(fixtureDir, name), 'utf8');
}

function lintFixturePair(htmlName, scssName) {
  return lintTemplate({
    htmlSrc: readFixture(htmlName),
    scssSrc: readFixture(scssName),
    htmlPath: `fixtures/${htmlName}`,
    scssPath: `fixtures/${scssName}`,
  });
}

test('1. happy path: lint happy.html + happy.scss returns no violations', () => {
  const violations = lintFixturePair('happy.html', 'happy.scss');
  assert.deepEqual(violations, []);
});

test('2. invariant 1.1: direct child with no static class fires "fully-dynamic" violation', () => {
  const violations = lintFixturePair('violate-1.1.html', 'happy.scss');
  const matching = violations.filter((v) => v.message.includes('no static `class` attribute'));
  assert.equal(
    matching.length,
    1,
    `expected one 1.1 violation, got: ${JSON.stringify(violations, null, 2)}`,
  );
});

test('3. invariant 1.2: direct child with non-allowlisted class fires "not in DIRECT_CHILD_ALLOWLIST" violation', () => {
  const violations = lintFixturePair('violate-1.2.html', 'happy.scss');
  const matching = violations.filter((v) => v.message.includes('DIRECT_CHILD_ALLOWLIST'));
  assert.equal(
    matching.length,
    1,
    `expected one 1.2 violation, got: ${JSON.stringify(violations, null, 2)}`,
  );
  assert.match(matching[0].message, /tree-bogus/);
});

test('4. invariant 2: unknown grid-column track fires "track not declared" violation', () => {
  const violations = lintFixturePair('happy.html', 'violate-2.scss');
  const matching = violations.filter((v) => v.message.includes('not declared as'));
  assert.equal(
    matching.length,
    1,
    `expected one invariant-2 violation, got: ${JSON.stringify(violations, null, 2)}`,
  );
  assert.match(matching[0].message, /ghost/);
});

test('5. invariant 3: flex-shrink retainees missing shrink-of-zero fire violations', () => {
  const violations = lintFixturePair('happy.html', 'violate-3.scss');
  const matching = violations.filter((v) =>
    v.message.includes('missing a shrink-of-zero declaration'),
  );
  assert.equal(
    matching.length,
    3,
    `expected three flex-shrink violations (one per FLEX_SHRINK_GUARDS class), got: ${JSON.stringify(violations, null, 2)}`,
  );
  for (const className of FLEX_SHRINK_GUARDS) {
    const found = matching.some((v) => v.message.includes(`.${className}`));
    assert.ok(found, `expected violation for .${className}`);
  }
});

test('5b. invariant 3 accepts `flex: 1 0 auto` (loosened first-token check)', () => {
  const scssSrc = `
.tree-row {
  display: grid;
  grid-template-columns: [a] auto [b] 1fr;
  > .tree-row-leading { grid-column: a; }
  > .tree-row-value-cell { grid-column: b; }
}
.tree-twisty { flex: 1 0 auto; }
.tree-beacon-badge { flex-shrink: 0; }
.tree-rule-icon { flex: none; }
`;
  const htmlSrc = readFixture('happy.html');
  const violations = lintTemplate({
    htmlSrc,
    scssSrc,
    htmlPath: 'fixtures/happy.html',
    scssPath: 'inline.scss',
  });
  const shrinkViolations = violations.filter((v) => v.message.includes('shrink-of-zero'));
  assert.deepEqual(
    shrinkViolations,
    [],
    `expected no shrink violations, got: ${JSON.stringify(shrinkViolations, null, 2)}`,
  );
});

test('6. edge case: .tree-row.tree-row--close exempts its children from the allowlist', () => {
  const htmlSrc = `
<div class="tree-row tree-row--close">
  <span class="tree-comment-leading--close"></span>
  <span class="tree-value-brace"></span>
</div>
`;
  const scssSrc = readFixture('happy.scss');
  const violations = lintTemplate({
    htmlSrc,
    scssSrc,
    htmlPath: 'fixtures/inline.html',
    scssPath: 'fixtures/happy.scss',
  });
  const allowlistViolations = violations.filter((v) =>
    v.message.includes('DIRECT_CHILD_ALLOWLIST'),
  );
  assert.deepEqual(
    allowlistViolations,
    [],
    `expected close-row children to be exempt, got: ${JSON.stringify(allowlistViolations, null, 2)}`,
  );
});

test('7. multi-block guard, top-level: second non-exempt compound at file root fires', () => {
  const violations = lintFixturePair('happy.html', 'violate-multi-block-top-level.scss');
  const matching = violations.filter((v) => v.message.includes('multi-block guard'));
  assert.ok(
    matching.length >= 1,
    `expected at least one multi-block guard violation, got: ${JSON.stringify(violations, null, 2)}`,
  );
  assert.match(matching[0].message, /tree-row\.future-state/);
});

test('8. multi-block guard, @media-scoped: second canonical block inside @media fires', () => {
  const violations = lintFixturePair('happy.html', 'violate-multi-block-media.scss');
  const matching = violations.filter((v) => v.message.includes('multi-block guard'));
  assert.equal(
    matching.length,
    1,
    `expected one multi-block guard violation, got: ${JSON.stringify(violations, null, 2)}`,
  );
});

test('9. multi-block guard, false-positive guard: combinators + .tree-row-* prefix overlap do NOT fire', () => {
  const violations = lintFixturePair('happy.html', 'happy-with-combinators.scss');
  const matching = violations.filter((v) => v.message.includes('multi-block guard'));
  assert.deepEqual(
    matching,
    [],
    `expected no multi-block violations for selectors with combinators or .tree-row-* prefix overlap, got: ${JSON.stringify(matching, null, 2)}`,
  );
});

test('10. ng-template carrier: skipped from .tree-row enumeration, children walked', () => {
  const htmlSrc = readFixture('ng-template-class.html');
  const scssSrc = readFixture('happy.scss');
  const violations = lintTemplate({
    htmlSrc,
    scssSrc,
    htmlPath: 'fixtures/ng-template-class.html',
    scssPath: 'fixtures/happy.scss',
  });
  const allowlistViolations = violations.filter((v) =>
    v.message.includes('DIRECT_CHILD_ALLOWLIST'),
  );
  assert.deepEqual(
    allowlistViolations,
    [],
    `expected ng-template carrier to NOT be enumerated as a row, got: ${JSON.stringify(allowlistViolations, null, 2)}`,
  );
});

test('11. smoke test against real json-tree files: lintCanonicalFiles returns []', () => {
  const violations = lintCanonicalFiles();
  assert.deepEqual(
    violations,
    [],
    `expected real json-tree files to pass, got: ${JSON.stringify(violations, null, 2)}`,
  );
});

test('12. walker tripwire parity: walker count === boundary-aware regex count on real file', () => {
  const repoRoot = resolve(scriptDir, '..');
  const htmlPath = resolve(
    repoRoot,
    'src/app/shared/components/json-tree/json-tree.component.html',
  );
  const htmlSrc = readFileSync(htmlPath, 'utf8');
  const regexCount = countTreeRowAttributes(htmlSrc);
  assert.ok(regexCount >= 1, `expected at least 1 .tree-row in real file, got ${regexCount}`);
  const violations = lintCanonicalFiles();
  const tripwireDrift = violations.filter((v) => v.message.includes('walker tripwire'));
  assert.deepEqual(
    tripwireDrift,
    [],
    `expected walker and regex to agree on count, got: ${JSON.stringify(tripwireDrift, null, 2)}`,
  );
});

test('DIRECT_CHILD_ALLOWLIST + FLEX_SHRINK_GUARDS shapes are sane', () => {
  assert.ok(DIRECT_CHILD_ALLOWLIST.has('tree-row-leading'));
  assert.ok(DIRECT_CHILD_ALLOWLIST.has('tree-key'));
  assert.ok(DIRECT_CHILD_ALLOWLIST.has('sr-only'));
  assert.equal(FLEX_SHRINK_GUARDS.length, 3);
  assert.deepEqual([...FLEX_SHRINK_GUARDS].sort(), [
    'tree-beacon-badge',
    'tree-rule-icon',
    'tree-twisty',
  ]);
});

// PR #296 review-feedback regression tests (F1, F2, F4, F5, F6, Architect-A).
// Each cites the bot finding it guards against by short label.

test('F1: line-stability -- multi-line /* */ before violation does not drift line number', () => {
  // The lint reports the rule HEADER line (`> .tree-row-value-cell {`),
  // not the declaration line. In line-stability.scss, the rule header
  // is on line 43. A non-length-preserving stripper would delete
  // embedded newlines from the multi-line block comment, shifting all
  // subsequent offsets upward and reporting a smaller line number
  // (e.g. ~26 -- 17 newlines shifted out of the comment).
  const violations = lintFixturePair('happy.html', 'line-stability.scss');
  const ghost = violations.filter((v) => v.message.includes('"ghost"'));
  assert.equal(
    ghost.length,
    1,
    `expected one unknown-track violation, got: ${JSON.stringify(violations, null, 2)}`,
  );
  const fixture = readFixture('line-stability.scss');
  const lines = fixture.split('\n');
  const expectedLine = lines.findIndex((l) => l.includes('> .tree-row-value-cell {')) + 1;
  assert.ok(expectedLine > 0, 'fixture is missing the rule header line; update fixture');
  assert.equal(
    ghost[0].line,
    expectedLine,
    `expected line ${expectedLine}, got ${ghost[0].line} (drift suggests stripScssComments is not length-preserving)`,
  );
});

test('F2: class-boundary -- .tree-row5 and .tree-row_x do NOT trigger multi-block guard', () => {
  const violations = lintFixturePair('happy.html', 'happy-class-boundary.scss');
  const multiBlock = violations.filter((v) => v.message.includes('multi-block guard'));
  assert.deepEqual(
    multiBlock,
    [],
    `expected no multi-block guard fires for .tree-row5 / .tree-row_x, got: ${JSON.stringify(multiBlock, null, 2)}`,
  );
});

test('F4: unterminated /* ... */ throws a `check-tree-row-grid.mjs:`-prefixed Error', () => {
  // Constructed inline (not as a fixture file) because prettier
  // refuses to format a `.scss` file with an unterminated comment.
  const htmlSrc = readFixture('happy.html');
  const scssSrc = `
/* unterminated comment, on purpose

.tree-row {
  display: grid;
  grid-template-columns: [leading] auto;
  > .tree-row-leading { grid-column: leading; }
}
`;
  assert.throws(
    () =>
      lintTemplate({
        htmlSrc,
        scssSrc,
        htmlPath: 'fixtures/happy.html',
        scssPath: '<inline-unterminated>',
      }),
    (error) => {
      assert.ok(error instanceof Error, 'expected an Error');
      assert.match(
        error.message,
        /^check-tree-row-grid\.mjs: unterminated \/\* \.\.\. \*\/ block comment/u,
        `expected CLI-formatted error, got: ${error.message}`,
      );
      return true;
    },
  );
});

test('F5: countTreeRowAttributes is idempotent across repeated calls (no lastIndex hazard)', () => {
  const htmlSrc = `
    <div class="tree-row">a</div>
    <div class="tree-row foo">b</div>
    <div class="bar tree-row baz">c</div>
    <div class="tree-row-leading">should not match</div>
    <div class="tree-row-leading tree-row">d</div>
  `;
  const expected = 4;
  const c1 = countTreeRowAttributes(htmlSrc);
  const c2 = countTreeRowAttributes(htmlSrc);
  const c3 = countTreeRowAttributes(htmlSrc);
  assert.equal(c1, expected, `first call expected ${expected}, got ${c1}`);
  assert.equal(c2, expected, `second call expected ${expected}, got ${c2}`);
  assert.equal(c3, expected, `third call expected ${expected}, got ${c3}`);
});

test('F6: pathToFileURL produces the canonical 3-slash form for POSIX-style absolute paths', async () => {
  // Smoke test for the repo idiom used in isMain(). Catches the
  // bug class where `new URL('file:///' + posixPath)` would produce
  // `file:////absolute/path` (four slashes) on POSIX, breaking the
  // strict-equality check against `import.meta.url` (which always
  // uses the canonical 3-slash form).
  const { pathToFileURL } = await import('node:url');
  const href = pathToFileURL('/usr/local/bin/x.mjs').href;
  // Windows-only: pathToFileURL of a POSIX-style path produces a URL
  // relative to the current drive, e.g. `file:///C:/usr/local/...`,
  // so the assertion is platform-aware.
  if (process.platform === 'win32') {
    assert.match(
      href,
      /^file:\/\/\/[A-Za-z]:\/usr\/local\/bin\/x\.mjs$/u,
      `Windows: expected canonical drive-anchored form, got: ${href}`,
    );
  } else {
    assert.equal(href, 'file:///usr/local/bin/x.mjs');
  }
});

test('Architect-A: nested-only .tree-twisty (no top-level rule) fires "block not found"', () => {
  const violations = lintFixturePair('happy.html', 'violate-nested-flex-shrink.scss');
  const notFound = violations.filter((v) =>
    v.message.includes('flex-shrink retainee block not found'),
  );
  const twisty = notFound.filter((v) => v.message.includes('.tree-twisty { ... }'));
  assert.equal(
    twisty.length,
    1,
    `expected nested-only .tree-twisty to fire "block not found", got: ${JSON.stringify(violations, null, 2)}`,
  );
});
