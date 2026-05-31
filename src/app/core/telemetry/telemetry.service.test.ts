import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { environment } from '../../../environments/environment';
import { normalizeError } from './normalize-error';
import { TelemetryService } from './telemetry.service';

describe('TelemetryService', () => {
  let originalCs: string | undefined;

  beforeEach(() => {
    originalCs = environment.appInsightsConnectionString;
  });

  afterEach(() => {
    environment.appInsightsConnectionString = originalCs;
  });

  function make(): TelemetryService {
    TestBed.resetTestingModule();
    return TestBed.inject(TelemetryService);
  }

  it('disables when connection string is empty', async () => {
    environment.appInsightsConnectionString = '';
    const svc = make();
    await svc.connect();
    expect(svc.connectState).toBe('disabled');
    expect(svc.isConnected).toBe(false);
    expect(svc.isDisabled).toBe(true);
  });

  it('disables when connection string is whitespace only', async () => {
    environment.appInsightsConnectionString = '   ';
    const svc = make();
    await svc.connect();
    expect(svc.connectState).toBe('disabled');
  });

  it('connect() is idempotent', async () => {
    environment.appInsightsConnectionString = '';
    const svc = make();
    const a = svc.connect();
    const b = svc.connect();
    expect(a).toBe(b);
    await a;
    await svc.connect();
    expect(svc.connectState).toBe('disabled');
  });

  it('track* methods are no-ops when disabled', async () => {
    environment.appInsightsConnectionString = '';
    const svc = make();
    await svc.connect();
    expect(() => svc.trackEvent('app.unhandled')).not.toThrow();
    expect(() => svc.trackException(normalizeError(new Error('x')))).not.toThrow();
    expect(() => svc.trackPageView('Home', '/')).not.toThrow();
  });

  it('flush() is a no-op promise when disabled (no throw, resolves)', async () => {
    environment.appInsightsConnectionString = '';
    const svc = make();
    await svc.connect();
    await expect(svc.flush()).resolves.toBeUndefined();
  });

  it('flush() resolves before connect() even completes (no buffer)', async () => {
    environment.appInsightsConnectionString = '';
    const svc = make();
    // Pre-connect: appInsights is null so flush is a no-op.
    await expect(svc.flush()).resolves.toBeUndefined();
  });

  it('caches setUser before connect; applies safely after disabled', async () => {
    environment.appInsightsConnectionString = '';
    const svc = make();
    svc.setUser('aeeb2cf4-5305-4a6f-85e6-6b97d75bd259');
    await svc.connect();
    // Should be disabled, so no SDK to apply to - but no throw either.
    expect(svc.isDisabled).toBe(true);
  });

  it('normalizeError + trackException accepts http errors', async () => {
    environment.appInsightsConnectionString = '';
    const svc = make();
    await svc.connect();
    const err = new HttpErrorResponse({
      url: '/api/x?secret=yes',
      status: 500,
    });
    expect(() => svc.trackException(normalizeError(err, { method: 'GET' }))).not.toThrow();
  });
});
