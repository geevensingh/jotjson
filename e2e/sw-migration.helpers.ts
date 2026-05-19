import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { BrowserContext } from '@playwright/test';

/**
 * Path to the post-migration SW bytes emitted by `scripts/build-sw.mjs`.
 * Both `/sw.js` and `/ngsw-worker.js` are byte-identical in the dist.
 */
export const NEW_SW_PATH = resolve(process.cwd(), 'dist/jotjson/browser/sw.js');

/**
 * Mid-test, intercept fetches for `/sw.js` and `/ngsw-worker.js` in the
 * given browser context and return the post-migration bytes. This is the
 * mechanism by which a stuck OLD ngsw's 24h byte-revalidation delivers
 * the new minimal SW to the cohort.
 *
 * In production the swap is implicit (the new bytes are deployed at the
 * existing URL); in e2e we simulate it explicitly with `ctx.route`.
 */
export async function swapServedBytesForMigration(
  ctx: BrowserContext,
  newSwPath: string = NEW_SW_PATH,
): Promise<void> {
  const newBytes = readFileSync(newSwPath, 'utf8');
  await ctx.route('**/sw.js', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      headers: { 'Cache-Control': 'no-store' },
      body: newBytes,
    }),
  );
  await ctx.route('**/ngsw-worker.js', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      headers: { 'Cache-Control': 'no-store' },
      body: newBytes,
    }),
  );
}
