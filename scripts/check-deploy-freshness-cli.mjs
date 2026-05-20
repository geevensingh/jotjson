#!/usr/bin/env node
// scripts/check-deploy-freshness-cli.mjs
//
// Workflow-lint gate. Walks .github/workflows/cd.yml and
// .github/workflows/cd-nonprod.yml, finds every `run:` block invoking
// `npm run check:deploy-freshness`, substitutes `${{ ... }}`
// expressions with type-specific sentinels, and replays the resulting
// argv through `parseCliOptions` from check-deploy-freshness.mjs.
//
// Why this exists: PR #337 silently shipped without SHA-tied
// verification because the workflow argv passed `--expected-sha=<sha>`
// but the script's strict `requireNoUnknownArgs` rejected it. Neither
// side knew about the drift until the freshness step started failing
// in CI. This lint catches the drift at PR-review time -- if the
// workflow argv would fail `parseCliOptions`, the lint fails.
//
// The lint additionally enforces that every CI callsite passes either:
//   --expected-sha=<sha-expression-resolving-to-40-hex>     (strict)
//   --allow-byte-match-only                                  (opt-out)
//
// The strict mode is the default for CI; the opt-out is reserved for
// local-dev probes against a deployed origin and is unconditionally
// rejected here (CI callsites must always use --expected-sha).

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import yaml from 'js-yaml';

import { parseCliOptions } from './check-deploy-freshness.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const WORKFLOW_FILES = Object.freeze([
  join(repoRoot, '.github/workflows/cd.yml'),
  join(repoRoot, '.github/workflows/cd-nonprod.yml'),
]);

// Sentinel values used to substitute `${{ ... }}` expressions before
// replaying the argv through parseCliOptions. Each sentinel must
// validate as the correct type so parseCliOptions accepts it -- a
// bug in the sentinel would silently let workflow drift slip
// through.
const SHA_SENTINEL = 'a'.repeat(40);
const ORIGIN_SENTINEL = 'https://sentinel.example.com';
const GENERIC_SENTINEL = 'sentinel-value';

// Expressions allowed on the RHS of `--expected-sha=<expr>`. Any
// `${{ ... }}` that the workflow uses to populate the SHA must
// reference a field that GitHub Actions guarantees is non-empty at
// runtime; `vars.*` and `env.*` can resolve to empty strings if
// unset, which would slip through a naive presence check and
// degrade the gate exactly the way PR #337 did.
const ALLOWED_SHA_EXPRESSIONS = Object.freeze([
  '${{ github.event.workflow_run.head_sha || github.sha }}',
  '${{ github.sha }}',
  '${{ env.JOTJSON_BUILD_SHA }}',
]);

/**
 * Substitute a `${{ ... }}` expression with a sentinel that matches
 * the expected runtime type. Per-flag context drives the sentinel
 * type so an `--origin=${{ vars.X }}` substitution produces a valid
 * https URL while `--expected-sha=${{ ... }}` produces 40-hex.
 */
function substituteExpression(rawValue, flagName) {
  if (!rawValue.includes('${{')) return rawValue;
  if (flagName === '--expected-sha') {
    if (!ALLOWED_SHA_EXPRESSIONS.includes(rawValue.trim())) {
      throw new Error(
        `--expected-sha expression ${JSON.stringify(rawValue)} is not on the allowlist. ` +
          `Allowed: ${ALLOWED_SHA_EXPRESSIONS.map((expression) => JSON.stringify(expression)).join(', ')}. ` +
          `Adding a new expression requires confirming it cannot evaluate to empty at runtime ` +
          `(vars.* and unset env.* can both resolve to empty, which would slip the freshness gate).`,
      );
    }
    return SHA_SENTINEL;
  }
  if (flagName === '--origin') return ORIGIN_SENTINEL;
  if (flagName === '--local-sw') return GENERIC_SENTINEL;
  // Unknown flag with a `${{ ... }}` value: keep raw, let
  // parseCliOptions reject it as "Unknown argument".
  return rawValue;
}

/**
 * Tokenize a shell `run:` script and extract the argv passed after
 * `npm run check:deploy-freshness --`. Returns null when the script
 * does not invoke the freshness check.
 *
 * Limitations: handles only single-line invocations on the form
 *   `npm run check:deploy-freshness -- ARG1 ARG2 ...`
 * with arguments either bare-word (`--flag=value`) or quoted with
 * single or double quotes. Multi-line shell scripts with the call
 * inside a heredoc are out of scope -- if such a callsite is added,
 * extend this tokenizer.
 */
function extractFreshnessArgv(runScript) {
  if (!runScript.includes('check:deploy-freshness')) return null;
  // Collapse multi-line continuations into a single line.
  const collapsed = runScript.replace(/\\\r?\n\s*/g, ' ');
  // Match `npm run check:deploy-freshness -- ARG1 ARG2 ...` greedily;
  // capture everything after `--` to the end of the script. Splitting
  // on shell terminators like `;` / `&&` / `||` is unsafe because
  // `||` legitimately appears inside `${{ ... }}` GitHub expressions
  // (e.g. `${{ github.event.workflow_run.head_sha || github.sha }}`),
  // which would truncate the captured argv and silently mis-parse the
  // workflow callsite. Our two callsites are single-line invocations;
  // if a future callsite layers shell separators after the invocation,
  // extend this with `${{ ... }}`-aware tokenization rather than a
  // naive regex.
  const match = collapsed.match(/npm\s+run\s+check:deploy-freshness\s+--\s+(.+)$/m);
  if (!match) {
    throw new Error(
      `Found 'check:deploy-freshness' in a run: block but could not parse the argv. ` +
        `Expected pattern: 'npm run check:deploy-freshness -- ARG1 ARG2 ...'. ` +
        `Script body: ${JSON.stringify(runScript)}`,
    );
  }
  return tokenizeShellArgv(match[1].trim());
}

/**
 * Shell-aware split that preserves `--flag=value` boundaries, handles
 * single and double quotes, and treats `${{ ... }}` blocks as opaque
 * (the whole expression stays in the same token even if it contains
 * spaces).
 */
function tokenizeShellArgv(argvString) {
  const tokens = [];
  let current = '';
  let quote = null;
  let inExpression = 0;

  for (let i = 0; i < argvString.length; i += 1) {
    const character = argvString[i];
    if (inExpression > 0) {
      current += character;
      if (character === '{' && argvString[i - 1] === '$') {
        inExpression += 1;
      } else if (character === '}' && argvString[i + 1] === '}') {
        current += '}';
        i += 1;
        inExpression -= 1;
      }
      continue;
    }
    if (character === '$' && argvString[i + 1] === '{' && argvString[i + 2] === '{') {
      current += '${{';
      i += 2;
      inExpression = 1;
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        quote = null;
        continue;
      }
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += character;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * For each token, substitute any embedded `${{ ... }}` expression
 * using the per-flag sentinel rules. Tokens on the form `--foo=bar`
 * are split on the first `=`; bare flags like `--allow-byte-match-only`
 * are passed through unchanged.
 */
function substituteTokenExpressions(tokens) {
  return tokens.map((token) => {
    if (!token.includes('${{')) return token;
    const equalsIndex = token.indexOf('=');
    if (equalsIndex === -1) return token;
    const flagName = token.slice(0, equalsIndex);
    const value = token.slice(equalsIndex + 1);
    const substituted = substituteExpression(value, flagName);
    return `${flagName}=${substituted}`;
  });
}

function describeCallsite({ workflowPath, jobId, stepName, lineHint }) {
  const relPath = workflowPath.replace(repoRoot, '').replaceAll('\\', '/');
  const stepLabel = stepName ? `step "${stepName}"` : `step <unnamed>`;
  const hintSuffix = lineHint ? ` (line ${lineHint})` : '';
  return `${relPath} :: job ${jobId} :: ${stepLabel}${hintSuffix}`;
}

function collectCallsites(workflowPath) {
  const text = readFileSync(workflowPath, 'utf8');
  let parsed;
  try {
    parsed = yaml.load(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${workflowPath} as YAML: ${message}`);
  }
  const callsites = [];
  const jobs = parsed?.jobs ?? {};
  for (const [jobId, jobDef] of Object.entries(jobs)) {
    const steps = Array.isArray(jobDef?.steps) ? jobDef.steps : [];
    for (const step of steps) {
      const runScript = typeof step?.run === 'string' ? step.run : null;
      if (!runScript) continue;
      if (!runScript.includes('check:deploy-freshness')) continue;
      const argv = extractFreshnessArgv(runScript);
      if (argv === null) continue;
      const lineHint = (() => {
        const needle = `name: ${step?.name ?? ''}`;
        if (!step?.name) return null;
        const index = text.indexOf(needle);
        if (index === -1) return null;
        return text.slice(0, index).split('\n').length;
      })();
      callsites.push({
        workflowPath,
        jobId,
        stepName: step?.name ?? null,
        lineHint,
        rawArgv: argv,
        rawRunScript: runScript,
      });
    }
  }
  return callsites;
}

function assertStrictModeOrOptOut({ tokens, description }) {
  const hasExpectedSha = tokens.some((token) => token.startsWith('--expected-sha='));
  const hasOptOut = tokens.some((token) => token === '--allow-byte-match-only');
  if (!hasExpectedSha && !hasOptOut) {
    throw new Error(
      `${description}: missing --expected-sha=<sha> (strict CI mode). ` +
        `To opt out for a local-dev probe, pass --allow-byte-match-only; ` +
        `CI callsites should always use --expected-sha.`,
    );
  }
  if (hasOptOut) {
    throw new Error(
      `${description}: passes --allow-byte-match-only, which is reserved for local-dev ` +
        `probes against a deployed origin. CI callsites must use ` +
        `--expected-sha=<sha> so SHA-tied verification is in effect. ` +
        `If this callsite genuinely needs the degraded mode, document the ` +
        `reason in a code comment and update this lint to allowlist it.`,
    );
  }
}

export function checkFreshnessCli({ workflowFiles = WORKFLOW_FILES, logger = console } = {}) {
  const errors = [];
  const callsiteCount = { count: 0 };
  for (const workflowPath of workflowFiles) {
    let callsites;
    try {
      callsites = collectCallsites(workflowPath);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    for (const callsite of callsites) {
      callsiteCount.count += 1;
      const description = describeCallsite(callsite);
      try {
        const substituted = substituteTokenExpressions(callsite.rawArgv);
        assertStrictModeOrOptOut({ tokens: substituted, description });
        // Substitute env=value into the sentinel env for parseCliOptions:
        // workflow argv may reference DEPLOY_ORIGIN via the env table, but
        // for the CLI replay we only care about the argv-side flags.
        parseCliOptions(substituted, {});
        logger.log(`check-deploy-freshness-cli: OK ${description}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${description}: ${message}`);
      }
    }
  }
  if (callsiteCount.count === 0) {
    errors.push(
      'check-deploy-freshness-cli: found 0 callsites of `npm run check:deploy-freshness` ' +
        'across the inspected workflow files. The freshness gate is meant to run on every ' +
        'CD path; a zero-callsite count almost certainly means the lint is no longer ' +
        'covering the workflows it was designed to cover.',
    );
  }
  return { callsiteCount: callsiteCount.count, errors };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length > 0) {
    throw new Error(`check-deploy-freshness-cli: takes no arguments (got: ${argv.join(' ')}).`);
  }
  const { callsiteCount, errors } = checkFreshnessCli({ logger: console });
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`::error::check-deploy-freshness-cli: ${error}`);
    }
    throw new Error(
      `check-deploy-freshness-cli: ${errors.length} error(s) across ${callsiteCount} callsite(s).`,
    );
  }
  console.log(`check-deploy-freshness-cli: OK (${callsiteCount} callsites).`);
}

const invokedFromCli = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (invokedFromCli) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${message}`);
    process.exit(1);
  });
}
