// Tests for scripts/static-mount.mjs. Run via `npm run test:scripts`
// which invokes `node --test "scripts/**/*.test.mjs"`.
//
// The key invariant under test is that `isPathInsideRoot` rejects
// sibling-prefix attacks (e.g. `/repo/dist` should NOT accept
// `/repo/dist-backup/x`). The previous implementation used raw
// `startsWith(root)` which incorrectly accepted such siblings,
// because path traversal via `..` could escape into a same-parent
// directory whose name began with the root's basename.

import assert from 'node:assert/strict';
import { sep } from 'node:path';
import { describe, test } from 'node:test';

import { isPathInsideRoot, staticMount } from './static-mount.mjs';

describe('isPathInsideRoot', () => {
  const root = process.platform === 'win32' ? 'C:\\repo\\dist' : '/repo/dist';

  test('accepts the root itself', () => {
    assert.equal(isPathInsideRoot(root, root), true);
  });

  test('accepts a direct child file', () => {
    assert.equal(isPathInsideRoot(root + sep + 'index.html', root), true);
  });

  test('accepts a deeply nested file', () => {
    assert.equal(isPathInsideRoot(root + sep + 'a' + sep + 'b' + sep + 'c.js', root), true);
  });

  test('rejects an unrelated parent path', () => {
    const elsewhere = process.platform === 'win32' ? 'C:\\etc\\hosts' : '/etc/hosts';
    assert.equal(isPathInsideRoot(elsewhere, root), false);
  });

  test('rejects a sibling directory whose name shares a prefix (suffix-string)', () => {
    // This is the regression case: '/repo/dist-backup/x' previously
    // passed `startsWith('/repo/dist')` because dist-backup begins
    // with the literal string "dist".
    const sibling =
      process.platform === 'win32' ? 'C:\\repo\\dist-backup\\secret' : '/repo/dist-backup/secret';
    assert.equal(isPathInsideRoot(sibling, root), false);
  });

  test('rejects a sibling file whose name shares a prefix (dot-suffix)', () => {
    // Matches the real-repo case: src/testing/fixtures.test.ts is a
    // sibling of src/testing/fixtures/, and the old guard would have
    // served it through `GET /fixtures/../fixtures.test.ts`.
    const sibling = process.platform === 'win32' ? 'C:\\repo\\dist.bak' : '/repo/dist.bak';
    assert.equal(isPathInsideRoot(sibling, root), false);
  });

  test('rejects a path that is a prefix of root but shorter', () => {
    const parent = process.platform === 'win32' ? 'C:\\repo' : '/repo';
    assert.equal(isPathInsideRoot(parent, root), false);
  });
});

describe('staticMount', () => {
  test('returns a Vite plugin object with the expected shape', () => {
    const plugin = staticMount('/fixtures', 'src/testing/fixtures');
    assert.equal(typeof plugin, 'object');
    assert.equal(plugin.name, 'static-mount--fixtures');
    assert.equal(typeof plugin.configureServer, 'function');
  });

  test('plugin name sanitizes non-alphanumeric URL prefix characters', () => {
    const plugin = staticMount('/vs/edit', 'node_modules/x');
    assert.equal(plugin.name, 'static-mount--vs-edit');
  });

  // Exercising the middleware end-to-end (build req/res, hit 403,
  // verify content-type) is the next layer of coverage. We rely on
  // the pure `isPathInsideRoot` tests above for the guard invariant
  // and on CI green for the happy-path file-serving behavior (the
  // suite would not boot at all if the middleware misrouted).
  test('rejects a traversal request via the guard (smoke check)', () => {
    const plugin = staticMount('/fixtures', 'src/testing/fixtures');
    let status = 0;
    let body = '';
    let nextCalled = false;
    const req = { url: '/../fixtures.test.ts' };
    const res = {
      statusCode: 0,
      end: (s) => {
        status = res.statusCode;
        body = s;
      },
      setHeader: () => {},
    };
    let registered;
    const server = {
      middlewares: {
        use: (_prefix, handler) => {
          registered = handler;
        },
      },
    };
    plugin.configureServer?.(server);
    assert.ok(registered, 'middleware should be registered');
    registered(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false, 'guard must reject, not fall through');
    assert.equal(status, 403);
    assert.equal(body, 'Forbidden');
  });
});
