import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertShape, buildSwSource } from './build-sw.mjs';

const MINIMAL_SOURCE = `
/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;
const SENTINEL_DB_NAME = 'jotjson-sw-migration';
const SENTINEL_KEY = 'legacyCacheWiped';
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.clients.claim();
    // refs sentinel: \${SENTINEL_DB_NAME}/\${SENTINEL_KEY}
  })());
});
self.addEventListener('fetch', () => {});
`;

test('buildSwSource emit contains required SW tokens', () => {
  const emit = buildSwSource(MINIMAL_SOURCE);
  assert.match(emit, /skipWaiting/);
  assert.match(emit, /caches\.delete/);
  assert.match(emit, /clients\.claim/);
  assert.match(emit, /jotjson-sw-migration/);
  assert.match(emit, /legacyCacheWiped/);
});

test('buildSwSource strips TS-only syntax', () => {
  const emit = buildSwSource(MINIMAL_SOURCE);
  // The TS-only `declare` keyword must not appear in the emit.
  assert.doesNotMatch(emit, /^declare /m);
});

test('assertShape passes when all substrings present', () => {
  const goodEmit = [
    'skipWaiting()',
    'caches.delete(k)',
    'clients.claim()',
    "indexedDB.open('jotjson-sw-migration', 1)",
    "store.get('legacyCacheWiped')",
  ].join('\n');
  // Should NOT throw / exit.
  assertShape(goodEmit);
});

test('assertShape calls fail() when a substring is missing', () => {
  const badEmit = ['skipWaiting()', 'caches.delete(k)', 'clients.claim()'].join('\n');
  const originalExit = process.exit;
  const originalWrite = process.stderr.write;
  let exitCalled = false;
  let stderrCapture = '';
  process.exit = (code) => {
    exitCalled = true;
    throw new Error(`exit-${code}`);
  };
  process.stderr.write = (chunk) => {
    stderrCapture += String(chunk);
    return true;
  };
  try {
    assert.throws(() => assertShape(badEmit), /exit-1/);
    assert.equal(exitCalled, true);
    assert.match(stderrCapture, /missing required substring/);
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalWrite;
  }
});
