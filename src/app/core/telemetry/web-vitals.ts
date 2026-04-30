/**
 * Web Vitals plumbing -- lazily wired up from
 * `AppComponent.ngOnInit` AFTER `app.boot` so the `web-vitals`
 * npm package lives in its own lazy chunk.
 *
 * The actual implementation is supplied via {@link setupWebVitals}
 * for testability; {@link initWebVitals} is the production entry
 * point that dynamically imports the `web-vitals` package and
 * forwards the live callback registrars.
 */

import type { LoggerService } from './logger.service';

/**
 * Subset of the `web-vitals` package surface that {@link setupWebVitals}
 * relies on. Intentionally narrow so unit tests can supply a
 * synthetic implementation without depending on real
 * PerformanceObserver behavior.
 */
export interface WebVitalsApi {
  onLCP: (callback: (metric: { value: number }) => void) => void;
  onINP: (callback: (metric: { value: number }) => void) => void;
  onCLS: (callback: (metric: { value: number }) => void) => void;
}

type InitWebVitalsImpl = (
  logger: LoggerService,
  appVersion: string
) => Promise<void>;

/**
 * Wires the supplied web-vitals API into a single `webVitals`
 * telemetry event emitted on `pagehide`. See the
 * `webVitals` JSDoc in `telemetry-message-ids.ts` for the event
 * shape and lifecycle.
 */
export function setupWebVitals(
  api: WebVitalsApi,
  logger: LoggerService,
  appVersion: string
): void {
  if (typeof window === 'undefined') {
    return;
  }

  let latestLcpMs: number | undefined;
  let latestInpMs: number | undefined;
  let latestCls: number | undefined;

  api.onLCP((metric) => {
    latestLcpMs = metric.value;
  });
  api.onINP((metric) => {
    latestInpMs = metric.value;
  });
  api.onCLS((metric) => {
    latestCls = metric.value;
  });

  window.addEventListener('pagehide', () => {
    if (
      latestLcpMs === undefined &&
      latestInpMs === undefined &&
      latestCls === undefined
    ) {
      return;
    }

    const measurements: Record<string, number> = {};
    if (latestLcpMs !== undefined) {
      measurements['lcpMs'] = latestLcpMs;
    }
    if (latestInpMs !== undefined) {
      measurements['inpMs'] = latestInpMs;
    }
    if (latestCls !== undefined) {
      measurements['cls'] = latestCls;
    }

    logger.event('webVitals', { appVersion }, measurements);
  }, { once: true });
}

/**
 * Production entry point. Dynamically imports `web-vitals` so the
 * package lives in its own chunk, then delegates to
 * {@link setupWebVitals}.
 */
async function realInitWebVitals(
  logger: LoggerService,
  appVersion: string
): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }

  const webVitalsModule = await import('web-vitals');
  const webVitalsApi: WebVitalsApi = {
    onLCP: (callback) => {
      webVitalsModule.onLCP(callback);
    },
    onINP: (callback) => {
      webVitalsModule.onINP(callback);
    },
    onCLS: (callback) => {
      webVitalsModule.onCLS(callback);
    }
  };

  setupWebVitals(webVitalsApi, logger, appVersion);
}

let initWebVitalsImpl: InitWebVitalsImpl = realInitWebVitals;

export function __setInitWebVitalsImplForTesting(
  impl: InitWebVitalsImpl
): void {
  initWebVitalsImpl = impl;
}

export function __resetInitWebVitalsImplForTesting(): void {
  initWebVitalsImpl = realInitWebVitals;
}

export function initWebVitals(
  logger: LoggerService,
  appVersion: string
): Promise<void> {
  return initWebVitalsImpl(logger, appVersion);
}
