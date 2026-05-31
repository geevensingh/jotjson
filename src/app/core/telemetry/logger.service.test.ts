import { TestBed } from '@angular/core/testing';
import { type Mock } from 'vitest';
import { environment } from '../../../environments/environment';
import { LoggerService } from './logger.service';
import { msalBridge } from './msal-bridge';
import { normalizeError } from './normalize-error';
import { __resetSwRegistrationForTesting, SW_EVENTS_KEY } from './sw-registration';
import { TelemetryService } from './telemetry.service';

describe('LoggerService', () => {
  let originalCs: string | undefined;
  let trackEvent: Mock;
  let trackException: Mock;
  let trackTrace: Mock;

  beforeEach(() => {
    originalCs = environment.appInsightsConnectionString;
    environment.appInsightsConnectionString = '';
    __resetSwRegistrationForTesting();
    msalBridge.reset();
    vi.spyOn(console, 'info');
    vi.spyOn(console, 'warn');
    vi.spyOn(console, 'error');
  });

  afterEach(() => {
    environment.appInsightsConnectionString = originalCs;
    __resetSwRegistrationForTesting();
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
      },
    };
    trackEvent = vi.fn();
    trackException = vi.fn();
    trackTrace = vi.fn();
    (telemetry as TelemetryService).trackEvent = trackEvent;
    (telemetry as TelemetryService).trackException = trackException;
    (telemetry as TelemetryService).trackTrace = trackTrace;
    TestBed.configureTestingModule({
      providers: [{ provide: TelemetryService, useValue: telemetry }],
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
    const firstCall = (trackTrace.mock.calls[0][2] as Record<string, unknown>) ?? {};
    const secondCall = (trackTrace.mock.calls[1][2] as Record<string, unknown>) ?? {};
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
    const firstProps = trackTrace.mock.calls[0][2] as Record<string, unknown>;
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
    const [normalized, props] = trackException.mock.calls[0];
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
    }) as unknown as Mock;
    (TestBed.inject(TelemetryService) as TelemetryService).trackTrace = trackTrace;
    log.info('app.unhandled');
    await expect(log.connect()).resolves.toBeUndefined();
  });

  it('drains MSAL bridge buffer once consumer is attached', async () => {
    msalBridge.publish("user 'bob@x.io' must reauthenticate; AADSTS50058");
    const log = makeWithFakeTelemetry(false);
    void log;
    await log.connect();
    expect(trackTrace).toHaveBeenCalled();
    const args = trackTrace.mock.calls[0];
    const messageId = args[0] as string;
    const props = (args[2] as Record<string, unknown>) ?? {};
    expect(messageId).toBe('msal.error');
    expect(String(props['message'])).toContain('<email>');
    expect(props['aadCode']).toBe('AADSTS50058');
  });

  it('reads and clears sessionStorage boot error on connect', async () => {
    sessionStorage.setItem(
      'jotjson.bootErr',
      JSON.stringify({ name: 'BootError', message: 'boot failed' }),
    );
    const log = makeWithFakeTelemetry(false);
    await log.connect();
    expect(sessionStorage.getItem('jotjson.bootErr')).toBeNull();
    // The boot exception is dispatched via trackException.
    const calls = trackException.mock.calls;
    const bootCall = calls.find((args) => {
      const props = args[1] as Record<string, unknown>;
      return props && props['messageId'] === 'boot.failed';
    });
    expect(bootCall).toBeDefined();
  });

  it('reads and clears sessionStorage msal bridge error on connect', async () => {
    sessionStorage.setItem(
      'jotjson.msalBridgeErr',
      JSON.stringify({ name: 'AuthError', message: 'No payload found in URL' }),
    );
    const log = makeWithFakeTelemetry(false);
    await log.connect();
    expect(sessionStorage.getItem('jotjson.msalBridgeErr')).toBeNull();
    const calls = trackException.mock.calls;
    const bridgeCall = calls.find((args) => {
      const props = args[1] as Record<string, unknown>;
      return props && props['messageId'] === 'auth.msalBridge.failed';
    });
    expect(bridgeCall).toBeDefined();
    const [normalized] = bridgeCall ?? [];
    expect((normalized as { name?: string }).name).toBe('AuthError');
    expect((normalized as { message?: string }).message).toBe('No payload found in URL');
  });

  it('replays bridge error even when boot error slot is empty', async () => {
    // Regression guard: an early `return` in flushSessionStorage's
    // boot-error block must not skip the bridge-error block when no
    // boot error is queued.
    sessionStorage.removeItem('jotjson.bootErr');
    sessionStorage.setItem(
      'jotjson.msalBridgeErr',
      JSON.stringify({ name: 'AuthError', message: 'bridge failed' }),
    );
    const log = makeWithFakeTelemetry(false);
    await log.connect();
    expect(sessionStorage.getItem('jotjson.msalBridgeErr')).toBeNull();
    const calls = trackException.mock.calls;
    const bridgeCall = calls.find((args) => {
      const props = args[1] as Record<string, unknown>;
      return props && props['messageId'] === 'auth.msalBridge.failed';
    });
    expect(bridgeCall).toBeDefined();
  });

  it('produces normalized HttpError when given HTTP context', async () => {
    const { HttpErrorResponse } = await import('@angular/common/http');
    const err = new HttpErrorResponse({ url: '/api/x?secret', status: 500 });
    const log = makeWithFakeTelemetry(false);
    log.error('api.error', err, undefined, { method: 'GET', pathTemplate: '/api/x' });
    await log.connect();
    expect(trackException).toHaveBeenCalledTimes(1);
    const [normalized] = trackException.mock.calls[0];
    expect(normalized.kind).toBe('http');
    expect(normalized.pathTemplate).toBe('/api/x');
    void normalizeError; // silence unused-import lint if any
  });

  describe('event()', () => {
    it('mirrors to console.info with measurements before connect', () => {
      const log = makeWithFakeTelemetry(false);
      log.event('app.unhandled', { foo: 'bar' }, { ms: 12 });
      expect(console.info).toHaveBeenCalledWith(
        '[event:app.unhandled]',
        { foo: 'bar' },
        { ms: 12 },
      );
    });

    it('does not dispatch before connect (only buffers)', () => {
      const log = makeWithFakeTelemetry(false);
      log.event('app.unhandled', { foo: 'bar' }, { ms: 12 });
      expect(trackEvent).not.toHaveBeenCalled();
      expect(trackTrace).not.toHaveBeenCalled();
      expect(trackException).not.toHaveBeenCalled();
    });

    it('drains buffered events to trackEvent on connect with props + measurements preserved', async () => {
      const log = makeWithFakeTelemetry(false);
      log.event('app.unhandled', { kind: 'a' }, { n: 1 });
      log.event('api.error', { kind: 'b' }, { n: 2 });
      await log.connect();
      expect(trackEvent).toHaveBeenCalledTimes(2);
      const [name1, props1, meas1] = trackEvent.mock.calls[0];
      const [name2, props2, meas2] = trackEvent.mock.calls[1];
      expect(name1).toBe('app.unhandled');
      expect(props1).toEqual({ kind: 'a' });
      expect(meas1).toEqual({ n: 1 });
      expect(name2).toBe('api.error');
      expect(props2).toEqual({ kind: 'b' });
      expect(meas2).toEqual({ n: 2 });
    });

    it('dispatches immediately when called after connect', async () => {
      const log = makeWithFakeTelemetry(false);
      await log.connect();
      log.event('app.unhandled', { x: 1 }, { y: 2 });
      expect(trackEvent).toHaveBeenCalledTimes(1);
      const [name, props, meas] = trackEvent.mock.calls[0];
      expect(name).toBe('app.unhandled');
      expect(props).toEqual({ x: 1 });
      expect(meas).toEqual({ y: 2 });
    });

    it('drops buffered events and never dispatches when disabled', async () => {
      const log = makeWithFakeTelemetry(true);
      log.event('app.unhandled', { x: 1 });
      await log.connect();
      log.event('app.unhandled', { x: 2 });
      expect(trackEvent).not.toHaveBeenCalled();
    });

    it('shares the buffer cap with traces (oldest evicted on overflow)', async () => {
      const log = makeWithFakeTelemetry(false);
      // Mix events and traces to confirm they share one FIFO buffer.
      for (let counter = 0; counter < 60; counter++) {
        log.event('app.unhandled', { counter });
      }
      for (let counter = 0; counter < 60; counter++) {
        log.info('app.unhandled', { counter });
      }
      await log.connect();
      // 120 entries pushed, cap 100 -> oldest 20 events dropped, 40
      // events kept + 60 traces = 100 dispatches total.
      expect(trackEvent).toHaveBeenCalledTimes(40);
      expect(trackTrace).toHaveBeenCalledTimes(60);
      const firstEventProps = trackEvent.mock.calls[0][1] as Record<string, unknown>;
      expect(firstEventProps['counter']).toBe(20);
    });

    it('does not throw when trackEvent throws', async () => {
      const log = makeWithFakeTelemetry(false);
      trackEvent = ((): void => {
        throw new Error('boom');
      }) as unknown as Mock;
      (TestBed.inject(TelemetryService) as TelemetryService).trackEvent = trackEvent;
      log.event('app.unhandled');
      await expect(log.connect()).resolves.toBeUndefined();
    });
  });

  describe('quiet console mirror (QUIET_CONSOLE_IDS)', () => {
    it('does NOT mirror errorHandler.suppressed events to console.info', () => {
      const log = makeWithFakeTelemetry(false);
      log.event('errorHandler.suppressed', { reasonBucket: 'monacoCanceled' });
      expect(console.info).not.toHaveBeenCalled();
    });

    it('still dispatches errorHandler.suppressed to App Insights after connect', async () => {
      const log = makeWithFakeTelemetry(false);
      log.event('errorHandler.suppressed', { reasonBucket: 'monacoCanceled' });
      await log.connect();
      expect(trackEvent).toHaveBeenCalledTimes(1);
      const [name, props] = trackEvent.mock.calls[0];
      expect(name).toBe('errorHandler.suppressed');
      expect(props as Record<string, unknown>).toEqual({ reasonBucket: 'monacoCanceled' });
    });

    it('does not affect other event IDs (regression guard)', () => {
      const log = makeWithFakeTelemetry(false);
      log.event('app.unhandled', { foo: 'bar' });
      expect(console.info).toHaveBeenCalledWith('[event:app.unhandled]', { foo: 'bar' }, {});
    });

    it('isolates from a leaked sw event queue in sessionStorage (CI flake regression)', async () => {
      // Reproduce the cross-spec leak that caused CI flake #26133806241:
      // a prior spec leaves sw.* events in sessionStorage. Without the
      // beforeEach reset (Layer B), loggerConnected stays true from a
      // prior connect() call and attachSwEventDirectEmit short-circuits.
      // With the fix, loggerConnected is reset to false so the drain
      // path activates and processes the seeded events deterministically.
      sessionStorage.setItem(
        SW_EVENTS_KEY,
        JSON.stringify([
          {
            name: 'sw.registered',
            props: { version: 'x', sha: 'y', branch: 'z', buildNumber: 'n' },
            timestamp: 0,
          },
          {
            name: 'sw.activated',
            props: { version: 'x', sha: 'y', branch: 'z', buildNumber: 'n' },
            timestamp: 1,
          },
        ]),
      );

      const log = makeWithFakeTelemetry(false);
      log.event('errorHandler.suppressed', { reasonBucket: 'monacoCanceled' });
      await log.connect();

      // 2 drained sw.* events + 1 buffered errorHandler.suppressed = 3
      expect(trackEvent).toHaveBeenCalledTimes(3);
      expect(trackEvent.mock.calls[0][0]).toBe('sw.registered');
      expect(trackEvent.mock.calls[1][0]).toBe('sw.activated');
      expect(trackEvent.mock.calls[2][0]).toBe('errorHandler.suppressed');
    });
  });
});
