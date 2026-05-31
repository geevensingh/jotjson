// Static-asset middleware factory used by vitest.config.mts to mount
// real filesystem directories under URL prefixes during browser-mode
// tests. Extracted from vitest.config.mts so the path-traversal guard
// can be unit-tested via `node --test` (see scripts/static-mount.test.mjs).
//
// Used by:
//   - vitest.config.mts staticMount('/fixtures', 'src/testing/fixtures')
//   - vitest.config.mts staticMount('/vs', 'node_modules/monaco-editor/min/vs')
//
// Plain .mjs (not .mts) so the existing `node --test "scripts/**/*.test.mjs"`
// glob picks up the test file without runner reconfiguration.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

/**
 * Returns true iff `candidate` is `root` itself or a path strictly
 * contained inside `root`. Uses path-separator-aware prefix comparison
 * (not raw `startsWith`) so a sibling directory whose name shares a
 * string prefix with `root` (e.g. `/repo/dist` vs `/repo/dist-backup`)
 * is correctly rejected.
 *
 * Both arguments are expected to be absolute, already-normalized paths.
 *
 * @param {string} candidate - path to check
 * @param {string} root - absolute root directory
 * @returns {boolean}
 */
export function isPathInsideRoot(candidate, root) {
  return candidate === root || candidate.startsWith(root + sep);
}

const MIME_BY_EXT = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
};

/**
 * Vite plugin that mounts `sourceDir` as a static fileserver at
 * `urlPrefix` on the dev/test server. Requests outside the source root
 * (via `..` traversal, sibling-prefix attack, etc.) get 403; requests
 * for missing files fall through to `next()` so other middleware can
 * handle them.
 *
 * @param {string} urlPrefix - URL path prefix, e.g. '/fixtures'
 * @param {string} sourceDir - filesystem path (relative paths are
 *   resolved against process.cwd())
 * @returns {import('vite').Plugin}
 */
export function staticMount(urlPrefix, sourceDir) {
  const absoluteSource = resolve(sourceDir);
  return {
    name: `static-mount-${urlPrefix.replace(/[^a-z0-9]/gi, '-')}`,
    configureServer(server) {
      server.middlewares.use(urlPrefix, (req, res, next) => {
        const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
        const filePath = join(absoluteSource, rawPath);
        if (!isPathInsideRoot(filePath, absoluteSource)) {
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }
        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          next();
          return;
        }
        const ext = extname(filePath).toLowerCase();
        const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
        res.setHeader('Content-Type', mime);
        createReadStream(filePath).pipe(res);
      });
    },
  };
}
