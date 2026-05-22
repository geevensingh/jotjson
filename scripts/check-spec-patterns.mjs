#!/usr/bin/env node
// Spec-pattern lint: rejects known-fragile testing patterns in *.spec.ts.
//
// Why this exists:
//
//  Rule #1 - `spyOnProperty(navigator, 'clipboard', 'get')`:
//   Requires `navigator.clipboard` to already exist as an accessor
//   property. Linux headless Chrome (the CI runner) exposes it as a
//   data property (or omits it entirely outside a secure context), so
//   the spy throws "Property clipboard does not have access type get"
//   and crashes the test. Windows headless Chrome happens to expose a
//   getter, so locally green and CI red. We have already paid for this
//   once (see the M4b clipboard fix that introduced this script). The
//   rest of the codebase uses
//   `Object.defineProperty(navigator, 'clipboard', { configurable: true,
//   get: () => ... })` in beforeEach + restore in afterEach, which
//   works on every platform.
//
//  Rule #2 - `__reset*ForTesting()` symmetry (issue #350):
//   Module-scoped state inside ES modules is a singleton that external
//   code cannot reset. The `__resetXForTesting()` convention exists so
//   specs can reset that state at known points. A spec that calls
//   `__resetX()` in `beforeEach` but NOT in `afterEach` leaks state to
//   the *next* spec across the entire suite. Under Jasmine `random:
//   true` this surfaces as an intermittent CI flake (see PR #351). The
//   rule enforces that every `__reset*ForTesting` call inside a
//   `beforeEach` has a matching `__reset*ForTesting` call (same
//   identifier) inside an `afterEach` in the same `describe` block (or
//   file scope).
//
//   The rule is deliberately one-way: only `beforeEach`-only resets
//   are flagged. An `afterEach`-only reset is the canonical set/reset
//   pair pattern (a `__setX...ForTesting` in `beforeEach` paired with
//   `__resetX...ForTesting` in `afterEach`) and is legitimate
//   cleanup-of-self -- the cross-test leak risk does not apply.
//
//   Not enforced: `__set*` / `__attach*` / `__load*` / `__flush*`
//   helpers (the `ForTesting` suffix alone is not enough -- e.g.,
//   `LoggerService.__attachPerfHarnessForTesting` is called in
//   production at `main.ts`). Set/reset *pairs* with different
//   identifiers (e.g., `__setInitWebVitalsImplForTesting` paired with
//   `__resetInitWebVitalsImplForTesting`) are intentionally not
//   constrained on the `__set*` side -- the rule lints `__reset*`
//   placement only.
//
//   Helper-call semantics (deliberate calibration -- see PR #370
//   panel discussion):
//
//   * Helpers *defined outside* the hook body (e.g., a top-level
//     `function setup() { __resetX(); }` called from `beforeEach`)
//     are opaque to the rule. Spec authors who hide setup in
//     external helpers accept the blind spot.
//   * Helpers *defined inline inside* the hook body have their
//     bodies walked: any `__reset*` call inside an inline helper IS
//     recorded against the enclosing hook, even if the helper is
//     never invoked. This is an accepted false-positive in exchange
//     for catching the common DRY pattern of extracting setup into a
//     helper defined and called from the same `beforeEach`. A
//     static linter cannot distinguish "helper defined" from
//     "helper defined and called" without dataflow analysis;
//     calibrating toward false-positives is consistent with the
//     one-way bias above (loud false-positive in a single spec is
//     cheap; silent false-negative leaks across the suite).
//
//   See also: `src/testing/global-hooks.spec.ts` is the runtime
//   counterpart -- it catches storage/`Storage.prototype` leaks
//   that the lint rule cannot see (since they have no
//   `__reset*ForTesting` name). The two mechanisms cover disjoint
//   bug classes; neither is a superset of the other.
//
// Adding new rules:
//   For regex rules: push a `{ id, pattern, message }` onto
//   REGEX_RULES. `validateRules(REGEX_RULES)` runs at module load and
//   throws a loud TypeError if any rule is missing `id` / `message`
//   or has a non-RegExp `pattern`, or if two rules share the same
//   `id`. The `/g` flag itself is enforced by `scanRegex`'s use of
//   `String.prototype.matchAll`, which V8 rejects with a TypeError
//   when given a non-global RegExp -- so rule authors who forget
//   `/g` get a loud failure on the first scan instead of a silent
//   `while (exec(...))` infinite-loop hang. See PR #370 panel
//   discussion for why engine-enforcement was preferred over a
//   handwritten `validateRegexRules({ global })` check.
//   For AST-based rules: extend `scanAst` directly. The AST scanner
//   exposes the spec file's TypeScript AST so a new rule can walk it
//   with the full structural context that regex cannot see.
//
// Exports:
//   - `REGEX_RULES`, `validateRules`, `scanRegex`, `scanAst`, `scan`,
//     `listSpecFiles`, `main` are exported so unit tests
//     (`scripts/check-spec-patterns.test.mjs`) can drive them against
//     in-memory fixtures without touching the filesystem.
//
// Runs on Node 24+. The AST rule requires `typescript` (already a
// transitive dev dep via `@angular-devkit/build-angular`). Invoke
// directly or via `npm run lint:spec-patterns`.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

export const REGEX_RULES = [
  {
    id: 'spy-on-navigator-clipboard',
    pattern: /\bspyOnProperty\s*\(\s*navigator\s*,\s*['"]clipboard['"]/g,
    message:
      "Use Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => ... })" +
      ' with a beforeEach/afterEach pair that captures and restores the' +
      ' original descriptor. spyOnProperty requires an accessor property,' +
      ' which Linux headless Chrome does not expose for navigator.clipboard.',
  },
];

/**
 * Asserts that each rule has the shape `{ id: string, pattern: RegExp,
 * message: string }` with non-empty id/message, and that no two rules
 * share an id. Throws a loud TypeError at module load if any rule
 * fails -- matches the file's "loud false-positive over silent
 * false-negative" calibration (see docstring). Pure: no I/O.
 *
 * The `/g` flag on `pattern` is intentionally NOT checked here. V8's
 * `String.prototype.matchAll` throws a TypeError on a non-global
 * RegExp on the first scan, which gives a better stack trace
 * pointing at the actual call site (scanRegex). See PR #370 panel
 * discussion. Exported for unit-test use.
 */
export function validateRules(rules) {
  const seenIds = new Set();
  for (const rule of rules) {
    if (typeof rule.id !== 'string' || rule.id.length === 0) {
      throw new TypeError(
        `check-spec-patterns: REGEX_RULES entry is missing a non-empty \`id\`` +
          ` (required for violation reporting and test filtering). See` +
          ` "Adding new rules" in scripts/check-spec-patterns.mjs.`,
      );
    }
    if (seenIds.has(rule.id)) {
      throw new TypeError(
        `check-spec-patterns: REGEX_RULES has two rules with id "${rule.id}".` +
          ` Each rule id must be unique. See scripts/check-spec-patterns.mjs.`,
      );
    }
    seenIds.add(rule.id);
    if (!(rule.pattern instanceof RegExp)) {
      throw new TypeError(
        `check-spec-patterns: rule "${rule.id}" pattern must be a RegExp,` +
          ` got ${typeof rule.pattern}. See scripts/check-spec-patterns.mjs.`,
      );
    }
    if (typeof rule.message !== 'string' || rule.message.length === 0) {
      throw new TypeError(
        `check-spec-patterns: rule "${rule.id}" message must be a non-empty` +
          ` string. See scripts/check-spec-patterns.mjs.`,
      );
    }
  }
}

// Validate at module load: throws loudly if any rule shape is broken.
// Pure check (no I/O), so this does not violate the "no CLI side
// effects on import" invariant called out in the file-top docstring.
validateRules(REGEX_RULES);

// Only `__reset*ForTesting` callees are subject to the symmetry rule.
// Narrowed from `__\w+ForTesting` so `__set*`, `__attach*`, `__load*`,
// `__flush*` etc. (not reset helpers) are excluded.
const RESET_HELPER_REGEX = /^__reset\w+ForTesting$/;

const RESET_ASYMMETRY_MESSAGE =
  'Asymmetric `__reset*ForTesting` placement (issue #350). A reset call' +
  ' in a `beforeEach` must have a matching reset call (same identifier)' +
  ' in an `afterEach` in the same `describe` block. A `beforeEach`-only' +
  ' reset means "I clean up at the start of MY test" -- but cross-test' +
  ' leakage already happened by then. The cleanup belongs in `afterEach`' +
  ' too, so the next spec inherits clean state under `random: true`.' +
  ' Note: an `afterEach`-only reset is the canonical "set/reset pair"' +
  ' pattern (`__setX...ForTesting` in `beforeEach`, `__resetX...ForTesting`' +
  ' in `afterEach`) and is NOT flagged by this rule.';

export function listSpecFiles() {
  // Match check-ascii.mjs: include both tracked and untracked-but-not-ignored
  // files so a fresh local file is scanned BEFORE it is staged.
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'buffer' },
  );
  return out
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((p) => p.endsWith('.spec.ts'));
}

/**
 * Run the regex-based rules on the file's text. Pure function: takes
 * the text and the normalized path, returns violations. Exported for
 * unit-test use.
 *
 * Engine choice: `String.prototype.matchAll` over `while (exec(...))`.
 * matchAll throws `TypeError: String.prototype.matchAll called with
 * a non-global RegExp argument` if a rule forgets `/g`. The legacy
 * `while ((m = rule.pattern.exec(text)) !== null)` form would
 * instead hang forever on the first match (exec restarts at
 * lastIndex=0 for non-global regex), turning a rule-authoring typo
 * into a silent CI infinite-loop. See PR #370 panel discussion.
 */
export function scanRegex(text, normalizedPath) {
  const violations = [];
  for (const rule of REGEX_RULES) {
    let matches;
    try {
      matches = text.matchAll(rule.pattern);
    } catch (cause) {
      throw new TypeError(
        `check-spec-patterns: rule "${rule.id}" pattern is not a global RegExp` +
          ` (matchAll requires /g). Add the /g flag to ${rule.pattern} in` +
          ` scripts/check-spec-patterns.mjs and re-run \`npm run test:scripts\`.`,
        { cause },
      );
    }
    for (const m of matches) {
      const upToMatch = text.slice(0, m.index);
      const line = upToMatch.split('\n').length;
      const lastNl = upToMatch.lastIndexOf('\n');
      const col = m.index - (lastNl + 1) + 1;
      violations.push({
        path: normalizedPath,
        line,
        col,
        message: rule.message,
        snippet: m[0],
        ruleId: rule.id,
      });
    }
  }
  return violations;
}

/**
 * Walks the spec's TypeScript AST and reports `__reset*ForTesting`
 * asymmetry violations. The walker tracks each enclosing `describe`
 * scope (a stack of node ids) and, within each scope, the set of
 * reset-helper identifiers called in `beforeEach` bodies and the set
 * called in `afterEach` bodies. After the walk, any identifier in the
 * `beforeEach` set without a matching entry in the `afterEach` set
 * becomes a violation. The reverse direction (`afterEach`-only) is
 * deliberately allowed -- it is the canonical set/reset pair cleanup
 * pattern. See file-top docstring (Rule #2) for the rationale.
 *
 * `describe.skip`, `xdescribe`, `fdescribe` are all treated as
 * describes. `it`, `xit`, `fit`, `it.skip`, async arrow bodies, and
 * function-expression bodies are all transparent to the walker --
 * resets called inside an `it` body do not feed the symmetry set
 * (they are not `beforeEach`/`afterEach`).
 *
 * Pure function: takes a TypeScript SourceFile and the normalized
 * path, returns violations. Exported for unit-test use.
 */
export function scanAst(sourceFile, normalizedPath) {
  const violations = [];

  // Stack of scopes. Each scope is { node, before: Map<id, Node>,
  // after: Map<id, Node> }. The file itself is the outermost scope.
  // Maps store the *first* AST node where the identifier appeared so
  // the violation can point at a real location.
  const scopes = [{ node: sourceFile, before: new Map(), after: new Map() }];

  function currentScope() {
    return scopes[scopes.length - 1];
  }

  function isCalleeName(expr, names) {
    // Matches `name(...)`, `name.skip(...)`, `name.only(...)` styles.
    if (ts.isIdentifier(expr)) {
      return names.includes(expr.text);
    }
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
      return names.includes(expr.expression.text);
    }
    return false;
  }

  function findResetCallsIn(node, sink) {
    // Deliberate over-inclusion: this walker recurses through ALL
    // descendants, including bodies of functions declared inline
    // inside the hook callback. A static linter cannot tell a
    // helper that is defined-and-called from one that is
    // defined-and-never-called; we accept the false-positive on the
    // dead-helper case in exchange for catching the common DRY
    // pattern where setup is extracted into a helper defined and
    // called from the same hook. See the file-top docstring
    // "Helper-call semantics" section for full rationale (PR #370
    // panel discussion). Do NOT add `ts.isFunctionDeclaration`
    // skip-recursion without revisiting that trade-off.
    function walk(n) {
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        let calleeName = null;
        if (ts.isIdentifier(callee)) {
          calleeName = callee.text;
        }
        if (calleeName && RESET_HELPER_REGEX.test(calleeName)) {
          if (!sink.has(calleeName)) {
            sink.set(calleeName, n);
          }
        }
      }
      ts.forEachChild(n, walk);
    }
    walk(node);
  }

  function recordHookCalls(callNode, hookKind) {
    // Hook callbacks: `beforeEach(() => { ... })` or
    // `beforeEach(function() { ... })`. Async arrows / function
    // expressions are also valid. Walk the callback body.
    const arg = callNode.arguments[0];
    if (!arg) return;
    let body = null;
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
      body = arg.body;
    }
    if (!body) return;
    const sink = hookKind === 'beforeEach' ? currentScope().before : currentScope().after;
    findResetCallsIn(body, sink);
  }

  function emitScopeViolations(scope) {
    // Only flag beforeEach-only resets. afterEach-only is the canonical
    // set/reset pair pattern (`__setX...ForTesting` in beforeEach paired
    // with `__resetX...ForTesting` in afterEach) and is legitimate.
    const beforeIds = new Set(scope.before.keys());
    const afterIds = new Set(scope.after.keys());
    for (const id of beforeIds) {
      if (afterIds.has(id)) continue;
      const offendingNode = scope.before.get(id);
      const start = offendingNode.getStart(sourceFile);
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
      violations.push({
        path: normalizedPath,
        line: line + 1,
        col: character + 1,
        message: `${RESET_ASYMMETRY_MESSAGE} (${id}() is in beforeEach only)`,
        snippet: `${id}()`,
        ruleId: 'reset-helper-symmetry',
      });
    }
  }

  function visit(node) {
    if (ts.isCallExpression(node)) {
      // Detect describe / xdescribe / fdescribe / describe.skip /
      // describe.only -- all open a new scope.
      if (isCalleeName(node.expression, ['describe', 'xdescribe', 'fdescribe'])) {
        const callback = node.arguments[1];
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
          scopes.push({ node, before: new Map(), after: new Map() });
          // visit(callback.body), not ts.forEachChild(callback.body, visit):
          // for a concise-arrow describe (`describe('x', () => beforeEach(...))`)
          // the body is itself a CallExpression. forEachChild would walk its
          // arguments and miss the top-level call. visit() falls through to
          // ts.forEachChild for Block bodies (no behavior change there) and
          // correctly dispatches on CallExpression bodies.
          visit(callback.body);
          const popped = scopes.pop();
          emitScopeViolations(popped);
          return;
        }
      }
      // `beforeEach(...)` / `afterEach(...)` -- record reset calls
      // into the current scope's symmetry sets.
      if (
        ts.isIdentifier(node.expression) &&
        (node.expression.text === 'beforeEach' || node.expression.text === 'afterEach')
      ) {
        recordHookCalls(node, node.expression.text);
        // Don't visit children -- the reset calls are already
        // captured. (Visiting would not double-count but is wasted
        // work.)
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  emitScopeViolations(scopes[0]);

  return violations;
}

/**
 * Convenience: returns combined regex + AST violations for `text` at
 * `normalizedPath`. Exported for unit tests.
 */
export function scanText(text, normalizedPath) {
  const sourceFile = ts.createSourceFile(
    normalizedPath,
    text,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
  return [...scanRegex(text, normalizedPath), ...scanAst(sourceFile, normalizedPath)];
}

export function scan(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const normalizedPath = path.replace(/\\/g, '/');
  return scanText(text, normalizedPath);
}

export function main() {
  const files = listSpecFiles();
  const allViolations = files.flatMap(scan);

  if (allViolations.length === 0) {
    console.log(`check-spec-patterns: OK (${files.length} spec files scanned, 0 violations)`);
    return 0;
  }

  console.error('check-spec-patterns: violations found:');
  for (const v of allViolations) {
    console.error(`  ${v.path}:${v.line}:${v.col}  ${v.snippet}`);
    console.error(`    -> ${v.message}`);
  }
  console.error(`\n${allViolations.length} violation(s) in ${files.length} spec files.`);

  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const v of allViolations) {
      const file = v.path.replace(/%/g, '%25');
      const msg = String(`${v.snippet} - ${v.message}`)
        .replace(/%/g, '%25')
        .replace(/\r/g, '%0D')
        .replace(/\n/g, '%0A');
      console.log(`::error file=${file},line=${v.line},col=${v.col}::${msg}`);
    }
  }

  return 1;
}

// Only invoke main() when this file is executed directly. Importers
// (the test file at scripts/check-spec-patterns.test.mjs) load the
// module solely for its exports; they must not trigger the CLI side
// effects (git ls-files, fs reads, process.exit).
const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exit(main());
}
