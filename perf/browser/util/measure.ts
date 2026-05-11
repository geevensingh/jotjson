// Wall-clock + tail-metric measurement helpers for L3 perf scenarios.

export interface MeasureOpts {
  scenario: string;
  fixture: string;
  size: string;
  approxNodes: number;
  bytes: number;
  warmup: number;
  iters: number;
}

export interface PerfRowL3 {
  layer: 3;
  scenario: string;
  fixture: string;
  size: string;
  approxNodes: number;
  bytes: number;
  iters: number;
  wallNsMedian: number;
  wallNsIqrLow: number;
  wallNsIqrHigh: number;
  wallNsStddev: number;
  longestTaskMsMedian: number | null;
  longestTaskMsIqrLow: number | null;
  longestTaskMsIqrHigh: number | null;
  inpMsMedian: number | null;
  usedJsHeapBytesDeltaMedian: number | null;
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

function quantileOrNull(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, q);
}

function medianOrNull(values: number[]): number | null {
  return quantileOrNull(values, 0.5);
}

export interface IterMetrics {
  wallMs: number;
  longestTaskMs: number | null;
  usedJsHeapBytesDelta: number | null;
}

export function summarize(
  opts: MeasureOpts,
  iters: IterMetrics[],
  inpMsValues: number[],
): PerfRowL3 {
  const wallNs = iters.map((iter) => iter.wallMs * 1_000_000);
  const sorted = [...wallNs].sort((a, b) => a - b);
  const longestTaskMs = iters
    .map((iter) => iter.longestTaskMs)
    .filter((x): x is number => x !== null);
  const heapDelta = iters
    .map((iter) => iter.usedJsHeapBytesDelta)
    .filter((x): x is number => x !== null);
  return {
    layer: 3,
    scenario: opts.scenario,
    fixture: opts.fixture,
    size: opts.size,
    approxNodes: opts.approxNodes,
    bytes: opts.bytes,
    iters: iters.length,
    wallNsMedian: quantile(sorted, 0.5),
    wallNsIqrLow: quantile(sorted, 0.25),
    wallNsIqrHigh: quantile(sorted, 0.75),
    wallNsStddev: stddev(wallNs),
    longestTaskMsMedian: medianOrNull(longestTaskMs),
    longestTaskMsIqrLow: quantileOrNull(longestTaskMs, 0.25),
    longestTaskMsIqrHigh: quantileOrNull(longestTaskMs, 0.75),
    inpMsMedian: medianOrNull(inpMsValues),
    usedJsHeapBytesDeltaMedian: medianOrNull(heapDelta),
  };
}

/**
 * Browser-side: starts a longtask PerformanceObserver and returns a
 * `stop()` that returns the longest task duration (in ms) seen since
 * the start. Returns null if the browser has no longtask support.
 *
 * Stringified for `page.evaluate`.
 */
export const LONGTASK_OBSERVER_SCRIPT = `
  (function () {
    if (typeof PerformanceObserver === 'undefined') {
      window.__perfLongtaskMax = null;
      return false;
    }
    window.__perfLongtaskMax = 0;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > window.__perfLongtaskMax) {
            window.__perfLongtaskMax = entry.duration;
          }
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
      window.__perfLongtaskObserver = observer;
      return true;
    } catch (e) {
      window.__perfLongtaskMax = null;
      return false;
    }
  })();
`;

export const LONGTASK_OBSERVER_STOP_SCRIPT = `
  (function () {
    if (window.__perfLongtaskObserver) {
      try { window.__perfLongtaskObserver.disconnect(); } catch (e) {}
      delete window.__perfLongtaskObserver;
    }
    return window.__perfLongtaskMax;
  })();
`;

export const HEAP_SAMPLE_SCRIPT = `
  (function () {
    const memory = performance.memory;
    return memory ? memory.usedJSHeapSize : null;
  })();
`;
