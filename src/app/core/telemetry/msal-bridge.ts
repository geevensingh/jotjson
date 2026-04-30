/**
 * Module-scoped MSAL log forwarder.
 *
 * `createMsalInstance()` runs as a factory inside `app.config.ts`,
 * which fires before any Angular service can be injected. To avoid
 * circular DI between MSAL and `LoggerService`, MSAL pushes log
 * entries into this small buffer; `LoggerService` registers a consumer
 * in its constructor, draining and forwarding subsequently.
 *
 * Privacy: only `Error`-level messages are forwarded (callers cap the
 * MSAL `LogLevel`), and PII is scrubbed via `redactPii` before any
 * string is enqueued.
 */
import { extractAadCode, redactPii, truncate } from './redact-pii';
import { TelemetryProps } from './telemetry.service';

const BUFFER_CAP = 50;
const MAX_MSG = 500;

export interface MsalBridgeEntry {
  props: TelemetryProps;
}

type Consumer = (entry: MsalBridgeEntry) => void;

class MsalBridge {
  private readonly buffer: MsalBridgeEntry[] = [];
  private consumer: Consumer | null = null;

  publish(rawMessage: string): void {
    const message = redactPii(truncate(rawMessage ?? '', MAX_MSG));
    const aadCode = extractAadCode(rawMessage ?? '');
    const entry: MsalBridgeEntry = {
      props: { message, aadCode }
    };
    if (this.consumer) {
      try {
        this.consumer(entry);
      } catch {
        // never throw out of MSAL callback
      }
      return;
    }
    if (this.buffer.length >= BUFFER_CAP) {
      this.buffer.shift();
    }
    this.buffer.push(entry);
  }

  attachConsumer(consumer: Consumer): void {
    this.consumer = consumer;
    const drained = this.buffer.splice(0, this.buffer.length);
    for (const entry of drained) {
      try {
        consumer(entry);
      } catch {
        // ignore
      }
    }
  }

  /** Test-only: reset state between tests. */
  reset(): void {
    this.buffer.length = 0;
    this.consumer = null;
  }
}

export const msalBridge = new MsalBridge();
