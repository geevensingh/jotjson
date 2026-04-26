import { TestBed } from '@angular/core/testing';
import { TelemetryErrorHandler } from './error-handler';
import { LoggerService } from './logger.service';

describe('TelemetryErrorHandler', () => {
  let errSpy: jasmine.Spy;
  let consoleErr: jasmine.Spy;
  let handler: TelemetryErrorHandler;

  beforeEach(() => {
    errSpy = jasmine.createSpy('error');
    consoleErr = spyOn(console, 'error');
    TestBed.configureTestingModule({
      providers: [
        { provide: LoggerService, useValue: { error: errSpy } },
        TelemetryErrorHandler
      ]
    });
    handler = TestBed.inject(TelemetryErrorHandler);
  });

  it('forwards error to LoggerService and calls super', () => {
    const e = new Error('boom');
    handler.handleError(e);
    expect(consoleErr).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith('app.unhandled', e);
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
});
