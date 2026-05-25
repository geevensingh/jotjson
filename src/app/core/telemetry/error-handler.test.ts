import { TestBed } from '@angular/core/testing';
import { type MockInstance } from 'vitest';
import { TelemetryErrorHandler } from './error-handler';
import { LoggerService } from './logger.service';

describe('TelemetryErrorHandler', () => {
  let errSpy: MockInstance;
  let eventSpy: MockInstance;
  let consoleErr: MockInstance;
  let handler: TelemetryErrorHandler;

  beforeEach(() => {
    errSpy = vi.fn();
    eventSpy = vi.fn();
    consoleErr = vi.spyOn(console, 'error');
    TestBed.configureTestingModule({
      providers: [
        { provide: LoggerService, useValue: { error: errSpy, event: eventSpy } },
        TelemetryErrorHandler,
      ],
    });
    handler = TestBed.inject(TelemetryErrorHandler);
  });

  describe('forward path', () => {
    it('forwards error to LoggerService and calls super', () => {
      const e = new Error('boom');
      handler.handleError(e);
      expect(consoleErr).toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledWith('app.unhandled', e);
      expect(eventSpy).not.toHaveBeenCalled();
    });

    it('does not recurse when logger.error throws', () => {
      errSpy.and.throwError('telemetry boom');
      expect(() => handler.handleError(new Error('x'))).not.toThrow();
      expect(errSpy).toHaveBeenCalledTimes(1);
    });

    it('handles non-Error throws', () => {
      handler.handleError('plain string');
      expect(errSpy).toHaveBeenCalledWith('app.unhandled', 'plain string');
    });

    it('still forwards non-Canceled named errors (e.g. TypeError)', () => {
      const e = Object.assign(new Error('boom'), { name: 'TypeError' });
      handler.handleError(e);
      expect(consoleErr).toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledWith('app.unhandled', e);
      expect(eventSpy).not.toHaveBeenCalled();
    });
  });

  describe('suppress path: Monaco CancellationError', () => {
    it('emits errorHandler.suppressed counter and skips logger.error', () => {
      const e = Object.assign(new Error('Canceled'), { name: 'Canceled' });
      handler.handleError(e);
      expect(eventSpy).toHaveBeenCalledWith('errorHandler.suppressed', {
        reasonBucket: 'monacoCanceled',
      });
      expect(errSpy).not.toHaveBeenCalled();
    });

    it('does NOT call super.handleError for suppressed errors (no console.error)', () => {
      const e = Object.assign(new Error('Canceled'), { name: 'Canceled' });
      handler.handleError(e);
      expect(consoleErr).not.toHaveBeenCalled();
    });

    it('does not throw when logger.event itself throws', () => {
      eventSpy.and.throwError('event boom');
      const e = Object.assign(new Error('Canceled'), { name: 'Canceled' });
      expect(() => handler.handleError(e)).not.toThrow();
      expect(eventSpy).toHaveBeenCalledTimes(1);
      expect(errSpy).not.toHaveBeenCalled();
    });
  });
});
