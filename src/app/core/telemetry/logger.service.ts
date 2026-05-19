import { Injectable, inject } from '@angular/core';
import { msalBridge } from './msal-bridge';
import { HttpErrorContext, NormalizedError, normalizeError } from './normalize-error';
import { TelemetryMessageId } from './telemetry-message-ids';
import {
  TelemetryMeasurements,
  TelemetryProps,
  TelemetryService,
  TelemetrySeverity,
} from './telemetry.service';

const BUFFER_CAP = 100;
const BOOT_FAIL_KEY = 'jotjson.bootErr';
const BRIDGE_FAIL_KEY = 'jotjson.msalBridgeErr';

/**
 * Message IDs whose `console.*` mirror is intentionally suppressed.
 * The App Insights sink is unaffected -- these still land in
 * `customEvents` / `traces` / `exceptions` as usual.
 *
 * Today this carries one ID: `errorHandler.suppressed`. That counter
 * is emitted every time `TelemetryErrorHandler` drops a benign-noise
 * exception (e.g. Monaco's `CancellationError` during editor
 * disposal). Letting it mirror to `console.info` would defeat the
 * suppression's purpose by re-introducing one console line per
 * cancellation in dev DevTools.
 *
 * Add new entries here when a new high-volume counter would only
 * pollute dev DevTools without aiding diagnosis. Document the choice
 * in the corresponding entry in `telemetry-message-ids.ts`.
 */
const QUIET_CONSOLE_IDS: ReadonlySet<TelemetryMessageId> = new Set<TelemetryMessageId>([
  'errorHandler.suppressed',
]);

type Severity = 'info' | 'warn' | 'error';

interface PendingEntry {
  ts: number;
  severity: Severity;
  /**
   * Discriminator for the App Insights sink. When `'event'`, dispatch
   * routes to `trackEvent` (regardless of `severity`); otherwise the
   * existing severity + error rules pick `trackTrace` vs
   * `trackException`.
   */
  kind?: 'event';
  messageId: TelemetryMessageId;
  props?: TelemetryProps;
  measurements?: TelemetryMeasurements;
  error?: NormalizedError;
}

/**
 * Public facade for application logging. All call sites should use this
 * service rather than `console.*` directly. Two parallel sinks:
 *
 * - `console.*` - by default (so DevTools shows everything in dev).
 *   Message IDs listed in `QUIET_CONSOLE_IDS` opt out of the console
 *   mirror -- see that constant for the rationale.
 * - App Insights - once `TelemetryService.connect()` resolves. The
 *   quiet-set does NOT affect App Insights dispatch.
 *
 * Three App Insights destinations, selected by which method is called:
 * - `info` / `warn` -> `trackTrace` (`traces` table).
 * - `error` -> `trackException` (`exceptions` table) when a cause is
 *   given; falls back to `trackTrace` severity error if cause is
 *   `null`.
 * - `event` -> `trackEvent` (`customEvents` table). For
 *   product-analytics counters and successful-flow signals; supports
 *   an optional numeric `measurements` map that lands in
 *   `customMeasurements`.
 *
 * Calls made before telemetry connects are buffered (FIFO, cap 100,
 * oldest dropped on overflow) and replayed on connect. If telemetry
 * cannot be initialized at all (no connection string, SDK load failure)
 * the buffer is dropped and we become a permanent no-op for the
 * telemetry sink.
 */
@Injectable({ providedIn: 'root' })
export class LoggerService {
  private readonly telemetry = inject(TelemetryService);
  private readonly buffer: PendingEntry[] = [];
  private connected = false;
  private disabled = false;

  constructor() {
    msalBridge.attachConsumer((entry) => {
      this.error('msal.error', null, entry.props);
    });
  }

  /**
   * Drive `TelemetryService.connect()` and, when it resolves, drain the
   * buffer to the appropriate sink. Idempotent. Called from
   * `AppComponent.ngOnInit` (deferred via dynamic import so the SDK
   * stays out of the initial bundle).
   */
  async connect(): Promise<void> {
    await this.telemetry.connect();
    if (this.telemetry.isDisabled) {
      this.disabled = true;
      this.buffer.length = 0;
      return;
    }
    this.connected = true;
    this.flushSessionStorage();
    const drained = this.buffer.splice(0, this.buffer.length);
    for (const entry of drained) {
      this.dispatch(entry);
    }
  }

  info(messageId: TelemetryMessageId, props?: TelemetryProps): void {
    this.consoleMirror('info', messageId, props);
    this.emitToPerfHarness('info', messageId, props);
    this.handle({ ts: Date.now(), severity: 'info', messageId, props });
  }

  warn(messageId: TelemetryMessageId, props?: TelemetryProps): void {
    this.consoleMirror('warn', messageId, props);
    this.emitToPerfHarness('warn', messageId, props);
    this.handle({ ts: Date.now(), severity: 'warn', messageId, props });
  }

  error(
    messageId: TelemetryMessageId,
    cause: unknown | null,
    props?: TelemetryProps,
    httpCtx?: HttpErrorContext,
  ): void {
    const normalized =
      cause === null || cause === undefined ? undefined : normalizeError(cause, httpCtx);
    this.consoleMirror('error', messageId, props, normalized);
    this.emitToPerfHarness('error', messageId, props);
    this.handle({
      ts: Date.now(),
      severity: 'error',
      messageId,
      props,
      error: normalized,
    });
  }

  /**
   * Emit a product-analytics event to the `customEvents` table.
   *
   * `props` populates `customDimensions` (string-typed, low
   * cardinality). `measurements` populates `customMeasurements`
   * (numeric, queryable with `percentile()` / `avg()` / `sum()`).
   * Don't reuse the same key across both maps - the wire format
   * collapses them into one name-space.
   *
   * Use `event` for successful counters, completed user actions, and
   * performance samples. For diagnostic / lifecycle log lines aimed at
   * humans, use `info` / `warn` instead. For failures with a cause,
   * use `error`.
   */
  event(
    messageId: TelemetryMessageId,
    props?: TelemetryProps,
    measurements?: TelemetryMeasurements,
  ): void {
    this.consoleMirrorEvent(messageId, props, measurements);
    this.emitToPerfHarness('event', messageId, props, measurements);
    this.handle({
      ts: Date.now(),
      severity: 'info',
      kind: 'event',
      messageId,
      props,
      measurements,
    });
  }

  // --- internals ---

  private handle(entry: PendingEntry): void {
    if (this.disabled) {
      return;
    }
    if (this.connected) {
      this.dispatch(entry);
      return;
    }
    if (this.buffer.length >= BUFFER_CAP) {
      this.buffer.shift();
    }
    this.buffer.push(entry);
  }

  private dispatch(entry: PendingEntry): void {
    try {
      if (entry.kind === 'event') {
        this.telemetry.trackEvent(entry.messageId, entry.props, entry.measurements);
        return;
      }
      const severity = this.toSdkSeverity(entry.severity);
      if (entry.severity === 'error' && entry.error) {
        this.telemetry.trackException(entry.error, {
          ...entry.props,
          messageId: entry.messageId,
        });
      } else {
        this.telemetry.trackTrace(entry.messageId, severity, entry.props);
      }
    } catch (error) {
      // Never throw out of the logger.
      // eslint-disable-next-line no-console
      console.warn('[telemetry] dispatch failed', error);
    }
  }

  private toSdkSeverity(severity: Severity): TelemetrySeverity {
    if (severity === 'error') {
      return 'error';
    }
    if (severity === 'warn') {
      return 'warn';
    }
    return 'info';
  }

  private consoleMirror(
    severity: Severity,
    messageId: TelemetryMessageId,
    props?: TelemetryProps,
    error?: NormalizedError,
  ): void {
    if (QUIET_CONSOLE_IDS.has(messageId)) {
      return;
    }
    // eslint-disable-next-line no-console
    const fn =
      severity === 'error' ? console.error : severity === 'warn' ? console.warn : console.info;
    if (error) {
      fn(`[${messageId}]`, props ?? {}, error);
    } else {
      fn(`[${messageId}]`, props ?? {});
    }
  }

  private consoleMirrorEvent(
    messageId: TelemetryMessageId,
    props?: TelemetryProps,
    measurements?: TelemetryMeasurements,
  ): void {
    if (QUIET_CONSOLE_IDS.has(messageId)) {
      return;
    }
    // eslint-disable-next-line no-console
    console.info(`[event:${messageId}]`, props ?? {}, measurements ?? {});
  }

  private flushSessionStorage(): void {
    try {
      const raw = sessionStorage.getItem(BOOT_FAIL_KEY);
      if (raw) {
        sessionStorage.removeItem(BOOT_FAIL_KEY);
        const parsed = JSON.parse(raw) as { name?: string; message?: string };
        this.telemetry.trackException(
          {
            kind: 'error',
            name: parsed.name ?? 'BootError',
            message: parsed.message ?? '<no message>',
          },
          { messageId: 'boot.failed' },
        );
      }
    } catch {
      // ignore
    }
    try {
      const raw = sessionStorage.getItem(BRIDGE_FAIL_KEY);
      if (raw) {
        sessionStorage.removeItem(BRIDGE_FAIL_KEY);
        const parsed = JSON.parse(raw) as { name?: string; message?: string };
        this.telemetry.trackException(
          {
            kind: 'error',
            name: parsed.name ?? 'BridgeError',
            message: parsed.message ?? '<no message>',
          },
          { messageId: 'auth.msalBridge.failed' },
        );
      }
    } catch {
      // ignore
    }
  }

  // --- test seam ---

  /**
   * Attaches a perf-harness sink that receives every event emitted by
   * `info`, `warn`, `error`, and `event` calls. Used by the Playwright
   * perf harness (`perf/browser/util/perf-harness.ts`) to observe
   * existing telemetry events (e.g. `paste.handle`, `monaco.loaded`)
   * without spying or adding production DOM markers.
   *
   * The seam is named per AGENTS.md `__<verb>ForTesting` convention.
   * Production code MUST NOT call this method. The wiring lives in
   * `src/main.ts`: after `bootstrapApplication` resolves, if the
   * L3 spec has installed the `window.__jotjsonPerfHarness` shim via
   * `page.addInitScript`, the bootstrap calls this method with that
   * shim. In normal production (no shim present), this method is
   * never called and `perfSink` stays `null`.
   */
  __attachPerfHarnessForTesting(sink: PerfHarnessSink): void {
    this.perfSink = sink;
  }

  /**
   * Detaches the perf-harness sink. Counterpart of
   * `__attachPerfHarnessForTesting`. Idempotent.
   */
  __detachPerfHarnessForTesting(): void {
    this.perfSink = null;
  }

  private perfSink: PerfHarnessSink | null = null;

  private emitToPerfHarness(
    severity: Severity | 'event',
    messageId: TelemetryMessageId,
    props?: TelemetryProps,
    measurements?: TelemetryMeasurements,
  ): void {
    if (this.perfSink === null) return;
    try {
      this.perfSink({ ts: Date.now(), severity, messageId, props, measurements });
    } catch {
      // Never throw out of the logger; harness failures are noise.
    }
  }
}

/**
 * Shape of the perf-harness sink. See `LoggerService.__attachPerfHarnessForTesting`.
 */
export interface PerfHarnessEvent {
  ts: number;
  severity: 'info' | 'warn' | 'error' | 'event';
  messageId: TelemetryMessageId;
  props?: TelemetryProps;
  measurements?: TelemetryMeasurements;
}

export type PerfHarnessSink = (entry: PerfHarnessEvent) => void;
