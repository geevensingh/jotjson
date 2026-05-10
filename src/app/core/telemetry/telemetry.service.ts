import { Injectable } from '@angular/core';
import type { ApplicationInsights, ITelemetryItem } from '@microsoft/applicationinsights-web';
import { environment } from '../../../environments/environment';
import { NormalizedError, sanitizePath } from './normalize-error';
import { TelemetryMessageId } from './telemetry-message-ids';

export type TelemetryProps = Readonly<Record<string, string | number | boolean | undefined>>;

/**
 * Numeric measurements that land in Application Insights'
 * `customMeasurements` map (queryable with `percentile()`, `avg()`,
 * `sum()`). `TelemetryProps` lands in `customDimensions` (string-keyed,
 * groupable). Use measurements for raw numeric quantities (timing,
 * sizes, counts) and props for dimensional facets / closed-enum
 * buckets. Both maps share a single key-space at the wire level - do
 * not reuse the same key in both.
 */
export type TelemetryMeasurements = Readonly<Record<string, number>>;

export type ConnectState = 'idle' | 'connecting' | 'connected' | 'disabled';

/**
 * Severity used by callers. Mapped to App Insights `SeverityLevel`
 * inside `trackTrace` so this module never has to import the SDK
 * statically (which would pull it into the eager bundle).
 *
 * Mapping: info=1, warn=2, error=3.
 */
export type TelemetrySeverity = 'info' | 'warn' | 'error';

/**
 * Thin wrapper around `@microsoft/applicationinsights-web`.
 *
 * The SDK is dynamically imported on first `connect()` so the ~80 kB
 * bundle stays out of `main-*.js`. A telemetry initializer enforces our
 * privacy contract on every envelope (strip query/fragment, drop
 * envelopes still containing `?`, redact `Authorization`, disable
 * cookies).
 *
 * The service is safe to inject at construction time: it does not load
 * the SDK until `connect()` is called, and all `track*` methods buffer
 * via `LoggerService` when called before connect.
 */
@Injectable({ providedIn: 'root' })
export class TelemetryService {
  private appInsights: ApplicationInsights | null = null;
  private state: ConnectState = 'idle';
  // Tri-state: `undefined` = no setUser call yet, `null` = clear, string = set.
  private pendingOid: string | null | undefined = undefined;
  private connectPromise: Promise<void> | null = null;

  get connectState(): ConnectState {
    return this.state;
  }

  get isConnected(): boolean {
    return this.state === 'connected';
  }

  get isDisabled(): boolean {
    return this.state === 'disabled';
  }

  /**
   * Idempotent. Resolves once telemetry is connected OR permanently
   * disabled (in which case subsequent `track*` calls are no-ops).
   */
  connect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }
    const cs = environment.appInsightsConnectionString?.trim();
    if (!cs) {
      this.state = 'disabled';
      this.connectPromise = Promise.resolve();
      return this.connectPromise;
    }
    this.state = 'connecting';
    this.connectPromise = this.loadAndInit(cs).catch((error) => {
      this.state = 'disabled';
      // eslint-disable-next-line no-console
      console.warn('[telemetry] connect failed; telemetry disabled', error);
    });
    return this.connectPromise;
  }

  setUser(oid: string | null): void {
    if (this.appInsights && this.state === 'connected') {
      this.applyUser(oid);
    } else {
      this.pendingOid = oid;
    }
  }

  trackEvent(
    name: TelemetryMessageId,
    props?: TelemetryProps,
    measurements?: TelemetryMeasurements,
  ): void {
    if (!this.appInsights) {
      return;
    }
    this.appInsights.trackEvent({ name }, this.toCustomProps(props, measurements));
  }

  trackTrace(
    name: TelemetryMessageId,
    severity: TelemetrySeverity,
    props?: TelemetryProps,
    measurements?: TelemetryMeasurements,
  ): void {
    if (!this.appInsights) {
      return;
    }
    // SeverityLevel: Information=1, Warning=2, Error=3.
    const severityLevel = severity === 'error' ? 3 : severity === 'warn' ? 2 : 1;
    this.appInsights.trackTrace(
      { message: name, severityLevel },
      this.toCustomProps(props, measurements),
    );
  }

  trackException(error: NormalizedError, props?: TelemetryProps): void {
    if (!this.appInsights) {
      return;
    }
    const synthetic = this.toSyntheticError(error);
    this.appInsights.trackException(
      { exception: synthetic },
      this.toCustomProps({ ...props, ...this.errorProps(error) }),
    );
  }

  trackPageView(name: string, uri: string): void {
    if (!this.appInsights) {
      return;
    }
    const sanitized = sanitizePath(uri) ?? uri;
    this.appInsights.trackPageView({ name, uri: sanitized });
  }

  /**
   * Best-effort flush of any pending telemetry envelopes. Used by
   * call sites that are about to navigate the document away (sign-out
   * redirect, post-update hard reload) so that customEvents queued
   * just before the navigation are not dropped.
   *
   * The underlying SDK's `flush()` is synchronous and uses sendBeacon
   * by default (`async = true`), so the resolved promise here does
   * NOT mean the network round-trip completed -- only that the
   * envelopes were handed off to the browser's beacon queue. That is
   * the strongest guarantee available before a navigation; nothing
   * more is achievable from page JS.
   *
   * No-op when telemetry is disabled or not yet connected.
   */
  async flush(): Promise<void> {
    if (!this.appInsights) {
      return;
    }
    this.appInsights.flush();
  }

  // --- internals ---

  private async loadAndInit(connectionString: string): Promise<void> {
    // Dynamic import keeps the SDK in a lazy chunk. Do not statically
    // import `@microsoft/applicationinsights-web` from this file.
    const { ApplicationInsights: AI } = await import('@microsoft/applicationinsights-web');
    const ai = new AI({
      config: {
        connectionString,
        // Manual instrumentation policy (see DESIGN_SPEC Telemetry).
        disableExceptionTracking: true,
        disableAjaxTracking: false,
        enableAutoRouteTracking: false,
        enableAjaxErrorStatusText: false,
        enableAjaxPerfTracking: false,
        disableCookiesUsage: true,
        // Keep correlation between SPA and same-origin Functions.
        enableCorsCorrelation: true,
        distributedTracingMode: 2 /* W3C */,
      },
    });
    ai.loadAppInsights();
    ai.addTelemetryInitializer(this.privacyInitializer);
    this.appInsights = ai;
    this.state = 'connected';

    // Apply pending sign-in / sign-out, if any.
    if (this.pendingOid !== undefined) {
      this.applyUser(this.pendingOid);
      this.pendingOid = undefined;
    }
  }

  private privacyInitializer = (item: ITelemetryItem): boolean | void => {
    const data = item.data ?? {};
    // Sanitize any uri-like field that the SDK populates.
    const fields: Array<keyof typeof data> = ['uri', 'refUri', 'url'];
    for (const field of fields) {
      const fieldValue = data[field];
      if (typeof fieldValue === 'string') {
        data[field] = sanitizePath(fieldValue);
      }
    }
    if (item.baseData) {
      const bd = item.baseData;
      if (typeof bd['uri'] === 'string') {
        bd['uri'] = sanitizePath(bd['uri'] as string);
      }
      if (typeof bd['target'] === 'string') {
        // Dependency `target` is the host - safe. Dependency `name`
        // is `${METHOD} ${url}` - sanitize the second token.
      }
      if (typeof bd['name'] === 'string') {
        bd['name'] = this.sanitizeDependencyName(bd['name'] as string);
      }
      // Defense in depth: any name containing `?` after sanitization
      // means a query slipped past us. Drop the envelope rather than
      // ship it.
      const dropFields: string[] = ['uri', 'name', 'url'];
      for (const field of dropFields) {
        const fieldValue = bd[field];
        if (typeof fieldValue === 'string' && fieldValue.includes('?')) {
          return false;
        }
      }
    }
    // Redact Authorization header if any envelope echoes it.
    const props = item.data;
    if (props && typeof props['Authorization'] === 'string') {
      props['Authorization'] = '<redacted>';
    }
    item.data = data;
    return undefined;
  };

  private sanitizeDependencyName(name: string): string {
    // Format is typically "GET /api/foo?bar=1" - sanitize the URL part.
    const space = name.indexOf(' ');
    if (space < 0) {
      return name;
    }
    const verb = name.slice(0, space);
    const rest = name.slice(space + 1);
    return `${verb} ${sanitizePath(rest) ?? rest}`;
  }

  private applyUser(oid: string | null): void {
    if (!this.appInsights) {
      return;
    }
    if (oid) {
      this.appInsights.setAuthenticatedUserContext(oid);
    } else {
      this.appInsights.clearAuthenticatedUserContext();
    }
  }

  private toCustomProps(
    props?: TelemetryProps,
    measurements?: TelemetryMeasurements,
  ): Record<string, string | number> | undefined {
    if (!props && !measurements) {
      return undefined;
    }
    const out: Record<string, string | number> = {};
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined) {
          continue;
        }
        out[key] = String(value);
      }
    }
    if (measurements) {
      for (const [key, value] of Object.entries(measurements)) {
        // The AI SDK routes string-typed values to customDimensions and
        // number-typed values to customMeasurements. Skip non-finite
        // numbers (NaN, Infinity) - they would be serialized as "null"
        // or rejected by the wire format.
        if (typeof value === 'number' && Number.isFinite(value)) {
          out[key] = value;
        }
      }
    }
    return out;
  }

  private toSyntheticError(normalized: NormalizedError): Error {
    if (normalized.kind === 'http') {
      const error = new Error(
        `HTTP ${normalized.status} ${normalized.method ?? ''} ${normalized.pathTemplate ?? ''}`.trim(),
      );
      error.name = 'HttpError';
      return error;
    }
    if (normalized.kind === 'error') {
      const error = new Error(normalized.message);
      error.name = normalized.name;
      if (normalized.stack) {
        error.stack = normalized.stack;
      }
      return error;
    }
    const error = new Error(normalized.repr);
    error.name = 'UnknownThrow';
    return error;
  }

  private errorProps(normalized: NormalizedError): TelemetryProps {
    if (normalized.kind === 'http') {
      return {
        kind: 'http',
        status: normalized.status,
        method: normalized.method,
        pathTemplate: normalized.pathTemplate,
        backendCode: normalized.backendCode,
      };
    }
    if (normalized.kind === 'error') {
      return { kind: 'error', name: normalized.name };
    }
    return { kind: 'unknown' };
  }
}
