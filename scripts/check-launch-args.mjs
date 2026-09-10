#!/usr/bin/env node
// Vitest Chromium launch-args composition lint (issue #533).
//
// Motivating incident: PR #418 tried to pass Chromium launch flags via
// `instances[].launch.args`. `@vitest/browser-playwright` silently ignores
// that field -- it reads launch options *only* from the
// `playwright({ launchOptions: { args: [...] } })` factory argument, which
// it spreads into the object handed to Playwright's `.launch()`. Nothing
// errored; the flags simply never reached Chromium.
//
// Why this needs a gate rather than a comment or a runtime test:
//
//   1. The flags are UNOBSERVABLE where we run. Every CI job is a bare
//      `runs-on: ubuntu-latest` VM with no `container:`, running as the
//      non-root `runner` user. There, `--no-sandbox` (needed for
//      root/containers), `--disable-dev-shm-usage` (needed for Docker's
//      64MB /dev/shm), and `--disable-gpu` (redundant under
//      `headless: true`) are all effectively inert. On Windows dev
//      machines they are inert too. So a silent args-drop produces no
//      failure anywhere -- until CI moves to a container or a root user,
//      at which point it surfaces as intermittent Chromium crashes.
//
//   2. A runtime assertion could only prove the CHANNEL, not the CONTENTS.
//      Observing one flag's side effect (e.g. `window.gc` from
//      `--js-flags=--expose-gc`) cannot distinguish
//      `args: [...COMMON_LAUNCH_ARGS, ...extraArgs]` from
//      `args: [...extraArgs]`. The head of the array is the
//      CI-stability-critical part and has no in-page observable.
//
//   3. A static check costs milliseconds and needs no Chromium boot, so it
//      can fail before the thing it checks has booted.
//
// WHY AN AST, NOT REGEXES. The first four revisions of this gate scanned
// source text by hand and produced a false result in every round: a
// `[\s\S]*?` that ran past the array's closing bracket; an opener matched
// inside a string literal; a quoted decoy that satisfied the provider
// check; a decoy declared inside the helper body; a decoy nested inside
// the returned object; and an element list that ignored spreads. Each fix
// added another lexer rule (comments, then strings, then regex literals)
// and exposed the next gap. That is the wrong shape of solution: a
// hand-rolled JavaScript lexer will keep losing to valid syntax it does
// not model.
//
// `typescript` is already a direct devDependency, so the compiler's own
// scanner and parser do the lexing exactly right -- comments, strings,
// template literals, and regex literals all cease to be special cases --
// and structural questions ("the TOP-LEVEL `provider` property of the
// object this function RETURNS") become precise instead of approximate.
// Cold import measured at ~236ms on Node 24, under the 500ms hysteresis
// threshold documented in `check-tree-row-grid.mjs`, so this stays in the
// `lint` chain. Re-measure with:
//   node -e "const s=Date.now();import('typescript').then(()=>console.log(Date.now()-s))"
//
// Three invariants:
//   1. `COMMON_LAUNCH_ARGS` is an array of exactly the expected string
//      literals, in order, with no spreads or computed elements.
//   2. The object returned by `makeBrowserConfig()` has a top-level
//      `provider` of `playwright({ launchOptions: { args: [
//      ...COMMON_LAUNCH_ARGS, ...extraArgs ] } })`, in that order.
//   3. No `instances: [...]` entry carries a `launch` property -- the
//      literal PR #418 regression.
//
// Runtime proof that args actually reach Chromium lives where it belongs:
// `ensureGc()` in `json-tree.component.perf.ts` throws if
// `--js-flags=--expose-gc` (passed via `extraArgs`) failed to arrive.

import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

/**
 * The flag set `COMMON_LAUNCH_ARGS` must declare, in order.
 *
 * Changing this list is a deliberate act: update both this array and
 * `vitest.shared.mts`, and say why in the commit message. The comparison
 * is order-sensitive because the array is concatenated into a flat argv,
 * and Chromium honors the LAST occurrence of a repeated switch -- so
 * ordering is semantically load-bearing, not cosmetic.
 */
export const EXPECTED_COMMON_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
];

const SHARED_CONFIG = 'vitest.shared.mts';
const ARGS_CONST = 'COMMON_LAUNCH_ARGS';
const HELPER = 'makeBrowserConfig';
const EXTRA_ARGS_PARAM = 'extraArgs';

/** Parses a `.mts` source into a TypeScript AST. */
function parse(source, fileName) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Name of a property-assignment key, or null for computed/spread keys. */
function propertyName(node) {
  if (!ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node)) return null;
  const name = node.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/** Finds a top-level property of an object literal by name. */
function findProperty(objectLiteral, name) {
  if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) return null;
  return objectLiteral.properties.find((prop) => propertyName(prop) === name) ?? null;
}

/** Depth-first walk over every node in a tree. */
function walk(node, visit) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/**
 * Top-level `const NAME = ...` declarations, module scope only.
 *
 * Scoping matters: a nested declaration with the expected shape must not
 * be able to satisfy a check about the value the module actually exports.
 */
function topLevelVariableDeclarations(sourceFile, name) {
  const found = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        found.push(declaration);
      }
    }
  }
  return found;
}

/** Top-level function declarations, or `const NAME = () => {}` forms. */
function topLevelFunctions(sourceFile, name) {
  const found = [];
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.name.text === name) {
      found.push(statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) ||
          ts.isFunctionExpression(declaration.initializer))
      ) {
        found.push(declaration.initializer);
      }
    }
  }
  return found;
}

/** Renders an array element for a diagnostic without leaking whole files. */
function describeElement(element) {
  if (ts.isStringLiteral(element)) return `'${element.text}'`;
  if (ts.isSpreadElement(element)) return `...${element.expression.getText()}`;
  return element.getText();
}

/**
 * Reads the `COMMON_LAUNCH_ARGS` declaration.
 *
 * Every element must be a direct string literal. A spread or call
 * expression would let the runtime array carry flags this gate never sees,
 * so those are rejected rather than skipped -- the previous revision
 * collected only quoted literals and silently ignored everything else.
 */
function checkCommonArgs(sourceFile, path, violations) {
  // Top-level statements only, and duplicates rejected. A whole-tree,
  // last-match walk let a nested declaration with the expected shape mask
  // a bad top-level one -- the gate passed while the runtime used the bad
  // value. Module scope is what the config actually exports.
  const declarations = topLevelVariableDeclarations(sourceFile, ARGS_CONST);
  if (declarations.length > 1) {
    violations.push(
      `${path}: found ${declarations.length} top-level \`${ARGS_CONST}\` declarations. ` +
        `Exactly one is required, or which value reaches Chromium is ambiguous.`,
    );
    return;
  }
  const declaration = declarations[0] ?? null;
  if (!declaration || !declaration.initializer) {
    violations.push(
      `${path}: could not find a \`${ARGS_CONST}\` declaration with an initializer. ` +
        `The launch-args funnel is the PR #418 regression guard; do not remove or rename it.`,
    );
    return;
  }
  if (!ts.isArrayLiteralExpression(declaration.initializer)) {
    violations.push(`${path}: \`${ARGS_CONST}\` must be an array literal.`);
    return;
  }

  const elements = declaration.initializer.elements;
  const nonLiteral = elements.filter((element) => !ts.isStringLiteral(element));
  if (nonLiteral.length > 0) {
    violations.push(
      `${path}: \`${ARGS_CONST}\` must contain only direct string literals, but found ` +
        `${nonLiteral.map(describeElement).join(', ')}. A spread or expression can add ` +
        `flags at runtime that this gate cannot see.`,
    );
    return;
  }

  const declared = elements.map((element) => element.text);
  const expected = EXPECTED_COMMON_LAUNCH_ARGS;
  if (declared.length !== expected.length || declared.some((flag, i) => flag !== expected[i])) {
    violations.push(
      `${path}: ${ARGS_CONST} is [${declared.join(', ')}] but expected [${expected.join(', ')}]. ` +
        `If this change is deliberate, update EXPECTED_COMMON_LAUNCH_ARGS in ` +
        `scripts/check-launch-args.mjs in the same commit and explain why in the commit message.`,
    );
  }
}

/**
 * Collects EVERY return statement in a function, skipping nested
 * functions (whose returns belong to them, not to this one).
 *
 * Iterating only the block's own statements missed a return nested in an
 * `if`, and keeping the last match let an early conditional return with a
 * bad provider pass. Every reachable return has to be validated, because
 * any one of them can be the object Vitest receives.
 */
function collectReturns(fn) {
  const returns = [];
  const visit = (node) => {
    if (
      node !== fn &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node))
    ) {
      return; // a nested function's returns are its own
    }
    if (ts.isReturnStatement(node)) returns.push(node);
    node.forEachChild(visit);
  };
  visit(fn);
  return returns;
}

/** Unwraps a parenthesized expression. */
function unwrap(expression) {
  return expression && ts.isParenthesizedExpression(expression)
    ? expression.expression
    : expression;
}

/**
 * Locates every object literal `makeBrowserConfig` can return.
 *
 * @returns `{ helper, returned: Node[], duplicates? }` where `returned`
 *   holds one entry per return path; a non-object-literal path is `null`.
 */
function findReturnedObjects(sourceFile) {
  // Top-level only, and duplicates rejected -- same shadowing hazard as
  // COMMON_LAUNCH_ARGS: a nested `makeBrowserConfig` with the right shape
  // must not mask a bad exported one.
  const helpers = topLevelFunctions(sourceFile, HELPER);
  if (helpers.length > 1) return { helper: null, returned: [], duplicates: helpers.length };
  const helper = helpers[0] ?? null;
  if (!helper) return { helper: null, returned: [] };

  // Arrow shorthand: `(args) => ({ ... })`
  if (ts.isArrowFunction(helper) && helper.body && !ts.isBlock(helper.body)) {
    const body = unwrap(helper.body);
    return { helper, returned: [ts.isObjectLiteralExpression(body) ? body : null] };
  }

  const returned = collectReturns(helper).map((statement) => {
    const expression = unwrap(statement.expression);
    return expression && ts.isObjectLiteralExpression(expression) ? expression : null;
  });
  return { helper, returned };
}

/**
 * Checks the provider on the object `makeBrowserConfig` returns.
 *
 * Anchored to the TOP-LEVEL `provider` property of the RETURNED object.
 * Earlier revisions matched file-wide, then function-body-wide, then
 * returned-object-wide; each accepted a decoy that satisfied the pattern
 * somewhere other than the property Vitest actually consumes.
 */
function checkProvider(sourceFile, path, violations) {
  const { helper, returned, duplicates } = findReturnedObjects(sourceFile);
  if (duplicates) {
    violations.push(
      `${path}: found ${duplicates} top-level \`${HELPER}(...)\` declarations. ` +
        `Exactly one is required, or which provider reaches Vitest is ambiguous.`,
    );
    return;
  }
  if (!helper) {
    violations.push(
      `${path}: could not find a \`${HELPER}(...)\` function to inspect. ` +
        `All provider creation must funnel through it (PR #418).`,
    );
    return;
  }
  if (returned.length === 0) {
    violations.push(
      `${path}: \`${HELPER}(...)\` has no return statement, so the provider it hands to ` +
        `Vitest cannot be verified.`,
    );
    return;
  }

  // EVERY return path is checked. Any one of them can be the object Vitest
  // receives, so validating only the last let an early conditional return
  // ship a provider that drops the launch args.
  const many = returned.length > 1;
  returned.forEach((object, index) => {
    const where = many ? ` (return path ${index + 1} of ${returned.length})` : '';
    checkReturnedObject(object, path, where, violations);
  });
}

/** Validates one returned object literal's `provider` property. */
function checkReturnedObject(returned, path, where, violations) {
  if (!returned) {
    violations.push(
      `${path}: \`${HELPER}(...)\` does not return an object literal${where}, so the provider ` +
        `it hands to Vitest cannot be verified.`,
    );
    return;
  }

  const providerProp = findProperty(returned, 'provider');
  if (!providerProp || !ts.isPropertyAssignment(providerProp)) {
    violations.push(
      `${path}: the object returned by \`${HELPER}(...)\` has no top-level \`provider\` property${where}.`,
    );
    return;
  }

  const call = providerProp.initializer;
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== 'playwright'
  ) {
    violations.push(
      `${path}: the returned \`provider\`${where} must be a \`playwright({ ... })\` call, but is ` +
        `\`${call.getText().split('\n')[0]}\`. @vitest/browser-playwright reads launch options ` +
        `ONLY from that factory argument (re-verified against 4.1.11).`,
    );
    return;
  }

  const launchOptions = findProperty(call.arguments[0], 'launchOptions');
  const argsProp =
    launchOptions && ts.isPropertyAssignment(launchOptions)
      ? findProperty(launchOptions.initializer, 'args')
      : null;
  if (!argsProp || !ts.isPropertyAssignment(argsProp)) {
    violations.push(
      `${path}: the returned \`provider: playwright(...)\` call${where} has no ` +
        `\`launchOptions.args\`, so no launch flags reach Chromium.`,
    );
    return;
  }
  if (!ts.isArrayLiteralExpression(argsProp.initializer)) {
    violations.push(`${path}: \`launchOptions.args\`${where} must be an array literal.`);
    return;
  }

  const elements = argsProp.initializer.elements;
  const isSpreadOf = (element, name) =>
    ts.isSpreadElement(element) &&
    ts.isIdentifier(element.expression) &&
    element.expression.text === name;
  const correct =
    elements.length === 2 &&
    isSpreadOf(elements[0], ARGS_CONST) &&
    isSpreadOf(elements[1], EXTRA_ARGS_PARAM);

  if (!correct) {
    const found = elements.map(describeElement).join(', ');
    const hasCommon = elements.some((element) => isSpreadOf(element, ARGS_CONST));
    const hasExtra = elements.some((element) => isSpreadOf(element, EXTRA_ARGS_PARAM));
    let why;
    if (!hasCommon && !hasExtra) {
      why =
        `it spreads neither ${ARGS_CONST} nor ${EXTRA_ARGS_PARAM}. Dropping the baseline ` +
        `silently strips --no-sandbox / --disable-gpu / --disable-dev-shm-usage from every ` +
        `browser run, with no test failure on GitHub-hosted VM runners.`;
    } else if (!hasCommon) {
      why =
        `it does not spread ${ARGS_CONST}. That silently strips --no-sandbox / ` +
        `--disable-gpu / --disable-dev-shm-usage from every browser run, with no test ` +
        `failure on GitHub-hosted VM runners.`;
    } else if (!hasExtra) {
      why =
        `it does not spread ${EXTRA_ARGS_PARAM}. The L2 perf bench passes ` +
        `--js-flags=--expose-gc through that parameter; dropping it breaks ensureGc().`;
    } else {
      why =
        `the spreads are out of order or carry extra entries. \`args\` is a flat argv and ` +
        `Chromium honors the LAST occurrence of a repeated switch, so ${ARGS_CONST} must come ` +
        `first and ${EXTRA_ARGS_PARAM} second -- otherwise a harness cannot override a baseline flag.`;
    }
    violations.push(
      `${path}: the returned provider's \`launchOptions.args\`${where} must be exactly ` +
        `\`[...${ARGS_CONST}, ...${EXTRA_ARGS_PARAM}]\`, but ${why} Found \`[${found}]\`.`,
    );
  }
}

/** Lints the shared-config source text. */
export function lintSharedConfig(source, path = SHARED_CONFIG) {
  const violations = [];
  const sourceFile = parse(source, path);
  checkCommonArgs(sourceFile, path, violations);
  checkProvider(sourceFile, path, violations);
  return violations;
}

/**
 * Lints one config file for the `instances[].launch` regression shape.
 *
 * Deliberately conservative: a `launch` key anywhere inside an `instances`
 * array entry is a violation, not just at the entry's top level. The field
 * is silently ignored wherever it appears, so flagging the whole subtree is
 * the tripwire PR #418 warranted.
 */
export function lintInstancesLaunch(source, path) {
  const sourceFile = parse(source, path);
  let found = false;

  walk(sourceFile, (node) => {
    if (found) return;
    if (!ts.isPropertyAssignment(node) || propertyName(node) !== 'instances') return;
    if (!ts.isArrayLiteralExpression(node.initializer)) return;
    for (const entry of node.initializer.elements) {
      walk(entry, (inner) => {
        if (propertyName(inner) === 'launch') found = true;
      });
    }
  });

  if (!found) return [];
  return [
    `${path}: found a \`launch\` field inside an \`instances: [...]\` entry. ` +
      `@vitest/browser-playwright silently ignores it (PR #418). Pass launch flags through ` +
      `${HELPER}()'s ${EXTRA_ARGS_PARAM} parameter instead, which funnels them into the ` +
      `playwright({ launchOptions: { args } }) factory.`,
  ];
}

/** Returns the repo-root `vitest*.mts` config filenames, sorted. */
export function listVitestConfigs(root = repoRoot) {
  return readdirSync(root)
    .filter((name) => name.startsWith('vitest') && name.endsWith('.mts'))
    .sort();
}

/** Runs every invariant against the real repo files. */
export function lintRepo(root = repoRoot) {
  const violations = [];
  const configs = listVitestConfigs(root);

  if (!configs.includes(SHARED_CONFIG)) {
    violations.push(
      `${SHARED_CONFIG}: not found at the repo root. This gate hard-requires it; ` +
        `if the shared substrate moved, update scripts/check-launch-args.mjs.`,
    );
    return { violations, scanned: configs.length };
  }

  violations.push(
    ...lintSharedConfig(readFileSync(resolve(root, SHARED_CONFIG), 'utf8'), SHARED_CONFIG),
  );
  for (const name of configs) {
    violations.push(...lintInstancesLaunch(readFileSync(resolve(root, name), 'utf8'), name));
  }
  return { violations, scanned: configs.length };
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMain()) {
  const { violations, scanned } = lintRepo();
  if (violations.length === 0) {
    console.log(`check-launch-args: OK (${scanned} vitest config(s) scanned, 0 violations)`);
    process.exit(0);
  }
  console.error('check-launch-args: violations found:');
  for (const violation of violations) {
    console.error(`  - ${violation}`);
    if (process.env.GITHUB_ACTIONS === 'true') {
      const safe = violation.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
      console.log(`::error::${safe}`);
    }
  }
  console.error(`\n${violations.length} violation(s).`);
  process.exit(1);
}
