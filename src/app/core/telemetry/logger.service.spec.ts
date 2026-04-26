import { TestBed } from '@angular/core/testing';
import { environment } from '../../../environments/environment';
import { LoggerService } from './logger.service';
import { TelemetryService } from './telemetry.service';
import { msalBridge } from './msal-bridge';
import { normalizeError } from './normalize-error';

describe('LoggerService', () => {
  let originalCs: string | undefined;
  let trackException: jasmine.Spy;
  let trackTrace: jasmine.Spy;

  beforeEach(() => {
    originalCs = environment.appInsightsConnectionString;
    environment.appInsightsConnectionString = '';
    msalBridge.reset();
    spyOn(console, 'info');
    spyOn(console, 'warn');
    spyOn(console, 'error');
  });

  afterEach(() => {
    environment.appInsightsConnectionString = originalCs;
  });

  function makeWithFakeTelemetry(disabled: boolean) {
    TestBed.resetTestingModule();
    const telemetry: Partial<TelemetryService> = {
      connect: () => Promise.resolve(),
      get isDisabled() {
        return disabled;
      },
      get isConnected() {
        return !disabled;
      }
    };
    trackException = jasmine.createSpy('trackException');
    trackTrace = jasmine.createSpy('trackTrace');
    (telemetry as TelemetryService).trackException = trackException;
    (telemetry as TelemetryService).trackTrace = trackTrace;
    TestBed.configureTestingModule({
      providers: [{ provide: TelemetryService, useValue: telemetry }]
    });
    return TestBed.inject(LoggerService);
  }

  it('mirrors all severities to console even before connect', () => {
    const log = makeWithFakeTelemetry(false);
    log.info('app.unhandled');
    log.warn('api.error');
    log.error('app.unhandled', new Error('boom'));
    expect(console.info).toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it('flushes buffered entries on connect in FIFO order', async () => {
    const log = makeWithFakeTelemetry(false);
    log.info('app.unhandled', { n: 1 });
    log.warn('api.error', { n: 2 });
    log.error('app.unhandled', new Error('three'));
    await log.connect();
    // 2 traces (info, warn) + 1 exception (error)
    expect(trackTrace).toHaveBeenCalledTimes(2);
    expect(trackException).toHaveBeenCalledTimes(1);
    const firstCall = (trackTrace.calls.argsFor(0)[2] as Record<string, unknown>) ?? {};
    const secondCall = (trackTrace.calls.argsFor(1)[2] as Record<string, unknown>) ?? {};
    expect(firstCall['n']).toBe(1);
    expect(secondCall['n']).toBe(2);
  });

  it('drops oldest entry when buffer overflows', async () => {
    const log = makeWithFakeTelemetry(false);
    for (let i = 0; i < 105; i++) {
      log.info('app.unhandled', { i });
    }
    await log.connect();
    // We pushed 105; cap is 100; oldest 5 should be dropped.
    expect(trackTrace).toHaveBeenCalledTimes(100);
    const firstProps = trackTrace.calls.argsFor(0)[2] as Record<string, unknown>;
    expect(firstProps['i']).toBe(5);
  });

  it('drops the buffer and never dispatches when disabled', async () => {
    const log = makeWithFakeTelemetry(true);
    log.info('app.unhandled', { x: 1 });
    log.warn('api.error', { x: 2 });
    await log.connect();
    log.info('app.unhandled', { x: 3 });
    expect(trackTrace).not.toHaveBeenCalled();
    expect(trackException).not.toHaveBeenCalled();
  });

  it('routes errors via trackException using NormalizedError shape', async () => {
    const log = makeWithFakeTelemetry(false);
    log.error('home.save.failed', new Error('failed for alice@x.io'));
    await log.connect();
    expect(trackException).toHaveBeenCalledTimes(1);
    const [normalized, props] = trackException.calls.argsFor(0);
    expect(normalized.kind).toBe('error');
    expect(normalized.message).toContain('<email>');
    expect(props.messageId).toBe('home.save.failed');
  });

  it('forwards null error as a trace, not exception', async () => {
    const log = makeWithFakeTelemetry(false);
    log.error('app.unhandled', null);
    await log.connect();
    expect(trackTrace).toHaveBeenCalledTimes(1);
    expect(trackException).not.toHaveBeenCalled();
  });

  it('does not throw when telemetry.dispatch throws', async () => {
    const log = makeWithFakeTelemetry(false);
    trackTrace = ((): void => {
      throw new Error('boom');
    }) as unknown as jasmine.Spy;
    (TestBed.inject(TelemetryService) as TelemetryService).trackTrace = trackTrace;
    log.info('app.unhandled');
    await expectAsync(log.connect()).toBeResolved();
  });

  it('drains MSAL bridge buffer once consumer is attached', async () => {
    msalBridge.publish("user 'bob@x.io' must reauthenticate; AADSTS50058");
    const log = makeWithFakeTelemetry(false);
    void log;
    await log.connect();
    expect(trackTrace).toHaveBeenCalled();
    const args = trackTrace.calls.argsFor(0);
    const messageId = args[0] as string;
    const props = (args[2] as Record<string, unknown>) ?? {};
    expect(messageId).toBe('msal.error');
    expect(String(props['message'])).toContain('<email>');
    expect(props['aadCode']).toBe('AADSTS50058');
  });

  it('reads and clears sessionStorage boot error on connect', async () => {
    sessionStorage.setItem(
      'jotjson.bootErr',
      JSON.stringify({ name: 'BootError', message: 'boot failed' })
    );
    const log = makeWithFakeTelemetry(false);
    await log.connect();
    expect(sessionStorage.getItem('jotjson.bootErr')).toBeNull();
    // The boot exception is dispatched via trackException.
    const calls = trackException.calls.allArgs();
    const bootCall = calls.find((args) => {
      const props = args[1] as Record<string, unknown>;
      return props && props['messageId'] === 'boot.failed';
    });
    expect(bootCall).toBeDefined();
  });

  it('produces normalized HttpError when given HTTP context', async () => {
    const { HttpErrorResponse } = await import('@angular/common/http');
    const err = new HttpErrorResponse({ url: '/api/x?secret', status: 500 });
    const log = makeWithFakeTelemetry(false);
    log.error('api.error', err, undefined, { method: 'GET', pathTemplate: '/api/x' });
    await log.connect();
    expect(trackException).toHaveBeenCalledTimes(1);
    const [normalized] = trackException.calls.argsFor(0);
    expect(normalized.kind).toBe('http');
    expect(normalized.pathTemplate).toBe('/api/x');
    void normalizeError; // silence unused-import lint if any
  });
});
