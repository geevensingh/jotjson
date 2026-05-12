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
//   2. Scroll-after-expand: expand the tree, then scroll the
//      `.tree-body` container through a short scroll session.
//      Gated to 10K only (mat-tree is NOT virtualized in v1, so
//      100K/1M scroll would OOM Karma -- those live in L3).
//
// Why measure here at all (vs L1 + L3):
//   L1 measures the pure tree builder; L3 measures the full browser.
//   L2 measures the Angular component lifecycle: detectChanges,
//   ChangeDetection, mat-tree (NOT virtualized in v1), template
//   evaluation. This is the "rehearsal" layer for L3 user pain.
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
  // Size gating:
  //   - 10K is the default (each iter ~5s; full N=5 spec finishes in ~35s).
  //   - 100K is opt-in via `window.__perfL2Force100K = true` or
  //     `?force100k=1`. Each iter is ~50s; full spec ~7 minutes; needs
  //     karma.perf.conf.js timeouts bumped accordingly.
  //   - 1M is opt-in via `window.__perfL2Force1M = true` or `?force1m=1`.
  //     Each iter is many minutes; reserve for deliberate diagnostic runs.
  // Defaults intentionally cap at 10K so unattended `npm run perf:l2`
  // stays well under the Karma browserNoActivityTimeout watchdog.
  type ForceWindow = Window & {
    __perfL2Force100K?: boolean;
    __perfL2Force1M?: boolean;
  };
  const win = window as ForceWindow;
  const force1M = win.__perfL2Force1M === true || location.search.includes('force1m=1');
  const force100K = win.__perfL2Force100K === true || location.search.includes('force100k=1');
  const enabledNodeCounts = new Set<number>([10_000]);
  if (force100K || force1M) enabledNodeCounts.add(100_000);
  if (force1M) enabledNodeCounts.add(1_000_000);
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
 * Renders the tree, expands all nodes, then walks the `.tree-body`
 * scroll container through `SCROLL_STEPS` programmatic scrollTop
 * positions (each followed by a double-rAF settle). The harness
 * times the full callback, so the emitted `wallNs` covers
 * "initial-render + expand-all + scroll session" -- not the scroll
 * alone. Diff comparisons are still valid because every iteration
 * executes the same fixed sequence.
 *
 * Gated to 10K only at the call site. 100K + 1M scroll lives in L3.
 */
async function scrollAfterExpand(fixture: ComponentFixture<JsonTreeComponent>): Promise<void> {
  fixture.detectChanges();
  await nextDoubleRaf();
  fixture.componentInstance.expandAll();
  fixture.detectChanges();
  await nextDoubleRaf();
  const treeBody = fixture.nativeElement.querySelector('.tree-body') as HTMLElement | null;
  if (!treeBody) {
    throw new Error('L2 scroll-after-expand: .tree-body element not found in fixture.');
  }
  const scrollHeight = treeBody.scrollHeight;
  for (let step = 1; step <= SCROLL_STEPS; step++) {
    treeBody.scrollTop = (scrollHeight * step) / (SCROLL_STEPS + 1);
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

  // Scroll-after-expand: 10K only. 100K/1M scroll on a non-virtualized
  // mat-tree would OOM Karma; L3's `scroll-after-expand.spec.ts` runs
  // larger sizes in a real Playwright browser instead.
  for (const spec of defaultFixtures().filter((fixture) => fixture.approxNodes === 10_000)) {
    it(`scroll-after-expand: ${spec.shape} @ ${spec.size}`, async () => {
      const row = await measureOneFixture(`scroll-after-expand`, spec, scrollAfterExpand);
      emitRow(row);
      expect(row.iters).toBe(TIMED_ITERS);
    });
  }
});
