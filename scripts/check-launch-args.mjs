#!/usr/bin/env node
// Vitest Chromium launch-args composition lint (issue #533).
//
// Motivating incident: PR #418 tried to pass Chromium launch flags via
// `instances[].launch.args`. `@vitest/browser-playwright` silently
// ignores that field -- it reads launch options *only* from the
// `playwright({ launchOptions: { args: [...] } })` factory argument,
// which it spreads into the object handed to Playwright's `.launch()`.
// Nothing errored; the flags simply never reached Chromium.
//
// Why this needs a gate rather than a comment or a runtime test:
//
//   1. The flags are UNOBSERVABLE where we run. Every CI job is a bare
//      `runs-on: ubuntu-latest` VM with no `container:` key, running as
//      the non-root `runner` user. There, `--no-sandbox` (needed for
//      root/containers), `--disable-dev-shm-usage` (needed for Docker's
//      64MB /dev/shm), and `--disable-gpu` (redundant under
//      `headless: true`) are all effectively inert. On Windows dev
//      machines they are inert too. So a silent args-drop produces no
//      failure anywhere -- until CI moves to a container or a root
//      user, at which point it surfaces as intermittent Chromium
//      crashes. Silent divergence with no detection mechanism.
//
//   2. A runtime assertion could only prove the CHANNEL, not the
//      CONTENTS. Observing one flag's side effect (e.g. `window.gc`
//      from `--js-flags=--expose-gc`) cannot distinguish
//      `args: [...COMMON_LAUNCH_ARGS, ...extraArgs]` from
//      `args: [...extraArgs]`. The head of the array is the
//      CI-stability-critical part, and it has no in-page observable.
//
//   3. A static check costs milliseconds and needs no Chromium boot,
//      so it can fail before the thing it checks has booted.
//
// Three invariants, all read from `vitest.shared.mts`:
//   1. `COMMON_LAUNCH_ARGS` declares exactly the expected flag set.
//   2. `makeBrowserConfig` composes `launchOptions.args` as the spread
//      `[...COMMON_LAUNCH_ARGS, ...extraArgs]` inside a `playwright({
//      launchOptions: { args } })` factory call.
//   3. No `vitest*.mts` reintroduces an `instances[].launch` field --
//      the literal #418 regression.
//
// Runtime proof that args actually reach Chromium lives where it
// belongs: `ensureGc()` in `json-tree.component.perf.ts` throws if
// `--js-flags=--expose-gc` (passed via `extraArgs`) failed to arrive.
// That covers the L2 perf bench; this gate covers the composition for
// every harness, including the unit suite CI actually runs.

import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

/**
 * The flag set `COMMON_LAUNCH_ARGS` must declare, in order.
 *
 * Changing this list is a deliberate act: update both this array and
 * `vitest.shared.mts`, and say why in the commit message. The gate
 * compares order-sensitively because the array is concatenated into a
 * flat argv, and Chromium honors the LAST occurrence of a repeated
 * switch -- so ordering is semantically load-bearing, not cosmetic.
 */
export const EXPECTED_COMMON_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
];

const SHARED_CONFIG = 'vitest.shared.mts';

/**
 * Strips `//` line comments and block comments so the matchers below
 * scan code only.
 *
 * This is load-bearing, not defensive: `vitest.shared.mts`'s own JSDoc
 * documents the correct shape by quoting it verbatim
 * (`playwright({ launchOptions: { args: [...] } })`), and an earlier
 * revision of this gate matched that prose instead of the real call.
 * A gate that can be satisfied -- or tripped -- by a comment is not a
 * gate.
 *
 * String-literal contents are preserved; the only sequences treated as
 * comment openers are ones outside a string or template literal.
 */
export function stripComments(source) {
  let out = '';
  let index = 0;
  let quote = null;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      if (char === '\\') {
        out += char + (next ?? '');
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      out += char;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        // Preserve newlines so reported line numbers stay meaningful.
        if (source[index] === '\n') out += '\n';
        index += 1;
      }
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * Replaces the *contents* of string and template literals with a filler
 * character, preserving the quotes and the exact length of the source.
 *
 * `stripComments` deliberately keeps string contents, because a config may
 * legitimately need them. But the structural matchers below are plain
 * regexes, so without masking, a quoted decoy like
 * `"provider: playwright({ launchOptions: { args: [...COMMON_LAUNCH_ARGS, ...extraArgs] } })"`
 * inside a log message would satisfy this gate even if the real provider
 * were missing or malformed -- a false negative in a guard whose whole job
 * is to notice that.
 *
 * Length is preserved so a match index in the masked text points at the
 * same offset in the original, letting the caller slice real content
 * (e.g. the actual flag literals) back out of the unmasked source.
 */
export function maskStringLiterals(code) {
  const chars = [...code];
  let index = 0;
  let quote = null;
  while (index < chars.length) {
    const char = chars[index];
    if (quote) {
      if (char === '\\') {
        // Blank the escape pair so a `\"` cannot appear to close the string.
        chars[index] = FILLER;
        if (index + 1 < chars.length) chars[index + 1] = FILLER;
        index += 2;
        continue;
      }
      if (char === quote) {
        quote = null;
      } else if (char !== '\n') {
        chars[index] = FILLER;
      }
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    index += 1;
  }
  return chars.join('');
}

/** Neutral stand-in for masked literal contents; matches none of the patterns below. */
const FILLER = '\u0000';

/** Matches the `export const COMMON_LAUNCH_ARGS ... = [ ... ];` block. */
const COMMON_ARGS_BLOCK = /export\s+const\s+COMMON_LAUNCH_ARGS\s*:[^=]*=\s*\[([\s\S]*?)\]\s*;/d;

/**
 * Matches the provider factory call and captures the `args:` value, e.g.
 *   provider: playwright({ launchOptions: { args: [...A, ...B] } })
 *
 * Anchored on `provider:` deliberately. An unanchored `playwright(...)`
 * matcher would be satisfied by any such call in the file, so a future
 * config could leave an unused helper carrying the expected composition
 * while `makeBrowserConfig()` actually returned a different provider, and
 * this gate would still pass.
 */
const PROVIDER_ARGS =
  /provider\s*:\s*playwright\s*\(\s*\{[\s\S]*?launchOptions\s*:\s*\{[\s\S]*?args\s*:\s*\[([\s\S]*?)\][\s\S]*?\}[\s\S]*?\}\s*\)/d;

/**
 * The exact `launchOptions.args` composition, after whitespace is stripped
 * (a trailing comma is allowed).
 *
 * Order is load-bearing, not cosmetic: `args` is a flat argv, and Chromium
 * honors the LAST occurrence of a repeated switch. `COMMON_LAUNCH_ARGS` is
 * the shared baseline and `extraArgs` is the per-harness override, so
 * `extraArgs` must come second or a caller could not override a baseline
 * flag. An earlier revision of this gate tested for the two spreads
 * independently, which accepted `[...extraArgs, ...COMMON_LAUNCH_ARGS]`
 * and any duplicate or additional entry.
 */
const EXPECTED_COMPOSITION = /^\.\.\.COMMON_LAUNCH_ARGS,\.\.\.extraArgs,?$/;

/**
 * Extracts the body of each `instances: [ ... ]` array literal.
 *
 * A regex cannot do this correctly, in two separate ways, both of which
 * produced false positives that would reject a valid config:
 *
 *   1. An earlier revision used
 *      `/instances\s*:\s*\[[\s\S]*?\blaunch\s*:/`, whose `[\s\S]*?` is
 *      unbounded -- it ran past the array's closing `]` and matched an
 *      unrelated later `launch:` property.
 *   2. The revision after that found the opener with a plain regex, which
 *      matched inside string and template literals. `stripComments`
 *      deliberately preserves string contents, so a log message or error
 *      string mentioning `instances: [{ launch: ... }]` was treated as a
 *      real array.
 *
 * For a lint gate a false positive is worse than the miss it guards
 * against, because it blocks correct work rather than merely failing to
 * catch bad work. So this walks the source once, tracking quote state, and
 * only recognises an opener while outside a literal. The body is then
 * delimited by bracket depth, also skipping literals so a `]` inside a
 * string cannot end the array early.
 *
 * Input is expected to be comment-stripped already.
 *
 * @param code comment-stripped source
 * @returns one entry per `instances:` array, each the text between its
 *   outermost brackets
 */
export function extractInstancesArrays(code) {
  const bodies = [];
  // Sticky so it can be anchored at the cursor without slicing the source.
  const opener = /instances\s*:\s*\[/y;
  const isWordChar = (char) => char !== undefined && /[\w$]/.test(char);
  let index = 0;
  let quote = null;

  while (index < code.length) {
    const char = code[index];

    if (quote) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      index += 1;
      continue;
    }

    // Only attempt a match at an identifier boundary, so `myinstances:`
    // does not register as an opener.
    if (char === 'i' && !isWordChar(code[index - 1])) {
      opener.lastIndex = index;
      const match = opener.exec(code);
      if (match) {
        const start = index + match[0].length;
        const end = scanToMatchingBracket(code, start);
        bodies.push(code.slice(start, end));
        index = end;
        continue;
      }
    }

    index += 1;
  }

  return bodies;
}

/**
 * Given an index just past an opening `[`, returns the index of its
 * matching `]`, tracking nested brackets and skipping string and template
 * literals. On unbalanced input returns the end of the source, so a
 * malformed config still gets scanned rather than silently skipped.
 */
function scanToMatchingBracket(code, start) {
  let depth = 1;
  let index = start;
  let quote = null;
  while (index < code.length) {
    const char = code[index];
    if (quote) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '[' || char === '{' || char === '(') {
      depth += 1;
    } else if (char === ']' || char === '}' || char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return index;
}

/** Matches a `launch` key, whether written as `launch:` or `launch :`. */
const LAUNCH_KEY = /\blaunch\s*:/;

/** Parses the string-literal entries out of a captured array body. */
export function parseArrayLiterals(body) {
  return [...body.matchAll(/['"`]([^'"`]+)['"`]/g)].map((match) => match[1]);
}

/**
 * Lints the shared-config source text. Returns an array of violation
 * strings; empty means clean.
 *
 * @param source contents of `vitest.shared.mts`
 * @param path display path used in messages
 */
export function lintSharedConfig(source, path = SHARED_CONFIG) {
  const violations = [];
  const code = stripComments(source);
  // Structural matching runs against masked literals so a quoted decoy
  // cannot satisfy the gate. Lengths are preserved, so a capture group's
  // offsets index the unmasked `code` for the real content.
  const masked = maskStringLiterals(code);
  // `d` (hasIndices) gives exact capture-group offsets, which index the
  // unmasked `code` because masking preserves length.
  const captured = (match, groupIndex) => {
    const span = match.indices?.[groupIndex];
    return span ? code.slice(span[0], span[1]) : match[groupIndex];
  };

  const argsBlock = COMMON_ARGS_BLOCK.exec(masked);
  if (!argsBlock) {
    violations.push(
      `${path}: could not find an \`export const COMMON_LAUNCH_ARGS ... = [ ... ];\` declaration. ` +
        `The launch-args funnel is the PR #418 regression guard; do not remove or rename it.`,
    );
  } else {
    const declared = parseArrayLiterals(captured(argsBlock, 1));
    const expected = EXPECTED_COMMON_LAUNCH_ARGS;
    if (declared.length !== expected.length || declared.some((flag, i) => flag !== expected[i])) {
      violations.push(
        `${path}: COMMON_LAUNCH_ARGS is [${declared.join(', ')}] but expected ` +
          `[${expected.join(', ')}]. If this change is deliberate, update ` +
          `EXPECTED_COMMON_LAUNCH_ARGS in scripts/check-launch-args.mjs in the same commit ` +
          `and explain why in the commit message.`,
      );
    }
  }

  const providerArgs = PROVIDER_ARGS.exec(masked);
  if (!providerArgs) {
    violations.push(
      `${path}: could not find a \`provider: playwright({ launchOptions: { args: [...] } })\` ` +
        `factory call. @vitest/browser-playwright reads launch options ONLY from this factory ` +
        `argument (re-verified against 4.1.11); any other placement is silently ignored.`,
    );
  } else {
    const providerArgsBody = captured(providerArgs, 1);
    const composition = providerArgsBody.replace(/\s+/g, '');
    if (!EXPECTED_COMPOSITION.test(composition)) {
      const missingCommon = !composition.includes('...COMMON_LAUNCH_ARGS');
      const missingExtra = !composition.includes('...extraArgs');
      let why;
      if (missingCommon && missingExtra) {
        why =
          'it spreads neither COMMON_LAUNCH_ARGS nor extraArgs. Dropping the ' +
          'baseline silently strips --no-sandbox / --disable-gpu / ' +
          '--disable-dev-shm-usage from every browser run, with no test failure ' +
          'on GitHub-hosted VM runners.';
      } else if (missingCommon) {
        why =
          'it does not spread COMMON_LAUNCH_ARGS. That silently strips ' +
          '--no-sandbox / --disable-gpu / --disable-dev-shm-usage from every ' +
          'browser run, with no test failure on GitHub-hosted VM runners.';
      } else if (missingExtra) {
        why =
          'it does not spread extraArgs. The L2 perf bench passes ' +
          '--js-flags=--expose-gc through that parameter; dropping it breaks ensureGc().';
      } else {
        why =
          'the spreads are out of order or carry extra entries. `args` is a flat ' +
          'argv and Chromium honors the LAST occurrence of a repeated switch, so ' +
          'COMMON_LAUNCH_ARGS must come first and extraArgs must come second -- ' +
          'otherwise a harness cannot override a baseline flag.';
      }
      violations.push(
        `${path}: the provider's \`launchOptions.args\` must be exactly ` +
          `\`[...COMMON_LAUNCH_ARGS, ...extraArgs]\`, but ${why} ` +
          `Found \`[${providerArgsBody.trim()}]\`.`,
      );
    }
  }

  return violations;
}

/** Lints one config file for the `instances[].launch` regression shape. */
export function lintInstancesLaunch(source, path) {
  const hasLaunch = extractInstancesArrays(stripComments(source)).some((body) =>
    LAUNCH_KEY.test(body),
  );
  if (hasLaunch) {
    return [
      `${path}: found a \`launch\` field inside an \`instances: [...]\` entry. ` +
        `@vitest/browser-playwright silently ignores it (PR #418). Pass launch ` +
        `flags through makeBrowserConfig()'s extraArgs parameter instead, which ` +
        `funnels them into the playwright({ launchOptions: { args } }) factory.`,
    ];
  }
  return [];
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
