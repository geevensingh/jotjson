import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertBaselineSchema,
  BASELINE_SCHEMA_VERSION,
  findLatestResultsDir,
  parseJsonl,
  readRunRows,
  rowsToBaselineEntries,
  snapshotBaseline,
} from './baseline.mjs';

function makeRow(overrides) {
  return {
    layer: 1,
    scenario: 'parse',
    fixture: 'deep25',
    size: '10k',
    wallNsMedian: 1_000_000,
    wallNsIqrLow: 950_000,
    wallNsIqrHigh: 1_050_000,
    codeSha: 'abc1234',
    ...overrides,
  };
}

test('parseJsonl ignores blank lines and parses each as JSON', () => {
  const text = '{"layer":1}\n\n{"layer":2}\n';
  const rows = parseJsonl(text);
  assert.deepEqual(rows, [{ layer: 1 }, { layer: 2 }]);
});

test('rowsToBaselineEntries collapses by composite key', () => {
  const rows = [
    makeRow({ scenario: 'parse', size: '10k', wallNsMedian: 1 }),
    makeRow({ scenario: 'parse', size: '100k', wallNsMedian: 2 }),
  ];
  const entries = rowsToBaselineEntries(rows);
  assert.equal(entries['1.parse.deep25.10k'].wallNsMedian, 1);
  assert.equal(entries['1.parse.deep25.100k'].wallNsMedian, 2);
});

test('findLatestResultsDir returns the last sorted directory', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'baseline-test-'));
  try {
    mkdirSync(join(tmp, '2024-01-01T00-00-00-000Z'));
    mkdirSync(join(tmp, '2025-06-15T12-00-00-000Z'));
    mkdirSync(join(tmp, '2024-06-15T12-00-00-000Z'));
    const latest = findLatestResultsDir(tmp);
    assert.equal(latest, join(tmp, '2025-06-15T12-00-00-000Z'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('findLatestResultsDir throws if dir is missing', () => {
  assert.throws(
    () => findLatestResultsDir(join(tmpdir(), 'definitely-not-here-' + Date.now())),
    /does not exist/,
  );
});

test('findLatestResultsDir throws if dir is empty', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'baseline-empty-'));
  try {
    assert.throws(() => findLatestResultsDir(tmp), /no run directories/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readRunRows reads all layer-*.jsonl files in a run dir', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'baseline-run-'));
  try {
    writeFileSync(join(tmp, 'layer-1.jsonl'), JSON.stringify(makeRow({ layer: 1 })) + '\n');
    writeFileSync(join(tmp, 'layer-2.jsonl'), JSON.stringify(makeRow({ layer: 2 })) + '\n');
    writeFileSync(join(tmp, 'unrelated.json'), '{"ignored":true}');
    const rows = readRunRows(tmp);
    assert.equal(rows.length, 2);
    const layers = rows.map((row) => row.layer).sort();
    assert.deepEqual(layers, [1, 2]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('snapshotBaseline writes a baseline file from latest results', () => {
  const tmpResults = mkdtempSync(join(tmpdir(), 'baseline-results-'));
  const tmpBaselines = mkdtempSync(join(tmpdir(), 'baseline-out-'));
  try {
    const runDir = join(tmpResults, '2025-01-01T00-00-00-000Z');
    mkdirSync(runDir);
    writeFileSync(
      join(runDir, 'layer-1.jsonl'),
      JSON.stringify(makeRow({ codeSha: 'deadbee' })) + '\n',
    );
    const { baselinePath, rowCount } = snapshotBaseline({
      machineLabel: 'win32-x64-abc123',
      resultsDir: tmpResults,
      baselinesDir: tmpBaselines,
    });
    assert.equal(rowCount, 1);
    assert.ok(baselinePath.endsWith('win32-x64-abc123.json'));
    const written = JSON.parse(readFileSync(baselinePath, 'utf8'));
    assert.equal(written.schemaVersion, 2);
    assert.equal(written.machineLabel, 'win32-x64-abc123');
    assert.equal(written.codeShaAtBaseline, 'deadbee');
    assert.ok(written.rows['1.parse.deep25.10k']);
  } finally {
    rmSync(tmpResults, { recursive: true, force: true });
    rmSync(tmpBaselines, { recursive: true, force: true });
  }
});

test('snapshotBaseline rejects empty machineLabel', () => {
  assert.throws(
    () => snapshotBaseline({ machineLabel: '' }),
    /snapshotBaseline requires a machineLabel/,
  );
});

test('rowsToBaselineEntries preserves pasteMethod when present', () => {
  const rows = [
    makeRow({
      layer: 3,
      scenario: 'paste-large',
      fixture: 'wide-aoo',
      size: '10k',
      pasteMethod: 'keyboard',
    }),
    makeRow({
      layer: 3,
      scenario: 'paste-large',
      fixture: 'wide-aoo',
      size: '1m',
      pasteMethod: 'setvalue',
    }),
    // sentinel: L1 rows have no pasteMethod -- field stays absent.
    makeRow({ layer: 1, scenario: 'parse', fixture: 'deep25', size: '10k' }),
  ];
  const entries = rowsToBaselineEntries(rows);
  assert.equal(entries['3.paste-large.wide-aoo.10k'].pasteMethod, 'keyboard');
  assert.equal(entries['3.paste-large.wide-aoo.1m'].pasteMethod, 'setvalue');
  assert.equal(entries['1.parse.deep25.10k'].pasteMethod, undefined);
});

test('rowsToBaselineEntries drops unknown pasteMethod values silently', () => {
  // Defensive: an unknown value should NOT be copied through.
  const rows = [
    makeRow({
      layer: 3,
      scenario: 'paste-large',
      fixture: 'wide-aoo',
      size: '10k',
      pasteMethod: 'bogus',
    }),
  ];
  const entries = rowsToBaselineEntries(rows);
  assert.equal(entries['3.paste-large.wide-aoo.10k'].pasteMethod, undefined);
});

test('BASELINE_SCHEMA_VERSION is 2 after C5 (pasteMethod field added)', () => {
  assert.equal(BASELINE_SCHEMA_VERSION, 2);
});

test('assertBaselineSchema rejects schemaVersion=1 (current v2 reader rejects older shapes)', () => {
  const v1File = {
    schemaVersion: 1,
    machineLabel: 'win32-x64-test',
    lastUpdatedUtc: '2026-05-12T00:00:00.000Z',
    codeShaAtBaseline: 'abc',
    rows: {},
  };
  assert.throws(
    () => assertBaselineSchema(v1File, '/fake/path.json'),
    /schemaVersion=1.*expected 2/,
  );
});

test('assertBaselineSchema accepts a v2 file with valid pasteMethod', () => {
  const v2File = {
    schemaVersion: 2,
    machineLabel: 'win32-x64-test',
    lastUpdatedUtc: '2026-05-12T00:00:00.000Z',
    codeShaAtBaseline: 'abc',
    rows: {
      '3.paste-large.wide-aoo.10k': {
        wallNsMedian: 1,
        wallNsIqrLow: 0,
        wallNsIqrHigh: 2,
        iters: 7,
        approxNodes: 10000,
        pasteMethod: 'keyboard',
      },
    },
  };
  const result = assertBaselineSchema(v2File, '/fake/path.json');
  assert.equal(result.schemaVersion, 2);
});

test('assertBaselineSchema rejects unknown pasteMethod values', () => {
  const badFile = {
    schemaVersion: 2,
    machineLabel: 'win32-x64-test',
    lastUpdatedUtc: '2026-05-12T00:00:00.000Z',
    codeShaAtBaseline: 'abc',
    rows: {
      '3.paste-large.wide-aoo.10k': {
        wallNsMedian: 1,
        wallNsIqrLow: 0,
        wallNsIqrHigh: 2,
        iters: 7,
        approxNodes: 10000,
        pasteMethod: 'not-a-real-method',
      },
    },
  };
  assert.throws(
    () => assertBaselineSchema(badFile, '/fake/path.json'),
    /invalid pasteMethod=.*"not-a-real-method"/,
  );
});

test('round-trip: snapshotBaseline -> parse -> assertBaselineSchema preserves pasteMethod', () => {
  const tmpResults = mkdtempSync(join(tmpdir(), 'baseline-roundtrip-'));
  const tmpBaselines = mkdtempSync(join(tmpdir(), 'baseline-roundtrip-out-'));
  try {
    const runDir = join(tmpResults, '2026-05-12T00-00-00-000Z');
    mkdirSync(runDir);
    writeFileSync(
      join(runDir, 'layer-3.jsonl'),
      [
        JSON.stringify(
          makeRow({
            layer: 3,
            scenario: 'paste-large',
            fixture: 'wide-aoo',
            size: '10k',
            pasteMethod: 'keyboard',
          }),
        ),
        JSON.stringify(
          makeRow({
            layer: 3,
            scenario: 'paste-large',
            fixture: 'wide-aoo',
            size: '1m',
            pasteMethod: 'setvalue',
          }),
        ),
      ].join('\n') + '\n',
    );
    const { baselinePath } = snapshotBaseline({
      machineLabel: 'win32-x64-test',
      resultsDir: tmpResults,
      baselinesDir: tmpBaselines,
    });
    const written = JSON.parse(readFileSync(baselinePath, 'utf8'));
    const validated = assertBaselineSchema(written, baselinePath);
    assert.equal(validated.schemaVersion, 2);
    assert.equal(validated.rows['3.paste-large.wide-aoo.10k'].pasteMethod, 'keyboard');
    assert.equal(validated.rows['3.paste-large.wide-aoo.1m'].pasteMethod, 'setvalue');
  } finally {
    rmSync(tmpResults, { recursive: true, force: true });
    rmSync(tmpBaselines, { recursive: true, force: true });
  }
});
