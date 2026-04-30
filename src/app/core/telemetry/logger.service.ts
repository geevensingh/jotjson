import { Injectable, inject } from '@angular/core';
import { msalBridge } from './msal-bridge';
import {
  HttpErrorContext,
  NormalizedError,
  normalizeError
} from './normalize-error';
import {
  TelemetryService,
  TelemetryMeasurements,
  TelemetryProps,
  TelemetrySeverity
} from './telemetry.service';
import { TelemetryMessageId } from './telemetry-message-ids';

const BUFFER_CAP = 100;
const BOOT_FAIL_KEY = 'jotjson.bootErr';

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
 * - `console.*` - always (so DevTools shows everything in dev).
 * - App Insights - once `TelemetryService.connect()` resolves.
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
    this.handle({ ts: Date.now(), severity: 'info', messageId, props });
  }

  warn(messageId: TelemetryMessageId, props?: TelemetryProps): void {
    this.consoleMirror('warn', messageId, props);
    this.handle({ ts: Date.now(), severity: 'warn', messageId, props });
  }

  error(
    messageId: TelemetryMessageId,
    cause: unknown | null,
    props?: TelemetryProps,
    httpCtx?: HttpErrorContext
  ): void {
    const normalized = cause === null || cause === undefined
      ? undefined
      : normalizeError(cause, httpCtx);
    this.consoleMirror('error', messageId, props, normalized);
    this.handle({
      ts: Date.now(),
      severity: 'error',
      messageId,
      props,
      error: normalized
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
    measurements?: TelemetryMeasurements
  ): void {
    this.consoleMirrorEvent(messageId, props, measurements);
    this.handle({
      ts: Date.now(),
      severity: 'info',
      kind: 'event',
      messageId,
      props,
      measurements
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
        this.telemetry.trackEvent(
          entry.messageId,
          entry.props,
          entry.measurements
        );
        return;
      }
      const severity = this.toSdkSeverity(entry.severity);
      if (entry.severity === 'error' && entry.error) {
        this.telemetry.trackException(entry.error, {
          ...entry.props,
          messageId: entry.messageId
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
    error?: NormalizedError
  ): void {
    // eslint-disable-next-line no-console
    const fn = severity === 'error'
      ? console.error
      : severity === 'warn'
        ? console.warn
        : console.info;
    if (error) {
      fn(`[${messageId}]`, props ?? {}, error);
    } else {
      fn(`[${messageId}]`, props ?? {});
    }
  }

  private consoleMirrorEvent(
    messageId: TelemetryMessageId,
    props?: TelemetryProps,
    measurements?: TelemetryMeasurements
  ): void {
    // eslint-disable-next-line no-console
    console.info(`[event:${messageId}]`, props ?? {}, measurements ?? {});
  }

  private flushSessionStorage(): void {
    try {
      const raw = sessionStorage.getItem(BOOT_FAIL_KEY);
      if (!raw) {
        return;
      }
      sessionStorage.removeItem(BOOT_FAIL_KEY);
      const parsed = JSON.parse(raw) as { name?: string; message?: string };
      this.telemetry.trackException(
        {
          kind: 'error',
          name: parsed.name ?? 'BootError',
          message: parsed.message ?? '<no message>'
        },
        { messageId: 'boot.failed' }
      );
    } catch {
      // ignore
    }
  }
}
