#!/usr/bin/env node
// Production-source pattern lint: rejects known-fragile patterns in
// production .ts files (frontend `src/` and `api/src/`), excluding test
// files and test helpers.
//
// Why this exists (separate from check-spec-patterns.mjs):
//   `check-spec-patterns.mjs` scans `*.spec.ts` for fragile testing
//   patterns. This script scans the rest of the production source for
//   patterns that defeat type-safety guarantees we want to keep.
//
// Current rules:
//   1. `as TelemetryMessageId`
//      The TelemetryMessageId literal-union catalog
//      (`src/app/core/telemetry/telemetry-message-ids.ts`) only protects
//      us if every emitter uses a token from the catalog. A cast like
//      `'foo.bar' as TelemetryMessageId` silently smuggles an
//      uncatalogued id into the wire format. Add the new token to
//      `TELEMETRY_MESSAGE_IDS` instead.
//
//   2. `.item(...).replace(` (Cosmos write footgun)
//      Direct `.item().replace()` calls on a Cosmos container bypass
//      the shared `replaceWithIfMatch` helper in
//      `api/src/shared/cosmos.ts`, which is the only path that
//      enforces server-side `_etag` IfMatch + automatic version bump
//      + structuredClone-based mutator + Cosmos 412 -> typed
//      `VersionConflictError`. Use `replaceWithIfMatch<T>(...)`
//      instead. The helper itself contains the only legitimate
//      `.replace<T>(` call, allowed via the
//      `// allow:cosmos-replace internal-only` pragma scoped to
//      `api/src/shared/cosmos.ts`.
//
//   3. `.upsert(` (Cosmos write footgun, no exemptions)
//      `upsert` hides whether the operation is an insert or a replace
//      and gives neither path a concurrency guarantee. Replace with
//      `items.create()` (insert with 409 on conflict) or
//      `replaceWithIfMatch<T>(...)` (etag-guarded replace).
//
//   4. `.selectedPath.set(` and `.selectedPath.update(` (issue #274
//      helper-bypass footgun)
//      Raw `.selectedPath.set(...)` / `.selectedPath.update(...)`
//      calls bypass the issue #266 defer/retry machinery. Intentional
//      writes must route through `JsonTreeComponent.setUserSelection()`.
//      System-clear writes inside `json-tree.component.ts` itself
//      remain raw but require the closed-vocabulary trailing pragma
//      `// allow:selected-path-set <helper|system-clear>`.
//      The rule fires repo-wide so cross-file writers (e.g., a
//      sibling component holding `viewChild(JsonTreeComponent)`)
//      cannot grow a back-door writer. The regex is defense-in-
//      depth, not airtight: destructuring, aliasing, bracket-notation,
//      and casts dodge the match; intentional circumvention is
//      visible in review.
//
//   5. `'@angular/service-worker'` (any subpath, any import form)
//      The `@angular/service-worker` (ngsw) package was removed when
//      we migrated to a minimal pass-through service worker (see
//      DESIGN_SPEC.md -> Versioning history + plan.md SW migration).
//      Re-introducing it would re-open the stuck-cohort bug class
//      (issue #167) AND the lint chain's lockfile gate would fail
//      (the package is no longer in package.json). The regex matches
//      static, side-effect, subpath, dynamic (`import('...')`), and
//      require-style imports. Specs would fail tsc with "Cannot
//      find module" but this gate surfaces the policy-level message
//      first, which is more actionable.
//
// File scope:
//   - frontend production: `src/**/*.ts`
//   - backend production:  `api/src/**/*.ts`
// Exclusions:
//   - any `*.spec.ts` (Karma frontend specs)
//   - any `*.test.ts` (Jest backend tests)
//   - any path containing `/testing/` or ending in `.testing.ts`
//
// Adding new rules:
//   Push a `{ pattern, message, pragma?, pragmaAllowedPaths? }` onto
//   RULES. `pattern` must be a RegExp; `message` must be a non-empty
//   string. `validateRules(RULES)` runs at module load and throws a
//   loud TypeError if either is missing or malformed. The `/g` flag
//   itself is enforced by `scanText`'s use of
//   `String.prototype.matchAll`, which V8 rejects with a TypeError
//   on a non-global RegExp -- a rule author who forgets `/g` gets a
//   loud failure on the first scan instead of a silent
//   `while (exec(...))` infinite-loop hang. See PR #370 panel
//   discussion for why engine-enforcement was preferred over a
//   handwritten `validateRegexRules({ global })` check.
//   When `pragma` is set, the scanner allows matches on lines that
//   contain the pragma string AND whose path matches one of
//   `pragmaAllowedPaths` (forward-slash form) - this keeps the
//   safe-harbor narrow.
//
//   `pragma` accepts either a string (literal `String.prototype.includes`
//   match -- used by rule #2) or a RegExp (`RegExp.prototype.test`
//   match -- used by rule #4 to enforce a closed-enum reason
//   vocabulary).
//
// Runs with zero dependencies on Node 24+. Invoke directly or via
//   npm run lint:prod-patterns

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RULES = [
  {
    pattern: /\bas\s+TelemetryMessageId\b/g,
    message:
      "Cast 'as TelemetryMessageId' defeats the literal-union catalog." +
      ' Add the new id to TELEMETRY_MESSAGE_IDS in' +
      ' src/app/core/telemetry/telemetry-message-ids.ts (with JSDoc)' +
      ' instead of casting at the call site.',
  },
  {
    // Match `.item(...)<optional whitespace incl. newlines>.replace(...)<optional generic>`.
    // The `[^)]*` inside `.item()` keeps it on one set of parens; the
    // `(?:<[^>\r\n]+>)?` piece allows `replace<BlobDocument>(` etc.
    // while preventing the generic from spanning lines.
    pattern: /\.item\([^)]*\)\s*\.replace(?:<[^>\r\n]+>)?\s*\(/g,
    message:
      'Direct `.item().replace(` bypasses the shared replaceWithIfMatch helper.' +
      ' Use `replaceWithIfMatch<T>(container, partitionKey, existing, mutate)`' +
      ' from api/src/shared/cosmos.ts so the write is etag-guarded and the' +
      ' version field is bumped automatically.',
    pragma: '// allow:cosmos-replace internal-only',
    pragmaAllowedPaths: [/^api\/src\/shared\/cosmos\.ts$/],
    paths: [/^api\/src\//],
  },
  {
    pattern: /\.upsert(?:<[^>\r\n]+>)?\s*\(/g,
    message:
      '`.upsert(` on a Cosmos container hides insert-vs-replace and provides' +
      ' no concurrency guarantee. Use `items.create()` for inserts' +
      ' (409 on conflict) or `replaceWithIfMatch<T>(...)` from' +
      ' api/src/shared/cosmos.ts for etag-guarded replaces.',
    // Scoped to api/ only - the Angular `Meta.upsert()` DOM service in
    // the frontend is unrelated to Cosmos and is not banned.
    paths: [/^api\/src\//],
  },
  {
    // Issue #274. Raw `.selectedPath.set(...)` /
    // `.selectedPath.update(...)` calls bypass the #266 defer/retry
    // machinery. Route intentional writes through
    // `JsonTreeComponent.setUserSelection()`. Fires repo-wide so a
    // hypothetical sibling component holding a
    // `viewChild(JsonTreeComponent)` reference cannot grow a
    // back-door writer. System writes inside json-tree.component.ts
    // itself remain raw but require a closed-vocabulary trailing
    // pragma (enforced by the RegExp pragma matcher below).
    //
    // The regex is defense-in-depth, not airtight: destructuring
    // (`const { selectedPath } = this`), aliasing (`const sig =
    // this.selectedPath`), bracket notation
    // (`this.selectedPath['set']`), and `(this.selectedPath as ...).set`
    // all dodge the match. The convention is documented in the doc
    // block at `selectedPath`'s declaration; intentional
    // circumvention is possible but obvious in review.
    //
    // The pragma terminator `(?![-\w])` rejects suffixes containing
    // word characters or hyphens (so `helper-typo`, `helpers`,
    // `system-clear-foo` all fail), but allows the natural
    // line-terminators we expect in source (`helper.`, `helper\t`,
    // `helper\r\n`, `helper` at EOF).
    pattern: /\.selectedPath\.(?:set|update)\s*\(/g,
    message:
      'Raw `.selectedPath.set(...)` / `.selectedPath.update(...)` bypass' +
      ' issue #266 defer/retry. Route intentional writes through' +
      ' `setUserSelection()` on JsonTreeComponent. System writes inside' +
      ' json-tree.component.ts require the closed-vocabulary pragma' +
      ' `// allow:selected-path-set <helper|system-clear>`.',
    pragma: /\/\/\s*allow:selected-path-set\s+(?:helper|system-clear)(?![-\w])/,
    pragmaAllowedPaths: [/^src\/app\/shared\/components\/json-tree\/json-tree\.component\.ts$/],
    // No `paths` filter: fires repo-wide. The only legitimate
    // writers live in json-tree.component.ts and that file is
    // covered by pragmaAllowedPaths.
  },
  {
    // Matches static, side-effect, subpath, dynamic, and require-style
    // imports of @angular/service-worker. The package was removed in
    // the SW migration; re-introducing it would re-open the
    // stuck-cohort class (issue #167). The optional subpath group
    // `(?:\/[^'"\s]*)?` covers imports like
    // `@angular/service-worker/config` without matching unrelated
    // packages that happen to start with the same prefix.
    pattern: /['"]@angular\/service-worker(?:\/[^'"\s]*)?['"]/g,
    message:
      "Import of '@angular/service-worker' is forbidden. The package was" +
      ' removed in the SW migration; re-introducing it would re-open the' +
      ' stuck-cohort bug class (issue #167) and break the lockfile lint.' +
      ' See DESIGN_SPEC.md -> Versioning history. If you genuinely need' +
      ' to revisit this decision, amend DESIGN_SPEC.md and this rule in' +
      ' the same PR.',
  },
];

/**
 * Asserts that each rule has the shape `{ pattern: RegExp, message:
 * string, ... }` with a RegExp pattern and a non-empty message.
 * Throws a loud TypeError at module load if any rule fails. Pure: no
 * I/O.
 *
 * The `/g` flag on `pattern` is intentionally NOT checked here. V8's
 * `String.prototype.matchAll` throws a TypeError on a non-global
 * RegExp on the first scan, which gives a better stack trace
 * pointing at the actual call site (scanText). See PR #370 panel
 * discussion. Exported for unit-test use.
 */
export function validateRules(rules) {
  for (const rule of rules) {
    if (!(rule.pattern instanceof RegExp)) {
      throw new TypeError(
        `check-prod-patterns: rule pattern must be a RegExp, got ${typeof rule.pattern}.` +
          ` See "Adding new rules" in scripts/check-prod-patterns.mjs.`,
      );
    }
    if (typeof rule.message !== 'string' || rule.message.length === 0) {
      throw new TypeError(
        `check-prod-patterns: rule for pattern ${rule.pattern} has missing or empty` +
          ` \`message\`. See scripts/check-prod-patterns.mjs.`,
      );
    }
  }
}

// Validate at module load: throws loudly if any rule shape is broken.
// Pure check (no I/O), so this does not violate the "no CLI side
// effects on import" invariant called out at the foot of this file.
validateRules(RULES);

export function listProdFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'buffer' },
  );
  const all = out.toString('utf8').split('\0').filter(Boolean);
  return all
    .filter((p) => p.endsWith('.ts'))
    .filter((p) => p.startsWith('src/') || p.startsWith('api/src/'))
    .filter((p) => !p.endsWith('.spec.ts') && !p.endsWith('.test.ts'))
    .filter((p) => !p.includes('/testing/') && !p.endsWith('.testing.ts'));
}

/**
 * Tests whether a candidate trailing-pragma line matches a rule's
 * `pragma` field. The field is either a string (literal-substring
 * match via `String.prototype.includes`, used by rule #2) or a
 * RegExp (`RegExp.prototype.test`, used by rule #4 to enforce a
 * closed-enum reason vocabulary).
 *
 * Exported for unit-testing under `scripts/check-prod-patterns.test.mjs`.
 */
export function matchesPragma(pragma, fullLine) {
  if (typeof pragma === 'string') {
    return fullLine.includes(pragma);
  }
  if (pragma instanceof RegExp) {
    return pragma.test(fullLine);
  }
  throw new TypeError(
    `check-prod-patterns: rule.pragma must be string or RegExp, got ${typeof pragma}`,
  );
}

export function scan(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  // Normalize the path for cross-platform pragmaAllowedPaths matching.
  // git ls-files returns forward-slash paths on every platform, but
  // belt-and-suspenders against any future Windows-native call site.
  const normalizedPath = path.replace(/\\/g, '/');
  return scanText(text, normalizedPath);
}

/**
 * Pure-function variant of `scan` that takes the file's text and
 * normalized path directly. Exported so unit tests can exercise the
 * scanner against in-memory fixtures without touching the filesystem.
 *
 * Engine choice: `String.prototype.matchAll` over `while (exec(...))`.
 * matchAll throws `TypeError: String.prototype.matchAll called with
 * a non-global RegExp argument` if a rule forgets `/g`. The legacy
 * `while ((m = rule.pattern.exec(text)) !== null)` form would
 * instead hang forever on the first match (exec restarts at
 * lastIndex=0 for non-global regex), turning a rule-authoring typo
 * into a silent CI infinite-loop. See PR #370 panel discussion.
 */
export function scanText(text, normalizedPath) {
  const violations = [];
  for (const rule of RULES) {
    if (rule.paths && !rule.paths.some((re) => re.test(normalizedPath))) {
      continue;
    }
    let matches;
    try {
      matches = text.matchAll(rule.pattern);
    } catch (cause) {
      throw new TypeError(
        `check-prod-patterns: rule pattern ${rule.pattern} is not a global RegExp` +
          ` (matchAll requires /g). Add the /g flag to the rule in` +
          ` scripts/check-prod-patterns.mjs and re-run \`npm run test:scripts\`.`,
        { cause },
      );
    }
    for (const m of matches) {
      const upToMatch = text.slice(0, m.index);
      const lastNl = upToMatch.lastIndexOf('\n');
      const line = upToMatch.split('\n').length;
      const col = m.index - (lastNl + 1) + 1;
      // Skip matches inside line comments (`// ...`) or JSDoc /
      // block-comment lines (a line whose non-whitespace prefix
      // before the match starts with `*` or `//`). This lets
      // documentation reference the banned pattern without tripping
      // the lint. We do not parse multi-line `/* ... */` blocks
      // exhaustively - the `*` prefix on each continuation line in
      // our codebase covers the JSDoc case.
      const lineSoFar = text.slice(lastNl + 1, m.index);
      if (/^\s*(\*|\/\/)/.test(lineSoFar)) {
        continue;
      }
      if (lineSoFar.includes('//')) {
        continue;
      }
      // Per-rule trailing pragma support: if the rule defines a
      // `pragma`, look for the pragma on the line where the match
      // ENDS. If found AND the file path matches one of
      // `pragmaAllowedPaths`, allow the match. This safe-harbor is
      // intentionally narrow so a stray `// allow:...` pasted into
      // any other file is still a violation.
      if (rule.pragma) {
        const matchEnd = m.index + m[0].length;
        const lineStart = (text.lastIndexOf('\n', matchEnd - 1) ?? -1) + 1;
        const eolIdx = text.indexOf('\n', matchEnd);
        const lineEnd = eolIdx === -1 ? text.length : eolIdx;
        const fullLine = text.slice(lineStart, lineEnd);
        if (matchesPragma(rule.pragma, fullLine)) {
          const allowed =
            !rule.pragmaAllowedPaths ||
            rule.pragmaAllowedPaths.some((re) => re.test(normalizedPath));
          if (allowed) {
            continue;
          }
          // Pragma is present but the file is not on the allow-list.
          // Fall through so the violation is reported with the
          // pragma-specific guidance baked into the message.
        }
      }
      violations.push({ path: normalizedPath, line, col, message: rule.message, snippet: m[0] });
    }
  }
  return violations;
}

export function main() {
  const files = listProdFiles();
  const allViolations = files.flatMap(scan);

  if (allViolations.length === 0) {
    console.log(
      `check-prod-patterns: OK (${files.length} production .ts files scanned, 0 violations)`,
    );
    return 0;
  }

  console.error('check-prod-patterns: violations found:');
  for (const v of allViolations) {
    console.error(`  ${v.path}:${v.line}:${v.col}  ${v.snippet}`);
    console.error(`    -> ${v.message}`);
  }
  console.error(`\n${allViolations.length} violation(s) in ${files.length} production .ts files.`);

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
// (the test file at scripts/check-prod-patterns.test.mjs) load the
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
