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
  shape: 'wide-aoo' | 'cosmos-doc-sample';
  approxNodes: number;
  label: string;
}

const TIMED_ITERS = 7;
const WARMUP_ITERS = 1;

function pickFixtures(): Fixture[] {
  const force5m = process.env['PERF_FORCE_5M'] === '1';
  const out: Fixture[] = [
    { shape: 'wide-aoo', approxNodes: 10_000, label: '10K' },
    { shape: 'wide-aoo', approxNodes: 100_000, label: '100K' },
    { shape: 'wide-aoo', approxNodes: 1_000_000, label: '1M' },
  ];
  if (force5m) out.push({ shape: 'wide-aoo', approxNodes: 5_000_000, label: '5M' });
  return out;
}

function generateWideAooJson(approxNodes: number): string {
  // Inline mulberry32 + wide-aoo generation (kept in-spec to avoid
  // importing perf/fixtures/generate.ts with module-resolution
  // gymnastics under Playwright's TS loader).
  let seed = 0xc0ffee >>> 0;
  const rng = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const itemCount = Math.max(0, Math.floor((approxNodes - 1) / 11));
  const parts: string[] = [];
  for (let i = 0; i < itemCount; i++) {
    const item: Record<string, number> = {};
    for (let k = 0; k < 10; k++) item[`k${k}`] = Math.floor(rng() * 1e9);
    parts.push(JSON.stringify(item));
  }
  return `[${parts.join(',')}]`;
}

const RESULTS_ROOT =
  process.env['PERF_RESULTS_DIR'] ?? join(process.cwd(), 'perf-results', 'l3-tmp');
const TRACES_DIR = join(RESULTS_ROOT, 'traces');

function emitRow(row: object): void {
  // eslint-disable-next-line no-console
  console.log(`@@PERF_L3@@${JSON.stringify(row)}@@END@@`);
}

for (const fixture of pickFixtures()) {
  test(`paste-large: ${fixture.shape} @ ${fixture.label}`, async ({ page }) => {
    test.setTimeout(10 * 60 * 1000);

    // Pre-generate the JSON ONCE outside the timed loop so per-iter
    // wall-clock is paste+render only.
    const json = generateWideAooJson(fixture.approxNodes);
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
      // `[role="treeitem"]` (set by mat-tree-node) so the wait works for
      // both array-rooted (wide-aoo) and object-rooted (cosmos-doc)
      // fixtures; we cannot wait on a known key like `k0` because nested
      // keys remain hidden under collapsed parents.
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
        const tag = `paste-large-${fixture.shape}-${fixture.label}-iter${i - WARMUP_ITERS}`;
        await profiler.stopProfilerToFile(join(TRACES_DIR, `${tag}.cpuprofile`));
        await profiler.stopTracingToFile(join(TRACES_DIR, `${tag}.trace.json`));
      }
      await profiler.detach();

      if (isTimed) iters.push({ wallMs, longestTaskMs, usedJsHeapBytesDelta: heapDelta });
    }

    const opts: MeasureOpts = {
      scenario: 'paste-large',
      fixture: fixture.shape,
      size: fixture.label,
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
