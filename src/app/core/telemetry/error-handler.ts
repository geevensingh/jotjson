import { ErrorHandler, Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';

/**
 * Angular `ErrorHandler` override that preserves the default
 * console-stack output (via `super.handleError`) and ALSO forwards the
 * error to `LoggerService` for telemetry.
 *
 * Reentrancy guard: if `logger.error()` itself throws (e.g. because
 * telemetry blew up mid-dispatch), we swallow the throw and DO NOT
 * re-enter - otherwise an Angular `ErrorHandler` recursion can lock
 * the page.
 */
@Injectable({ providedIn: 'root' })
export class TelemetryErrorHandler extends ErrorHandler {
  private readonly logger = inject(LoggerService);
  private isHandling = false;

  override handleError(error: unknown): void {
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
