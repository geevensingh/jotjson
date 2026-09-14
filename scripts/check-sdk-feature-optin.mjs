#!/usr/bin/env node
// Application Insights SDK feature-flag gate.
//
// Motivating incident: PR #566. Bumping `@microsoft/applicationinsights-web`
// 3.4.1 -> 3.4.4 crossed 3.4.3, which added a `SdkStats` feature to the SDK's
// default `featureOptIn` map with mode `enable`. Left alone it registers a
// notification listener that reports Item_Success/Dropped/Retry_Count as
// MetricData through `core.track()` -- i.e. onto our own connection string,
// into `customMetrics`, a table our telemetry inventory does not document and
// our frozen messageId catalog does not cover.
//
// Nothing in the repo noticed. The manifest diff was two lines; the behavior
// change was in the dependency's defaults. `app-insights-config.ts` now opts
// out explicitly, and `app-insights-config.test.ts` asserts that by value. But
// that test compares our literal against our literal: it cannot fail when a
// FUTURE SDK release adds the next opt-out-by-default feature, or flips an
// existing default from off to on. The detection surface would be "a human
// reads a changelog", which is exactly what failed here.
//
// AGENTS.md Section 6 states the doctrine for this repo's supply-chain rules:
// prevention and detection ship as a pair ("the group is prevention ...; the
// check-lockfile.mjs assertion is detection"). This gate is the detection half.
//
// WHAT IT CHECKS. It reads the SDK's OWN default map out of the installed
// `dist-es5/AISku.js` -- the same "read the vendor artifact, because the
// dependency graph cannot see this" idiom `check-dependency-overrides.mjs`
// uses against Monaco's prebuilt bundle -- and requires that every feature key
// the SDK defaults has an explicit, justified decision in FEATURE_POLICY
// (`scripts/sdk-feature-policy.mjs`). Three things fail the gate:
//
//   A. The SDK defaults a feature we have not classified  -> decide about it.
//   B. FEATURE_POLICY names a feature the SDK no longer    -> policy is stale;
//      defaults (renamed or removed)                          re-verify.
//   C. The SDK changed its default mode for a feature      -> a default may
//                                                              have flipped on.
//
// WHAT IT DELIBERATELY DOES NOT CHECK. Whether our config actually declares
// the opt-out is asserted by `app-insights-config.test.ts`, which imports the
// same FEATURE_POLICY and checks the real object returned by
// `buildAppInsightsConfig`. That belongs there, not here: the test can
// *execute* the TypeScript, while a lint script could only re-parse its
// syntax. An earlier revision of this gate tried the latter and shipped a
// check that could not fail -- it tested `configSource.includes('SdkStats')`
// against a file whose own doc comment names `SdkStats` nine times.
//
// WHY AN AST, NOT REGEXES. The first revision of this gate matched
// `{ mode: <digits>` with a regex and walked braces by hand. It silently
// skipped any entry it could not match -- so `{ blockCdnCfg: false, mode: 3 }`
// (key order swapped) or `{ mode: MODE_ENABLE }` (symbolic) parsed as "no such
// feature", the count stayed nonzero, and the gate passed while the new
// feature went unclassified. That is the precise failure this gate exists to
// prevent. `scripts/check-launch-args.mjs` records the same lesson from four
// prior revisions of a structurally identical gate: "a hand-rolled JavaScript
// lexer will keep losing to valid syntax it does not model." `typescript` is
// already a direct devDependency and three scripts already parse with it, so
// the compiler's own parser does the lexing exactly right -- comments,
// strings, minified single-line input, and nested `onCfg`/`offCfg` objects all
// cease to be special cases.
//
// ALTERNATIVES CONSIDERED, AND WHY THEY FAIL. Recorded so they are not
// re-litigated:
//   - Assert against the SDK's published `.d.ts` instead of its dist bundle.
//     Unavailable: `IFeatureOptIn` is a bare index signature
//     (`{ [feature: string]: IFeatureOptInDetails }`). The types carry zero
//     key names and zero default modes; that information exists only as a
//     runtime value.
//   - Consume a machine-readable defaults manifest. There is none:
//     `defaultConfigValues` is a module-local `var`, never exported, and the
//     package ships no defaults manifest.
//   - Pin the SDK to an exact version and rely on human review of each bump.
//     That is the control that already failed -- this incident happened WITH
//     an explicit two-line manifest diff under review. Exact pinning changes
//     the number of reviews, not their content. (It is the one option immune
//     to bundle-shape change, so it complements this gate rather than
//     replacing it.)
//
// FAIL-CLOSED BEHAVIOR, per step: locating the feature map, resolving each
// key, and reading each mode all throw rather than returning a partial result.
// A feature entry that cannot be parsed is never silently dropped. The one
// deliberate non-throw is an entry with no `mode` at all, which is legal in
// the SDK's own contract (`IFeatureOptInDetails.mode` is optional) and means
// "fall through to the call site default" -- it parses as `none` and flows
// into the policy comparison, which reports it as unclassified if new.
//
// Invoke directly or via:
//   npm run lint:sdk-feature-optin

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import { FEATURE_OPT_IN_MODE, FEATURE_POLICY } from './sdk-feature-policy.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SDK_DEFAULTS_FILE = join(
  REPO_ROOT,
  'node_modules',
  '@microsoft',
  'applicationinsights-web',
  'dist-es5',
  'AISku.js',
);

const FEATURE_MAP_PROPERTY = 'featureOptIn';

const MODE_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(FEATURE_OPT_IN_MODE).map(([name, value]) => [value, name])),
);

function describeMode(mode) {
  return `${mode} (${MODE_NAMES[mode] ?? 'unknown'})`;
}

/** Unwraps parenthesized expressions: `(((x)))` -> `x`. */
function unwrapParens(node) {
  let current = node;
  while (current && ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/** Depth-first walk over every node in a tree. */
function walk(node, visit) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/**
 * Collects `const`/`let`/`var NAME = "value"` string constants.
 *
 * The SDK writes its default map with constant identifiers as computed keys
 * (`_a[SDK_STATS] = { mode: 3 }`), so the identifiers have to be resolved back
 * to the wire names. Comma-joined declarator lists (`var a = "x", b = "y";`)
 * fall out for free because each declarator is its own AST node.
 */
export function collectStringConstants(sourceFile) {
  const constants = new Map();
  walk(sourceFile, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      constants.set(node.name.text, node.initializer.text);
    }
  });
  return constants;
}

/**
 * Locates the single `featureOptIn:` property initializer in the file.
 *
 * Requires exactly one. Zero means the bundle shape changed; more than one is
 * ambiguous. Both throw rather than guessing.
 */
export function findFeatureMapInitializer(sourceFile) {
  const found = [];
  walk(sourceFile, (node) => {
    if (!ts.isPropertyAssignment(node)) return;
    const name = node.name;
    const text = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
    if (text === FEATURE_MAP_PROPERTY) found.push(node.initializer);
  });
  if (found.length === 0) {
    throw new Error(
      `could not find a '${FEATURE_MAP_PROPERTY}:' default in the SDK bundle. The bundle ` +
        'shape changed; re-verify defaultConfigValues by hand and update this gate.',
    );
  }
  if (found.length > 1) {
    throw new Error(
      `found ${found.length} '${FEATURE_MAP_PROPERTY}:' properties in the SDK bundle; ` +
        'expected exactly one. Re-verify by hand and update this gate.',
    );
  }
  return found[0];
}

/**
 * Resolves an entry's key to its wire name.
 *
 * Handles every assignment form the SDK's build has emitted across its own
 * published artifacts: computed identifier (`_a[SDK_STATS] =`), computed
 * literal (`_a["SdkStats"] =`), and plain member (`_a.zipPayload =`, which is
 * what minification produces for identifier-safe keys).
 */
function resolveEntryKey(target, constants) {
  if (ts.isElementAccessExpression(target)) {
    const argument = target.argumentExpression;
    if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
      return argument.text;
    }
    if (ts.isIdentifier(argument)) {
      const resolved = constants.get(argument.text);
      if (resolved === undefined) {
        throw new Error(
          `could not resolve feature key identifier '${argument.text}' to a string literal. ` +
            'The bundle shape changed; re-verify by hand and update this gate.',
        );
      }
      return resolved;
    }
    throw new Error(
      'a feature entry uses a dynamic computed key this gate cannot resolve. Re-verify by ' +
        'hand and update this gate.',
    );
  }
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return null;
}

/**
 * Reads the `mode` of one entry's object literal.
 *
 * A missing `mode` is legal (`IFeatureOptInDetails.mode` is optional) and
 * means "fall through to the call-site default", so it resolves to `none`
 * rather than throwing. A NON-NUMERIC mode is not legal for our purposes: we
 * cannot tell whether it means enable or disable, so it fails closed.
 */
function readEntryMode(objectLiteral, featureName) {
  const modeProperty = objectLiteral.properties.find((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    const name = property.name;
    return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'mode';
  });
  if (!modeProperty) return FEATURE_OPT_IN_MODE.none;
  const initializer = unwrapParens(modeProperty.initializer);
  if (!ts.isNumericLiteral(initializer)) {
    throw new Error(
      `feature '${featureName}' declares a non-literal mode ` +
        `(${ts.SyntaxKind[initializer.kind]}), so this gate cannot tell whether it is ` +
        'enabled. Re-verify by hand and update this gate.',
    );
  }
  return Number(initializer.text);
}

/**
 * Parses the SDK's default feature map into `{ name -> mode }`.
 *
 * Enumerates every entry first and requires each one to parse, so an entry
 * this gate does not understand fails the run instead of vanishing from the
 * result. Entry VALUES are not descended into, which is what keeps nested
 * `onCfg` / `offCfg` objects from being mistaken for entries.
 */
export function parseSdkFeatureDefaults(source, fileName = 'AISku.js') {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const constants = collectStringConstants(sourceFile);
  const initializer = unwrapParens(findFeatureMapInitializer(sourceFile));
  const defaults = new Map();

  if (ts.isObjectLiteralExpression(initializer)) {
    // Plain form: `featureOptIn: { SdkStats: { mode: 3 } }`.
    for (const property of initializer.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new Error(
          'a feature entry uses a spread or shorthand this gate cannot read. Re-verify by ' +
            'hand and update this gate.',
        );
      }
      const name = property.name;
      const key =
        ts.isIdentifier(name) || ts.isStringLiteral(name)
          ? name.text
          : ts.isComputedPropertyName(name) && ts.isIdentifier(name.expression)
            ? constants.get(name.expression.text)
            : undefined;
      if (key === undefined) {
        throw new Error(
          'could not resolve a feature key to a string literal. The bundle shape changed; ' +
            're-verify by hand and update this gate.',
        );
      }
      const value = unwrapParens(property.initializer);
      if (!ts.isObjectLiteralExpression(value)) {
        throw new Error(
          `feature '${key}' has a non-object default this gate cannot read. Re-verify by ` +
            'hand and update this gate.',
        );
      }
      defaults.set(key, readEntryMode(value, key));
    }
  } else {
    // Comma-expression form: `(_a = {}, _a[K] = { mode: 3 }, ..., _a)`.
    const visit = (node) => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const target = unwrapParens(node.left);
        if (ts.isElementAccessExpression(target) || ts.isPropertyAccessExpression(target)) {
          const value = unwrapParens(node.right);
          if (ts.isObjectLiteralExpression(value)) {
            const key = resolveEntryKey(target, constants);
            if (key === null) {
              throw new Error(
                'a feature entry uses an assignment target this gate cannot read. Re-verify ' +
                  'by hand and update this gate.',
              );
            }
            defaults.set(key, readEntryMode(value, key));
            // Deliberately do NOT descend into the value: nested onCfg /
            // offCfg objects are not entries.
            return;
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(initializer);
  }

  if (defaults.size === 0) {
    throw new Error(
      'located the featureOptIn default but parsed no feature entries from it. The bundle ' +
        'shape changed; re-verify by hand and update this gate.',
    );
  }
  return defaults;
}

/**
 * Compares the SDK's defaults against FEATURE_POLICY in both directions, and
 * checks the recorded default mode for drift.
 */
export function checkFeaturePolicy(sdkDefaults, policy) {
  const problems = [];

  for (const [name, mode] of sdkDefaults) {
    const entry = policy[name];
    if (!entry) {
      problems.push(
        `the SDK defaults a feature this repo has not classified: '${name}' at mode ` +
          `${describeMode(mode)}.\n` +
          `    Decide what it does to our telemetry inventory, then add it to FEATURE_POLICY\n` +
          `    in scripts/sdk-feature-policy.mjs. If it emits anything, opt out in\n` +
          `    src/app/core/telemetry/app-insights-config.ts as well.`,
      );
      continue;
    }
    if (entry.sdkDefaultMode !== mode) {
      problems.push(
        `the SDK changed its default for '${name}': FEATURE_POLICY records ` +
          `${describeMode(entry.sdkDefaultMode)}, the installed SDK defaults ` +
          `${describeMode(mode)}.\n` +
          `    A default may have flipped on. Re-verify and update FEATURE_POLICY.`,
      );
    }
  }

  for (const name of Object.keys(policy)) {
    if (!sdkDefaults.has(name)) {
      problems.push(
        `FEATURE_POLICY classifies '${name}' but the installed SDK no longer defaults it.\n` +
          `    It was renamed or removed -- an opt-out keyed on the old name is now a no-op.\n` +
          `    Re-verify and update FEATURE_POLICY and app-insights-config.ts together.`,
      );
    }
  }

  return problems;
}

function readSdkBundle() {
  if (!existsSync(SDK_DEFAULTS_FILE)) {
    throw new Error(
      `the Application Insights SDK bundle was not found at ${SDK_DEFAULTS_FILE}.\n` +
        '    Either dependencies are not installed (run `npm ci`), or the package\n' +
        '    reorganized its dist layout, which is the likelier cause after a major bump.\n' +
        '    In the second case, find the file declaring `defaultConfigValues` and update\n' +
        '    SDK_DEFAULTS_FILE.',
    );
  }
  return readFileSync(SDK_DEFAULTS_FILE, 'utf8');
}

function main() {
  let problems;
  let sdkDefaults;
  try {
    sdkDefaults = parseSdkFeatureDefaults(readSdkBundle(), SDK_DEFAULTS_FILE);
    problems = checkFeaturePolicy(sdkDefaults, FEATURE_POLICY);
  } catch (error) {
    console.error('');
    console.error('check-sdk-feature-optin: FAILED');
    console.error(`  - ${error instanceof Error ? error.message : String(error)}`);
    console.error('');
    return 1;
  }

  if (problems.length > 0) {
    console.error('');
    console.error('check-sdk-feature-optin: FAILED');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('');
    console.error('  See docs/telemetry.md for the SPA telemetry inventory this protects.');
    return 1;
  }

  const disabled = Object.values(FEATURE_POLICY).filter(
    (entry) => entry.decision === 'disable',
  ).length;
  console.log(
    `check-sdk-feature-optin: OK (${sdkDefaults.size} SDK feature default(s) classified, ` +
      `${disabled} opted out)`,
  );
  return 0;
}

// Only invoke main() when executed directly. The unit test imports this module
// solely for its exports and must not trigger CLI side effects.
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
