/**
 * Backend telemetry uses a manual-only Application Insights client so explicit
 * events remain separate from Azure Functions host auto-instrumentation.
 * useGlobalProviders: false prevents the client from reusing global
 * OpenTelemetry providers that the host may have registered.
 */
import { TelemetryClient } from 'applicationinsights';

/** String properties attached to telemetry events. */
export type TelemetryProperties = Record<string, string>;

/** Numeric measurements attached to telemetry events. */
export type TelemetryMeasurements = Record<string, number>;

let cachedClient: TelemetryClient | null | undefined = undefined;
let warnedMissingConnectionString = false;
let testOverride: TelemetryClient | null | undefined = undefined;

function getClient(): TelemetryClient | null {
  if (testOverride !== undefined) {
    return testOverride;
  }

  if (cachedClient !== undefined) {
    return cachedClient;
  }

  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!connectionString) {
    if (!warnedMissingConnectionString) {
      console.warn(
        'Application Insights connection string is not configured; telemetry events will not be sent.',
      );
      warnedMissingConnectionString = true;
    }

    cachedClient = null;
    return null;
  }

  cachedClient = new TelemetryClient(connectionString, {
    useGlobalProviders: false,
  });
  return cachedClient;
}

/** Tracks a custom event when backend telemetry is configured. */
export function trackEvent(
  name: string,
  properties?: TelemetryProperties,
  measurements?: TelemetryMeasurements,
): void {
  const client = getClient();
  if (client === null) {
    return;
  }

  client.trackEvent({ name, properties, measurements });
}

/** Sets the telemetry client override for unit tests. */
export function __setTelemetryClientForTesting(client: TelemetryClient | null): void {
  testOverride = client;
}

/** Resets telemetry initialization state for unit tests. */
export function __resetTelemetryInitForTesting(): void {
  cachedClient = undefined;
  warnedMissingConnectionString = false;
  testOverride = undefined;
}
