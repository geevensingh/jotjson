// Layer-3 scenario: expand-all.
//
// Pastes a 1M-node fixture, then triggers the "Expand all" interaction
// that the user explores after a paste. Measures wall-clock from
// expand-click to next-paint-after-tree-stabilizes.
//
// Output: rows via `@@PERF_L3@@<json>@@END@@`; CDP profile/trace per scenario.

import { test } from '@playwright/test';
import { join } from 'node:path';
import { FIXTURE_CATALOG } from '../../fixtures/catalog';
import { generate } from '../../fixtures/generate';
import { assertExpandedTree } from '../util/assert-expanded-tree';
import { CdpProfiler } from '../util/cdp-profile';
import {
  HEAP_SAMPLE_SCRIPT,
  LONGTASK_OBSERVER_SCRIPT,
  LONGTASK_OBSERVER_STOP_SCRIPT,
  summarize,
  type IterMetrics,
  type MeasureOpts,
} from '../util/measure';
import { perfHarnessInitScript } from '../util/perf-harness';

const TIMED_ITERS = 7;
const WARMUP_ITERS = 1;

const FIXTURES = FIXTURE_CATALOG.filter((fixture) => fixture.approxNodes === 1_000_000);

const RESULTS_ROOT =
  process.env['PERF_RESULTS_DIR'] ?? join(process.cwd(), 'perf-results', 'l3-tmp');
const TRACES_DIR = join(RESULTS_ROOT, 'traces');

function emitRow(row: object): void {
  // eslint-disable-next-line no-console
  console.log(`@@PERF_L3@@${JSON.stringify(row)}@@END@@`);
}

for (const fixture of FIXTURES) {
  test(`expand-all: ${fixture.shape} @ ${fixture.size}`, async ({ page }) => {
    test.setTimeout(10 * 60 * 1000);
    const json = generate({ shape: fixture.shape, approxNodes: fixture.approxNodes });
    const bytes = Buffer.byteLength(json, 'utf8');
    await page.addInitScript({ content: perfHarnessInitScript() });

    const iters: IterMetrics[] = [];
    for (let i = 0; i < WARMUP_ITERS + TIMED_ITERS; i++) {
      const isTimed = i >= WARMUP_ITERS;
      await page.goto('/', { waitUntil: 'load' });
      await page.getByRole('textbox', { name: 'JSON editor' }).waitFor({ state: 'visible' });

      // Set the editor value programmatically.
      await page.evaluate(async (text: string) => {
        const monacoApi = (
          window as unknown as {
            monaco?: { editor?: { getEditors?: () => { setValue: (text: string) => void }[] } };
          }
        ).monaco;
        const editors = monacoApi?.editor?.getEditors?.();
        if (editors && editors[0]) editors[0].setValue(text);
      }, json);

      // Wait for tree to populate with at least one rendered row.
      // (Container visibility alone isn't enough -- mat-tree may need
      // an animation frame after setValue before any treeitem mounts.)
      await page
        .locator('section[aria-label="Tree view"] [role="treeitem"]')
        .first()
        .waitFor({ state: 'visible', timeout: 5 * 60 * 1000 });

      const profiler = new CdpProfiler();
      await profiler.attach(page);
      await page.evaluate(LONGTASK_OBSERVER_SCRIPT);
      const heapBefore: number | null = await page.evaluate(HEAP_SAMPLE_SCRIPT);
      await profiler.collectGarbage();

      const captureFlame = !isTimed && i === 0;
      if (captureFlame) {
        await profiler.startProfiler();
        await profiler.startTracing();
      }
      const expandAll = page.getByRole('button', { name: /expand all/i }).first();
      const t0 = Date.now();
      if (await expandAll.isVisible().catch(() => false)) {
        await expandAll.click();
      } else {
        // Fall back: dispatch a keyboard shortcut if the toolbar
        // button has been moved (don't fail the bench on a UI tweak).
        await page.keyboard.press('Control+Shift+E');
      }
      // Wait one frame for the layout pass to commit.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const wallMs = Date.now() - t0;
      await assertExpandedTree(page, { minVisibleTreeItems: 50, minExpandedNodes: 2 });

      const longestTaskMs: number | null = await page.evaluate(LONGTASK_OBSERVER_STOP_SCRIPT);
      const heapAfter: number | null = await page.evaluate(HEAP_SAMPLE_SCRIPT);
      const heapDelta = heapBefore !== null && heapAfter !== null ? heapAfter - heapBefore : null;

      if (captureFlame) {
        const tag = `expand-all-${fixture.shape}-${fixture.size}-warmup`;
        await profiler.stopProfilerToFile(join(TRACES_DIR, `${tag}.cpuprofile`));
        await profiler.stopTracingToFile(join(TRACES_DIR, `${tag}.trace.json`));
      }
      await profiler.detach();

      if (isTimed) iters.push({ wallMs, longestTaskMs, usedJsHeapBytesDelta: heapDelta });
    }

    const opts: MeasureOpts = {
      scenario: 'expand-all',
      fixture: fixture.shape,
      size: fixture.size,
      approxNodes: fixture.approxNodes,
      bytes,
      warmup: WARMUP_ITERS,
      iters: TIMED_ITERS,
    };
    emitRow(summarize(opts, iters, []));
  });
}
