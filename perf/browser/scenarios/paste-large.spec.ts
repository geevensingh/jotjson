// Layer-3 scenario: paste-large.
//
// The flagship perf bench. Drives the user-pain flow:
//   1. Boot the production bundle.
//   2. Wait for Monaco to load.
//   3. Insert a large JSON string into the editor.
//   4. Wait for the tree to render its first row.
//   5. Capture wall-clock + longtask + heap delta.
//   6. CDP `Profiler.start/stop` writes a `.cpuprofile`.
//   7. CDP `Tracing.start/end` writes a `.trace.json`.
//
// Output: rows emitted via console.log sentinel `@@PERF_L3@@<json>@@END@@`,
// captured by `scripts/perf/run-l3.mjs` into `perf-results/<utc>/layer-3.jsonl`,
// alongside `perf-results/<utc>/traces/paste-large-*.cpuprofile` and
// `perf-results/<utc>/traces/paste-large-*.trace.json`.

import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_CATALOG } from '../../fixtures/catalog';
import { generate } from '../../fixtures/generate';
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

const FIXTURES = FIXTURE_CATALOG.filter((fixture) => fixture.shape === 'wide-aoo');

const RESULTS_ROOT =
  process.env['PERF_RESULTS_DIR'] ?? join(process.cwd(), 'perf-results', 'l3-tmp');
const TRACES_DIR = join(RESULTS_ROOT, 'traces');

function emitRow(row: object): void {
  // eslint-disable-next-line no-console
  console.log(`@@PERF_L3@@${JSON.stringify(row)}@@END@@`);
}

for (const fixture of FIXTURES) {
  test(`paste-large: ${fixture.shape} @ ${fixture.size}`, async ({ page }) => {
    test.setTimeout(10 * 60 * 1000);

    // Pre-generate the JSON ONCE outside the timed loop so per-iter
    // wall-clock is paste+render only.
    const json = generate({ shape: fixture.shape, approxNodes: fixture.approxNodes });
    const bytes = json.length;

    await page.addInitScript({ content: perfHarnessInitScript() });

    const iters: IterMetrics[] = [];
    let captureTraceForIter = 0; // capture .cpuprofile + .trace.json on the first timed iter only.

    for (let i = 0; i < WARMUP_ITERS + TIMED_ITERS; i++) {
      const isTimed = i >= WARMUP_ITERS;
      await page.goto('/', { waitUntil: 'load' });
      await page.getByRole('textbox', { name: 'JSON editor' }).waitFor({ state: 'visible' });

      const profiler = new CdpProfiler();
      await profiler.attach(page);

      await page.evaluate(LONGTASK_OBSERVER_SCRIPT);
      const heapBefore: number | null = await page.evaluate(HEAP_SAMPLE_SCRIPT);
      await profiler.collectGarbage();

      const captureFlame = isTimed && i - WARMUP_ITERS === captureTraceForIter;
      if (captureFlame) {
        await profiler.startProfiler();
        await profiler.startTracing();
      }

      const editor = page.getByRole('textbox', { name: 'JSON editor' });
      await editor.focus();

      const t0 = Date.now();
      await page.evaluate(async (text: string) => {
        // Direct Monaco programmatic insert is much faster (and more
        // reproducible) than keyboard.insertText for large payloads.
        const monacoApi = (
          window as unknown as { monaco?: { editor?: { getEditors?: () => unknown[] } } }
        ).monaco;
        const editors = monacoApi?.editor?.getEditors?.() as
          | { setValue: (value: string) => void }[]
          | undefined;
        if (editors && editors[0]) {
          editors[0].setValue(text);
        } else {
          // Fallback: dispatch input via the DOM textarea.
          const el = document.querySelector('textarea[aria-label="JSON editor"]');
          if (el instanceof HTMLTextAreaElement) {
            el.value = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
      }, json);

      // Wait for the tree pane to show its first rendered row. We use
      // `[role="treeitem"]` (set by mat-tree-node) so the wait does not
      // depend on a known key such as `id`; nested keys remain hidden
      // under collapsed parents.
      await page
        .locator('section[aria-label="Tree view"] [role="treeitem"]')
        .first()
        .waitFor({
          state: 'visible',
          timeout: 5 * 60 * 1000,
        });
      const wallMs = Date.now() - t0;

      const longestTaskMs: number | null = await page.evaluate(LONGTASK_OBSERVER_STOP_SCRIPT);
      const heapAfter: number | null = await page.evaluate(HEAP_SAMPLE_SCRIPT);
      const heapDelta = heapBefore !== null && heapAfter !== null ? heapAfter - heapBefore : null;

      if (captureFlame) {
        const tag = `paste-large-${fixture.shape}-${fixture.size}-iter${i - WARMUP_ITERS}`;
        await profiler.stopProfilerToFile(join(TRACES_DIR, `${tag}.cpuprofile`));
        await profiler.stopTracingToFile(join(TRACES_DIR, `${tag}.trace.json`));
      }
      await profiler.detach();

      if (isTimed) iters.push({ wallMs, longestTaskMs, usedJsHeapBytesDelta: heapDelta });
    }

    const opts: MeasureOpts = {
      scenario: 'paste-large',
      fixture: fixture.shape,
      size: fixture.size,
      approxNodes: fixture.approxNodes,
      bytes,
      warmup: WARMUP_ITERS,
      iters: TIMED_ITERS,
    };
    const row = summarize(opts, iters, []);
    emitRow(row);
  });
}

// Persist a marker file so `run-l3.mjs` knows where TRACES_DIR ended up
// (Playwright spawns specs with cwd = repo root, but PERF_RESULTS_DIR
// may be unset for local debugging).
test.afterAll(() => {
  try {
    writeFileSync(join(RESULTS_ROOT, '.traces-dir.txt'), TRACES_DIR + '\n');
  } catch {
    // Best-effort -- not all runs care about the marker file.
  }
});
