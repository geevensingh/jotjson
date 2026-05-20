// Unit tests for scripts/check-deploy-freshness-cli.mjs.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkFreshnessCli } from './check-deploy-freshness-cli.mjs';

function silentLogger() {
  return { log() {} };
}

function withTempWorkflow(content, callback) {
  const dir = mkdtempSync(join(tmpdir(), 'cdf-cli-'));
  const file = join(dir, 'workflow.yml');
  writeFileSync(file, content);
  try {
    return callback(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const STRICT_WORKFLOW = `
name: cd
on: { workflow_run: { workflows: [ci], types: [completed] } }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Check deploy freshness
        run: npm run check:deploy-freshness -- --origin=https://example.com --expected-sha=\${{ github.event.workflow_run.head_sha || github.sha }}
`;

test('checkFreshnessCli accepts allowlisted SHA expression', () => {
  withTempWorkflow(STRICT_WORKFLOW, (file) => {
    const result = checkFreshnessCli({
      workflowFiles: [file],
      logger: silentLogger(),
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.callsiteCount, 1);
  });
});

test('checkFreshnessCli rejects unknown SHA expression (catches vars.* misuse)', () => {
  const workflow = `
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Check deploy freshness
        run: npm run check:deploy-freshness -- --origin=https://example.com --expected-sha=\${{ vars.MISSING }}
`;
  withTempWorkflow(workflow, (file) => {
    const result = checkFreshnessCli({
      workflowFiles: [file],
      logger: silentLogger(),
    });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /not on the allowlist/);
    assert.match(result.errors[0], /vars\.\*.*resolve to empty/);
  });
});

test('checkFreshnessCli rejects missing --expected-sha without --allow-byte-match-only', () => {
  const workflow = `
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Check deploy freshness
        run: npm run check:deploy-freshness -- --origin=https://example.com
`;
  withTempWorkflow(workflow, (file) => {
    const result = checkFreshnessCli({
      workflowFiles: [file],
      logger: silentLogger(),
    });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /missing --expected-sha/);
  });
});

test('checkFreshnessCli rejects --allow-byte-match-only in CI callsites', () => {
  const workflow = `
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Check deploy freshness
        run: npm run check:deploy-freshness -- --origin=https://example.com --allow-byte-match-only
`;
  withTempWorkflow(workflow, (file) => {
    const result = checkFreshnessCli({
      workflowFiles: [file],
      logger: silentLogger(),
    });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /reserved for local-dev probes/);
  });
});

test('checkFreshnessCli surfaces parseCliOptions errors with callsite context', () => {
  const workflow = `
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Check deploy freshness
        run: npm run check:deploy-freshness -- --bogus-flag --origin=https://example.com --expected-sha=\${{ github.sha }}
`;
  withTempWorkflow(workflow, (file) => {
    const result = checkFreshnessCli({
      workflowFiles: [file],
      logger: silentLogger(),
    });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Unknown argument '--bogus-flag'/);
    assert.match(result.errors[0], /step "Check deploy freshness"/);
  });
});

test('checkFreshnessCli reports zero callsites as an error (lint coverage drift)', () => {
  const workflow = `
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Something unrelated
        run: echo "no freshness call here"
`;
  withTempWorkflow(workflow, (file) => {
    const result = checkFreshnessCli({
      workflowFiles: [file],
      logger: silentLogger(),
    });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /found 0 callsites/);
  });
});

test('checkFreshnessCli handles `${{ github.event.workflow_run.head_sha || github.sha }}` token', () => {
  // Regression test for the regex-tokenizer bug: `||` inside `${{ ... }}`
  // must NOT split the argv. If the regex terminates on `|`, the
  // captured argv truncates to `--expected-sha=${{ github.event.workflow_run.head_sha`
  // which then fails the allowlist check.
  withTempWorkflow(STRICT_WORKFLOW, (file) => {
    const result = checkFreshnessCli({
      workflowFiles: [file],
      logger: silentLogger(),
    });
    assert.deepEqual(result.errors, []);
  });
});

test('checkFreshnessCli passes against the live repo workflow files', () => {
  // This is the lint we actually want to run in CI -- replays the real
  // .github/workflows/{cd,cd-nonprod}.yml. If these workflows ever
  // regress to passing args the CLI rejects, this test fails loud.
  const result = checkFreshnessCli({ logger: silentLogger() });
  assert.deepEqual(
    result.errors,
    [],
    `repo workflow callsites should pass freshness CLI lint:\n${result.errors.join('\n')}`,
  );
  assert.ok(result.callsiteCount >= 2, 'expected at least cd.yml + cd-nonprod.yml callsites');
});
