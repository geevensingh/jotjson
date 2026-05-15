// Layer-2 perf bench: in-browser, in-Karma render benches for
// `JsonTreeComponent`. NOT a `.spec.ts` -- excluded from `verify:fast`
// via `tsconfig.spec.json`. Picked up by `tsconfig.perf-l2.json` and
// `karma.perf.conf.js`.
//
// Invoked as:
//   npm run perf:l2
//
// What this exercises:
//   1. Initial render of an N-node tree (deep25, wide-aoo).
//   2. Scroll-after-expand: expand the tree, then walk the
//      `<cdk-virtual-scroll-viewport>` through a short scroll session
//      via `viewport.scrollToOffset()` (issue #95 Phase 2: tree is
//      virtualized; the prior `.tree-body.scrollTop` path only scrolled
//      the outer wrapper, not the virtual viewport's internal offset).
//
// Why measure here at all (vs L1 + L3):
//   L1 measures the pure tree builder; L3 measures the full browser.
//   L2 measures the Angular component lifecycle: detectChanges,
//   ChangeDetection, virtualized rendering through
//   `<cdk-virtual-scroll-viewport>`, template evaluation. This is the
//   "rehearsal" layer for L3 user pain.
//
// Output:
//   `console.log` rows with the sentinel `@@PERF_L2@@<json>@@END@@`,
//   captured by the wrapper script and concatenated into
//   `perf-results/<utc>/layer-2.jsonl`.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import {
  FIXTURE_CATALOG,
  type FixtureSpec as CatalogFixtureSpec,
} from '../../../../../perf/fixtures/catalog';
import { generate } from '../../../../../perf/fixtures/generate';
import { provideFakeAuth } from '../../../../testing/auth.testing';
import { JsonTreeComponent } from './json-tree.component';

type FixtureSpec = CatalogFixtureSpec;

interface PerfRow {
  layer: 2;
  scenario: string;
  fixture: string;
  size: string;
  approxNodes: number;
  iters: number;
  wallNsMedian: number;
  wallNsIqrLow: number;
  wallNsIqrHigh: number;
  wallNsStddev: number;
}

const WARMUP_ITERS = 2;
const TIMED_ITERS = 5;

function defaultFixtures(): FixtureSpec[] {
  // Size gating (post-Phase 2 virtualization; issue #95):
  //   - 10K + 100K are enabled by default. Virtualization made 100K
  //     viable inside Karma; each iter is now bounded by the viewport
  //     window, not the full node count.
  //   - 1M is opt-in via `window.__perfL2Force1M = true` or `?force1m=1`.
  //     Each iter is many minutes (build/expand traversal dominates);
  //     reserve for deliberate diagnostic runs.
  //   - `mixed-d10 @ 380k` (the ~5 MB NFR-anchor fixture from F-2)
  //     is opt-in via `window.__perfL2Force5MB = true` or
  //     `?force5mb=1`. Per skeptic #4: at default settings a 380K-
  //     node fixture extrapolated linearly from 100K's ~50 s/iter
  //     risks Karma's browserNoActivityTimeout watchdog. The flag
  //     mirrors the existing `?force1m=1` pattern.
  // Defaults intentionally cap so unattended `npm run perf:l2`
  // stays well under the Karma browserNoActivityTimeout watchdog.
  type ForceWindow = Window & {
    __perfL2Force1M?: boolean;
    __perfL2Force5MB?: boolean;
  };
  const win = window as ForceWindow;
  const force1M = win.__perfL2Force1M === true || location.search.includes('force1m=1');
  const force5MB = win.__perfL2Force5MB === true || location.search.includes('force5mb=1');
  const enabledNodeCounts = new Set<number>([10_000, 100_000]);
  if (force1M) enabledNodeCounts.add(1_000_000);
  if (force5MB) enabledNodeCounts.add(380_000);
  return FIXTURE_CATALOG.filter((fixture) => enabledNodeCounts.has(fixture.approxNodes));
}

function generateValue(spec: FixtureSpec): unknown {
  return JSON.parse(generate({ shape: spec.shape, approxNodes: spec.approxNodes }));
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function ensureGc(): () => void {
  const gc = (window as unknown as { gc?: () => void }).gc;
  if (typeof gc !== 'function') {
    throw new Error(
      'L2 perf spec: window.gc is undefined. Karma launcher must pass --js-flags=--expose-gc.',
    );
  }
  return gc;
}

function nextDoubleRaf(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

async function measureOneFixture(
  scenario: string,
  spec: FixtureSpec,
  build: (fixture: ComponentFixture<JsonTreeComponent>) => Promise<void>,
): Promise<PerfRow> {
  const gc = ensureGc();
  const value = generateValue(spec);
  const wallNs: number[] = [];

  const runOnce = async (): Promise<number> => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [JsonTreeComponent],
      providers: [...provideFakeAuth(), provideNoopAnimations()],
    }).compileComponents();
    const fixture = TestBed.createComponent(JsonTreeComponent);
    fixture.componentRef.setInput('value', value);
    gc();
    const t0 = performance.now();
    await build(fixture);
    const t1 = performance.now();
    fixture.destroy();
    fixture.nativeElement.remove?.();
    gc();
    await nextDoubleRaf();
    return (t1 - t0) * 1_000_000; // ms -> ns
  };

  for (let i = 0; i < WARMUP_ITERS; i++) await runOnce();
  for (let i = 0; i < TIMED_ITERS; i++) wallNs.push(await runOnce());

  const sorted = [...wallNs].sort((a, b) => a - b);
  return {
    layer: 2,
    scenario,
    fixture: spec.shape,
    size: spec.size,
    approxNodes: spec.approxNodes,
    iters: TIMED_ITERS,
    wallNsMedian: quantile(sorted, 0.5),
    wallNsIqrLow: quantile(sorted, 0.25),
    wallNsIqrHigh: quantile(sorted, 0.75),
    wallNsStddev: stddev(wallNs),
  };
}

async function initialRender(fixture: ComponentFixture<JsonTreeComponent>): Promise<void> {
  fixture.detectChanges();
  await nextDoubleRaf();
}

const SCROLL_STEPS = 7;

/**
 * Renders the tree, expands all nodes, then walks the
 * `<cdk-virtual-scroll-viewport>` through `SCROLL_STEPS` programmatic
 * `scrollToOffset()` positions (each followed by a double-rAF settle).
 * The harness times the full callback, so the emitted `wallNs` covers
 * "initial-render + expand-all + scroll session" -- not the scroll
 * alone. Diff comparisons are still valid because every iteration
 * executes the same fixed sequence.
 *
 * Post-Phase 2 (issue #95): the tree is virtualized; we drive the
 * inner viewport offset directly rather than the outer wrapper's
 * `scrollTop`, which is what users perceive when scrolling.
 */
async function scrollAfterExpand(fixture: ComponentFixture<JsonTreeComponent>): Promise<void> {
  fixture.detectChanges();
  await nextDoubleRaf();
  fixture.componentInstance.expandAll();
  fixture.detectChanges();
  await nextDoubleRaf();
  const viewport = fixture.componentInstance.__getHelpersForTesting().getViewport();
  if (!viewport) {
    throw new Error('L2 scroll-after-expand: <cdk-virtual-scroll-viewport> not found in fixture.');
  }
  const dataLength = viewport.getDataLength();
  const itemSize = viewport.measureRangeSize({ start: 0, end: 1 }) || 1;
  const totalContentPx = dataLength * itemSize;
  for (let step = 1; step <= SCROLL_STEPS; step++) {
    viewport.scrollToOffset((totalContentPx * step) / (SCROLL_STEPS + 1), 'auto');
    await nextDoubleRaf();
  }
}

function emitRow(row: PerfRow): void {
  // Sentinel format consumed by `scripts/perf/run-l2.mjs`.
  // eslint-disable-next-line no-console
  console.log(`@@PERF_L2@@${JSON.stringify(row)}@@END@@`);
}

describe('JsonTreeComponent perf (L2)', () => {
  for (const spec of defaultFixtures()) {
    it(`initial render: ${spec.shape} @ ${spec.size}`, async () => {
      const row = await measureOneFixture(`initial-render`, spec, initialRender);
      emitRow(row);
      // We don't assert thresholds here -- diff happens in `perf:diff`.
      expect(row.iters).toBe(TIMED_ITERS);
    });
  }

  // Scroll-after-expand: enabled for 10K + 100K post-virtualization
  // (issue #95 Phase 2). The viewport's scroll work is now O(viewport
  // window), not O(visibleNodes), so larger fixtures stay in budget.
  // 1M continues to live in L3 where a real Playwright browser is the
  // more honest measurement surface.
  //
  // wide-aoo @ 10K previously needed a force-flag because `expandAll`
  // materialized all siblings synchronously on the non-virtualized
  // mat-tree and tripped Karma's Jasmine timeout (#219).
  // Virtualization replaced the DOM-materialization cost with a single
  // `setExpandedBulk` Set write, so the gate is no longer needed.
  //
  // The ~5 MB `mixed-d10 @ 380k` NFR-anchor fixture (F-2) is also
  // exercised here when the `?force5mb=1` opt-in is set: it surfaces
  // through `defaultFixtures()` only under that flag, and the
  // scroll-after-expand path is a faithful read of "the user opened
  // a 5 MB blob and scrolled" -- the literal NFR pain point.
  for (const spec of defaultFixtures().filter(
    (fixture) =>
      fixture.approxNodes === 10_000 ||
      fixture.approxNodes === 100_000 ||
      fixture.approxNodes === 380_000,
  )) {
    it(`scroll-after-expand: ${spec.shape} @ ${spec.size}`, async () => {
      const row = await measureOneFixture(`scroll-after-expand`, spec, scrollAfterExpand);
      emitRow(row);
      expect(row.iters).toBe(TIMED_ITERS);
    });
  }
});
