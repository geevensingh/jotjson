// Layer-3 scenario: scroll-after-expand.
//
// Pastes 1M-node fixture, expands to all, then dispatches 50 wheel
// events at ~60Hz over the tree pane. Measures the wall-clock from
// the first wheel dispatch to the last frame committed after the
// final wheel event.
//
// This is the "rehearsal" of the user-pain flow: long lists are slow
// to scroll because mat-tree is NOT virtualized. CDP profile + trace
// captured per scenario.

import { test } from '@playwright/test';
import { join } from 'node:path';
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

interface Fixture {
  shape: 'deep25' | 'wide-aoo';
  approxNodes: number;
  label: string;
}

const TIMED_ITERS = 7;
const WARMUP_ITERS = 1;
const WHEEL_EVENTS = 50;
const WHEEL_INTERVAL_MS = 16; // ~60Hz

const FIXTURES: Fixture[] = [
  { shape: 'deep25', approxNodes: 1_000_000, label: '1M' },
  { shape: 'wide-aoo', approxNodes: 1_000_000, label: '1M' },
];

const RESULTS_ROOT =
  process.env['PERF_RESULTS_DIR'] ?? join(process.cwd(), 'perf-results', 'l3-tmp');
const TRACES_DIR = join(RESULTS_ROOT, 'traces');

function emitRow(row: object): void {
  // eslint-disable-next-line no-console
  console.log(`@@PERF_L3@@${JSON.stringify(row)}@@END@@`);
}

function generateJson(fixture: Fixture): string {
  let seed = 0xc0ffee >>> 0;
  const rng = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  if (fixture.shape === 'wide-aoo') {
    const itemCount = Math.max(0, Math.floor((fixture.approxNodes - 1) / 11));
    const parts: string[] = [];
    for (let i = 0; i < itemCount; i++) {
      const item: Record<string, number> = {};
      for (let k = 0; k < 10; k++) item[`k${k}`] = Math.floor(rng() * 1e9);
      parts.push(JSON.stringify(item));
    }
    return `[${parts.join(',')}]`;
  }
  const DEPTH = 25;
  const leafCount = Math.max(0, fixture.approxNodes - DEPTH);
  const leaves: number[] = [];
  for (let i = 0; i < leafCount; i++) leaves.push(Math.floor(rng() * 1e9));
  let inner: unknown = leaves;
  for (let d = DEPTH - 1; d >= 0; d--) inner = { [`level_${d}`]: inner };
  return JSON.stringify(inner);
}

for (const fixture of FIXTURES) {
  test(`scroll-after-expand: ${fixture.shape} @ ${fixture.label}`, async ({ page }) => {
    test.setTimeout(10 * 60 * 1000);
    const json = generateJson(fixture);
    const bytes = json.length;
    await page.addInitScript({ content: perfHarnessInitScript() });

    const iters: IterMetrics[] = [];
    for (let i = 0; i < WARMUP_ITERS + TIMED_ITERS; i++) {
      const isTimed = i >= WARMUP_ITERS;
      await page.goto('/', { waitUntil: 'load' });
      await page.getByRole('textbox', { name: 'JSON editor' }).waitFor({ state: 'visible' });

      await page.evaluate(async (text: string) => {
        const monacoApi = (
          window as unknown as {
            monaco?: { editor?: { getEditors?: () => { setValue: (text: string) => void }[] } };
          }
        ).monaco;
        const editors = monacoApi?.editor?.getEditors?.();
        if (editors && editors[0]) editors[0].setValue(text);
      }, json);

      const treePane = page.locator('section[aria-label="Tree view"]');
      await treePane
        .locator('[role="treeitem"]')
        .first()
        .waitFor({ state: 'visible', timeout: 5 * 60 * 1000 });

      // Try to expand all if a button exists; ignore if not.
      const expandAll = page.getByRole('button', { name: /expand all/i }).first();
      if (await expandAll.isVisible().catch(() => false)) {
        await expandAll.click();
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        );
      }
      await assertExpandedTree(page, { minVisibleTreeItems: 50, minExpandedNodes: 2 });

      const profiler = new CdpProfiler();
      await profiler.attach(page);
      await page.evaluate(LONGTASK_OBSERVER_SCRIPT);
      const heapBefore: number | null = await page.evaluate(HEAP_SAMPLE_SCRIPT);
      await profiler.collectGarbage();

      const captureFlame = isTimed && i - WARMUP_ITERS === 0;
      if (captureFlame) {
        await profiler.startProfiler();
        await profiler.startTracing();
      }

      // Get the bounding box of the tree pane and dispatch wheel events
      // through Playwright's mouse API.
      const box = await treePane.boundingBox();
      const cx = box ? box.x + box.width / 2 : 200;
      const cy = box ? box.y + box.height / 2 : 200;
      await page.mouse.move(cx, cy);

      const t0 = Date.now();
      for (let w = 0; w < WHEEL_EVENTS; w++) {
        await page.mouse.wheel(0, 100);
        await page.waitForTimeout(WHEEL_INTERVAL_MS);
      }
      // One double-rAF after the last wheel for paint commit.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const wallMs = Date.now() - t0;

      const longestTaskMs: number | null = await page.evaluate(LONGTASK_OBSERVER_STOP_SCRIPT);
      const heapAfter: number | null = await page.evaluate(HEAP_SAMPLE_SCRIPT);
      const heapDelta = heapBefore !== null && heapAfter !== null ? heapAfter - heapBefore : null;

      if (captureFlame) {
        const tag = `scroll-after-expand-${fixture.shape}-${fixture.label}-iter${i - WARMUP_ITERS}`;
        await profiler.stopProfilerToFile(join(TRACES_DIR, `${tag}.cpuprofile`));
        await profiler.stopTracingToFile(join(TRACES_DIR, `${tag}.trace.json`));
      }
      await profiler.detach();

      if (isTimed) iters.push({ wallMs, longestTaskMs, usedJsHeapBytesDelta: heapDelta });
    }

    const opts: MeasureOpts = {
      scenario: 'scroll-after-expand',
      fixture: fixture.shape,
      size: fixture.label,
      approxNodes: fixture.approxNodes,
      bytes,
      warmup: WARMUP_ITERS,
      iters: TIMED_ITERS,
    };
    emitRow(summarize(opts, iters, []));
  });
}
