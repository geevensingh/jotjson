import { TelemetryClient } from 'applicationinsights';
import {
  __resetTelemetryInitForTesting,
  __setTelemetryClientForTesting,
  trackEvent
} from './telemetry';

function makeMockClient(): {
  client: TelemetryClient;
  trackEventMock: jest.Mock;
} {
  const trackEventMock = jest.fn();
  const partialClient: Partial<TelemetryClient> = {
    trackEvent: trackEventMock
  };

  return {
    client: partialClient as TelemetryClient,
    trackEventMock
  };
}

describe('shared/telemetry Application Insights events', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    __resetTelemetryInitForTesting();
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    __resetTelemetryInitForTesting();
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  });

  it('no-ops without an Application Insights connection string', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(() => trackEvent('test.event')).not.toThrow();
  });

  it('emits via the injected test client', () => {
    const { client, trackEventMock } = makeMockClient();

    __setTelemetryClientForTesting(client);
    trackEvent('test.event', { foo: 'bar' }, { count: 1 });

    expect(trackEventMock).toHaveBeenCalledWith({
      name: 'test.event',
      properties: { foo: 'bar' },
      measurements: { count: 1 }
    });
  });

  it('warns once when the connection string is missing', () => {
    const warnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    trackEvent('test.event.one');
    trackEvent('test.event.two');
    trackEvent('test.event.three');

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('re-arms the missing connection string warning after reset', () => {
    const warnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    trackEvent('test.event.beforeReset');
    __resetTelemetryInitForTesting();
    trackEvent('test.event.afterReset');

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  describe('when a connection string is configured', () => {
    beforeEach(() => {
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
        'InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example/';
    });

    it('prefers the test override over the configured SDK client', () => {
      const { client, trackEventMock } = makeMockClient();

      __setTelemetryClientForTesting(client);
      trackEvent('test.event');

      expect(trackEventMock).toHaveBeenCalledTimes(1);
    });
  });
});
