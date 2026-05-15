import { Injectable } from '@angular/core';

/**
 * Per-instance measurement pending in the shared rAF queue. The
 * `read` callback runs in the read pass (collects layout values
 * such as `scrollWidth` / `clientWidth`); the `write` callback runs
 * in the write pass with the value `read` produced (applies the
 * derived signal write or DOM mutation). Splitting the two phases
 * is what makes batching defeat layout thrash: if `read` and
 * `write` were a single callback (`enqueue(fn)`), iteration N's
 * read would happen after iteration N-1's write, forcing a fresh
 * layout for every pending instance.
 */
type Pending<T> = { read: () => T; write: (value: T) => void };

/**
 * Shared rAF queue for layout-read + signal-write pairs. Used by
 * `OverflowDetectorDirective` (and any future overflow-driven UI)
 * to batch all `scrollWidth` / `clientWidth` reads into one read
 * pass per frame, then apply all writes in a separate pass. Trades
 * one rAF latency frame for ~Nx fewer forced layout reflows when
 * N directives are mounted simultaneously.
 *
 * Two-phase API contract: enqueue both halves separately; the
 * service guarantees every `read` callback in a batch fires before
 * any `write` callback fires. Validated by the spec via injected
 * fake recording call order.
 */
@Injectable({ providedIn: 'root' })
export class OverflowMeasurementQueue {
  private readonly pending: Array<Pending<unknown>> = [];
  private rafId: number | null = null;

  /**
   * Schedule a measurement. The `read` callback runs in the read
   * pass (no signal writes; only DOM reads); the `write` callback
   * runs in the write pass with the value `read` produced. Both
   * fire on the same animation frame as every other enqueued
   * measurement.
   */
  enqueue<T>(read: () => T, write: (value: T) => void): void {
    this.pending.push({ read, write } as Pending<unknown>);
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(() => this.flush());
    }
  }

  private flush(): void {
    const batch = this.pending.splice(0);
    this.rafId = null;
    const results = batch.map((p) => ({ p, value: p.read() }));
    for (const { p, value } of results) {
      p.write(value);
    }
  }

  /**
   * Test seam: drains the queue synchronously, bypassing rAF.
   * Returns the number of pending entries that were flushed.
   * Production code MUST NOT call this; the queue is rAF-driven.
   */
  __flushForTesting(): number {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
    }
    const count = this.pending.length;
    this.flush();
    return count;
  }
}
