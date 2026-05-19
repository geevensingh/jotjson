import { ErrorHandler, Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';
import { classifyError } from './noise-filter';

/**
 * Angular `ErrorHandler` override.
 *
 * For confirmed-benign noise (e.g. Monaco's `CancellationError` during
 * editor disposal), classify-and-suppress before `super.handleError`,
 * and emit a `logger.event('errorHandler.suppressed', { reasonBucket })`
 * counter so cancellation volume regressions stay queryable in App
 * Insights `customEvents`. Suppressed errors do NOT hit the dev
 * `console.error` either -- the cancellations are routine Monaco
 * lifecycle signals and consuming console space adds no signal.
 *
 * For everything else, preserve the default `console.error` output via
 * `super.handleError` and forward to `LoggerService.error` so it lands
 * in the App Insights `exceptions` table tagged `app.unhandled`.
 *
 * Reentrancy guard on the forward path: if `logger.error` itself
 * throws (e.g. telemetry SDK blew up mid-dispatch), swallow and do
 * NOT re-enter -- Angular ErrorHandler recursion would lock the page.
 */
@Injectable({ providedIn: 'root' })
export class TelemetryErrorHandler extends ErrorHandler {
  private readonly logger = inject(LoggerService);
  private isHandling = false;

  override handleError(error: unknown): void {
    const classification = classifyError(error);
    if (classification.kind === 'suppress') {
      try {
        this.logger.event('errorHandler.suppressed', {
          reasonBucket: classification.reasonBucket ?? 'monacoCanceled',
        });
      } catch {
        // never throw out of the global error handler
      }
      return;
    }
    super.handleError(error);
    if (this.isHandling) {
      return;
    }
    this.isHandling = true;
    try {
      this.logger.error('app.unhandled', error);
    } catch {
      // never throw out of the global error handler
    } finally {
      this.isHandling = false;
    }
  }
}
