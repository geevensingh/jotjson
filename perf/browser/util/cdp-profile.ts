// CDP-driven flame-graph capture wrappers. Used by every L3 scenario
// to write `.cpuprofile` (Chrome DevTools Profiler format) and
// `.trace.json` (Chrome tracing) files alongside the JSONL output.
//
// We use Playwright's `page.context().newCDPSession(page)` to talk
// raw CDP, NOT `page.context().tracing.start()` (which produces a
// Playwright-replay zip, not flame-graph data).

import { type CDPSession, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class CdpProfiler {
  private session: CDPSession | null = null;
  private profilerStarted = false;
  private tracingStarted = false;
  private tracePackets: unknown[] = [];
  private tracingDataListener: ((event: { value: unknown[] }) => void) | null = null;

  async attach(page: Page): Promise<void> {
    this.session = await page.context().newCDPSession(page);
  }

  async startProfiler(): Promise<void> {
    if (!this.session) throw new Error('CdpProfiler.attach() must be called first');
    await this.session.send('Profiler.enable');
    await this.session.send('Profiler.setSamplingInterval', { interval: 100 });
    await this.session.send('Profiler.start');
    this.profilerStarted = true;
  }

  async stopProfilerToFile(outPath: string): Promise<void> {
    if (!this.session || !this.profilerStarted) return;
    const result = await this.session.send('Profiler.stop');
    this.profilerStarted = false;
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(result.profile), 'utf8');
  }

  async startTracing(): Promise<void> {
    if (!this.session) throw new Error('CdpProfiler.attach() must be called first');
    this.tracePackets = [];
    const onData = (event: { value: unknown[] }) => {
      for (const packet of event.value) this.tracePackets.push(packet);
    };
    this.tracingDataListener = onData;
    this.session.on('Tracing.dataCollected', onData);
    await this.session.send('Tracing.start', {
      categories: 'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline',
      transferMode: 'ReportEvents',
    });
    this.tracingStarted = true;
  }

  // MUST register the Tracing.tracingComplete listener BEFORE sending
  // Tracing.end: tracingComplete can fire synchronously from end's
  // ack on small captures, and a late-registered listener silently
  // hangs (Promise never resolves). The 30s race ceiling + zero-event
  // assertion turn that silent failure into a loud, debuggable error.
  async stopTracingToFile(outPath: string): Promise<void> {
    if (!this.session || !this.tracingStarted) return;
    const session = this.session;
    const completion = new Promise<void>((resolve) => {
      session.once('Tracing.tracingComplete', () => resolve());
    });
    const timeout = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('CDP trace stop timeout (30s)')), 30_000);
    });
    await session.send('Tracing.end');
    await Promise.race([completion, timeout]);
    this.tracingStarted = false;
    if (this.tracingDataListener) {
      session.off('Tracing.dataCollected', this.tracingDataListener);
      this.tracingDataListener = null;
    }
    if (this.tracePackets.length === 0) {
      throw new Error(
        `CDP tracing collected zero events before completion. Trace file would be empty: ${outPath}`,
      );
    }
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ traceEvents: this.tracePackets }), 'utf8');
  }

  async collectGarbage(): Promise<void> {
    if (!this.session) return;
    try {
      await this.session.send('HeapProfiler.collectGarbage');
    } catch {
      // older CDP versions only -- ignore.
    }
  }

  async detach(): Promise<void> {
    if (!this.session) return;
    try {
      await this.session.detach();
    } catch {
      // page may already be closed.
    }
    this.session = null;
  }
}
