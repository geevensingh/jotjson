import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parsePerfRowKey, perfRowKey } from './row-key.mjs';

test('perfRowKey composes the canonical dotted form with numeric layer', () => {
  assert.equal(
    perfRowKey({ layer: 1, scenario: 'parse', fixture: 'wide-aoo', size: '10k' }),
    '1.parse.wide-aoo.10k',
  );
});

test('perfRowKey also accepts string layer', () => {
  assert.equal(
    perfRowKey({ layer: '3', scenario: 'paste-large', fixture: 'wide-aoo', size: '1m' }),
    '3.paste-large.wide-aoo.1m',
  );
});

test('perfRowKey rejects empty / zero / negative layer', () => {
  assert.throws(
    () => perfRowKey({ layer: 0, scenario: 'parse', fixture: 'wide-aoo', size: '10k' }),
    /layer must be a positive number/,
  );
  assert.throws(
    () => perfRowKey({ layer: '', scenario: 'parse', fixture: 'wide-aoo', size: '10k' }),
    /layer must be a positive number/,
  );
});

test('perfRowKey rejects empty scenario / fixture / size', () => {
  assert.throws(
    () => perfRowKey({ layer: 1, scenario: '', fixture: 'wide-aoo', size: '10k' }),
    /scenario must be a non-empty string/,
  );
});

test('perfRowKey rejects parts containing a dot', () => {
  assert.throws(
    () => perfRowKey({ layer: 1, scenario: 'parse.tree', fixture: 'wide-aoo', size: '10k' }),
    /scenario must not contain '\.'/,
  );
});

test('parsePerfRowKey returns numeric layer when all-digits', () => {
  const parts = parsePerfRowKey('2.l2-bench.deep25.1k');
  assert.equal(parts.layer, 2);
  assert.equal(parts.scenario, 'l2-bench');
  assert.equal(parts.fixture, 'deep25');
  assert.equal(parts.size, '1k');
});

test('parsePerfRowKey rejects malformed keys', () => {
  assert.throws(() => parsePerfRowKey('1.parse'), /4 dot-separated parts/);
  assert.throws(() => parsePerfRowKey('1.parse.wide-aoo.10k.extra'), /4 dot-separated parts/);
});
