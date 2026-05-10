import type { LoggerService } from './logger.service';
import { setupWebVitals, type WebVitalsApi } from './web-vitals';

const TEST_APP_VERSION = 'test-version';
const TEST_BUILD_NUMBER = 'test-build-number';

type WebVitalsMetric = { value: number };
type WebVitalsCallback = (metric: WebVitalsMetric) => void;

interface FakeWebVitalsApi {
  api: WebVitalsApi;
  emitLcp: (value: number) => void;
  emitInp: (value: number) => void;
  emitCls: (value: number) => void;
}

function createFakeApi(): FakeWebVitalsApi {
  let lcpCallback: WebVitalsCallback | undefined;
  let inpCallback: WebVitalsCallback | undefined;
  let clsCallback: WebVitalsCallback | undefined;

  const invokeCallback = (
    callback: WebVitalsCallback | undefined,
    value: number,
    metricName: string,
  ): void => {
    if (!callback) {
      throw new Error(`${metricName} callback was not registered`);
    }
    callback({ value });
  };

  const api: WebVitalsApi = {
    onLCP: (callback) => {
      lcpCallback = callback;
    },
    onINP: (callback) => {
      inpCallback = callback;
    },
    onCLS: (callback) => {
      clsCallback = callback;
    },
  };

  return {
    api,
    emitLcp: (value) => invokeCallback(lcpCallback, value, 'LCP'),
    emitInp: (value) => invokeCallback(inpCallback, value, 'INP'),
    emitCls: (value) => invokeCallback(clsCallback, value, 'CLS'),
  };
}

function createLogger(): jasmine.SpyObj<LoggerService> {
  return jasmine.createSpyObj<LoggerService>('LoggerService', ['event']);
}

function createPageHideEvent(): Event {
  if (typeof PageTransitionEvent === 'function') {
    return new PageTransitionEvent('pagehide');
  }

  return new Event('pagehide');
}

describe('setupWebVitals', () => {
  afterEach(() => {
    window.dispatchEvent(createPageHideEvent());
  });

  it('registers callbacks for all three metrics', () => {
    const fakeApi = createFakeApi();
    const logger = createLogger();
    const onLcpSpy = spyOn(fakeApi.api, 'onLCP').and.callThrough();
    const onInpSpy = spyOn(fakeApi.api, 'onINP').and.callThrough();
    const onClsSpy = spyOn(fakeApi.api, 'onCLS').and.callThrough();

    setupWebVitals(fakeApi.api, logger, TEST_APP_VERSION, TEST_BUILD_NUMBER);

    expect(onLcpSpy).toHaveBeenCalledTimes(1);
    expect(onInpSpy).toHaveBeenCalledTimes(1);
    expect(onClsSpy).toHaveBeenCalledTimes(1);
  });

  it('emits all collected metrics on the first pagehide', () => {
    const fakeApi = createFakeApi();
    const logger = createLogger();
    setupWebVitals(fakeApi.api, logger, TEST_APP_VERSION, TEST_BUILD_NUMBER);

    fakeApi.emitLcp(1234.5);
    fakeApi.emitInp(56);
    fakeApi.emitCls(0.07);
    window.dispatchEvent(createPageHideEvent());

    expect(logger.event).toHaveBeenCalledOnceWith(
      'webVitals',
      { appVersion: TEST_APP_VERSION, buildNumber: TEST_BUILD_NUMBER },
      { lcpMs: 1234.5, inpMs: 56, cls: 0.07 },
    );
  });

  it('omits measurements whose callbacks have not fired', () => {
    const fakeApi = createFakeApi();
    const logger = createLogger();
    setupWebVitals(fakeApi.api, logger, TEST_APP_VERSION, TEST_BUILD_NUMBER);

    fakeApi.emitLcp(1234.5);
    window.dispatchEvent(createPageHideEvent());

    const measurements = logger.event.calls.mostRecent().args[2];
    expect(logger.event).toHaveBeenCalledOnceWith(
      'webVitals',
      { appVersion: TEST_APP_VERSION, buildNumber: TEST_BUILD_NUMBER },
      { lcpMs: 1234.5 },
    );
    expect(Object.keys(measurements ?? {})).toEqual(['lcpMs']);
  });

  it('does not emit when no metrics have fired before pagehide', () => {
    const fakeApi = createFakeApi();
    const logger = createLogger();
    setupWebVitals(fakeApi.api, logger, TEST_APP_VERSION, TEST_BUILD_NUMBER);

    window.dispatchEvent(createPageHideEvent());

    expect(logger.event).not.toHaveBeenCalled();
  });

  it('emits only once when pagehide fires more than once', () => {
    const fakeApi = createFakeApi();
    const logger = createLogger();
    setupWebVitals(fakeApi.api, logger, TEST_APP_VERSION, TEST_BUILD_NUMBER);

    fakeApi.emitLcp(1234.5);
    window.dispatchEvent(createPageHideEvent());
    window.dispatchEvent(createPageHideEvent());

    expect(logger.event).toHaveBeenCalledTimes(1);
  });
});
