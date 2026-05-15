// Determinism check for the shared fixture generator.
// Runs as part of `npm run test:scripts`. Verifies SHA-256 of the
// JSON output at 10K and 100K wide-aoo sizes; cross-machine
// determinism is required for cross-machine baseline comparison.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const DIST = join(REPO_ROOT, 'dist-perf', 'perf', 'fixtures', 'generate.js');

function ensureBuilt() {
  if (existsSync(DIST)) return;
  const isWin = process.platform === 'win32';
  const result = isWin
    ? spawnSync('npm.cmd run perf:build', { cwd: REPO_ROOT, stdio: 'inherit', shell: true })
    : spawnSync('npm', ['run', 'perf:build'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error('perf:build failed; cannot run determinism test');
  }
}

const GOLDEN = [
  {
    shape: 'wide-aoo',
    approxNodes: 10_000,
    bytes: null,
    hash: '806c12248ee3aee7f8f3f0c898779c8f87b7fdc1500e04b828f9bc752e43c6f8',
  },
  {
    shape: 'wide-aoo',
    approxNodes: 100_000,
    bytes: null,
    hash: '9d25372d6271e3af9a8d66855b5315a8a8e100cc9b8e382589fcd85b1c663465',
  },
  {
    // The mixed-d10 catalog row at 380k is the NFR-anchor fixture
    // (DESIGN_SPEC.md NFR #1, issue #215). We pin both the SHA-256
    // and the exact UTF-8 byte count: the hash catches generator
    // drift, and the byte count catches accidental shape changes
    // that re-balance the dice rolls into a same-hash-impossible-
    // but-different-size output. Empirically tuned to land near
    // 5 MB (advocate HIGH-1 fix: pin the deterministic byte count
    // instead of a wide envelope).
    shape: 'mixed-d10',
    approxNodes: 380_000,
    bytes: 5_178_027,
    hash: '9042e4b3e451ad38a5b2848f2e3fcbbe0ce102070ad701263a9374fc0f9f065f',
  },
];

test('generator produces deterministic output for catalog sizes', async () => {
  ensureBuilt();
  const { generate } = await import(pathToFileURL(DIST).href);
  for (const golden of GOLDEN) {
    const json = generate({ shape: golden.shape, approxNodes: golden.approxNodes });
    const actual = createHash('sha256').update(json).digest('hex');
    assert.equal(
      actual,
      golden.hash,
      `Generator drift at ${golden.shape} x ${golden.approxNodes}: expected ${golden.hash}, got ${actual}`,
    );
    if (golden.bytes !== null) {
      const actualBytes = Buffer.byteLength(json, 'utf8');
      assert.equal(
        actualBytes,
        golden.bytes,
        `Generator byte drift at ${golden.shape} x ${golden.approxNodes}: expected ${golden.bytes}, got ${actualBytes}`,
      );
    }
  }
});
