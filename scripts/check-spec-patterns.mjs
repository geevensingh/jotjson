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
//   Not enforced: indirect calls through helper functions. A helper
//   that internally calls `__resetX` is opaque to the rule. Spec
//   authors who hide setup in helpers accept the blind spot.
//
// Adding new rules:
//   For regex rules: push a `{ pattern, message }` onto REGEX_RULES.
//   For AST-based rules: extend `scanAst` directly. The AST scanner
//   exposes the spec file's TypeScript AST so a new rule can walk it
//   with the full structural context that regex cannot see.
//
// Exports:
//   - `REGEX_RULES`, `scanRegex`, `scanAst`, `scan`, `listSpecFiles`,
//     `main` are exported so unit tests (`scripts/check-spec-patterns.test.mjs`)
//     can drive them against in-memory fixtures without touching the
//     filesystem.
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
 */
export function scanRegex(text, normalizedPath) {
  const violations = [];
  for (const rule of REGEX_RULES) {
    rule.pattern.lastIndex = 0;
    let m;
    while ((m = rule.pattern.exec(text)) !== null) {
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
          ts.forEachChild(callback.body, visit);
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
