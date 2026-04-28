import {
  HttpClient,
  provideHttpClient,
  withInterceptors
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { LoggerService } from '../telemetry/logger.service';
import { errorInterceptor } from './error.interceptor';

describe('errorInterceptor', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let loggerSpy: jasmine.SpyObj<LoggerService>;

  beforeEach(() => {
    loggerSpy = jasmine.createSpyObj<LoggerService>('LoggerService', [
      'info',
      'warn',
      'error'
    ]);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        { provide: LoggerService, useValue: loggerSpy }
      ]
    });
    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('logs api.error via LoggerService.warn with the path sanitized (query stripped)', () => {
    http.get('/api/history?q=secret&continuationToken=abc').subscribe({
      error: () => undefined
    });
    const req = httpMock.expectOne(
      '/api/history?q=secret&continuationToken=abc'
    );
    req.flush('boom', { status: 500, statusText: 'Server Error' });

    expect(loggerSpy.warn).toHaveBeenCalledTimes(1);
    const [messageId, props] = loggerSpy.warn.calls.mostRecent().args;
    expect(messageId).toBe('api.error');
    expect(props).toEqual(
      jasmine.objectContaining({
        method: 'GET',
        pathTemplate: '/api/history',
        status: 500
      })
    );
    // Ensure query string did not leak into the logged path.
    expect((props as { pathTemplate?: string }).pathTemplate).not.toContain(
      '?'
    );
    expect((props as { pathTemplate?: string }).pathTemplate).not.toContain(
      'secret'
    );
  });

  it('propagates the error downstream (does not swallow)', () => {
    let caught: unknown = null;
    let nextCalled = false;
    http.get('/api/blobs/missing').subscribe({
      next: () => (nextCalled = true),
      error: (err) => (caught = err)
    });
    const req = httpMock.expectOne('/api/blobs/missing');
    req.flush('not found', { status: 404, statusText: 'Not Found' });

    expect(nextCalled).toBe(false);
    expect(caught).toBeTruthy();
  });

  it('logs the status code matching the response status', () => {
    http.get('/api/me').subscribe({ error: () => undefined });
    const req = httpMock.expectOne('/api/me');
    req.flush('unauthorized', { status: 401, statusText: 'Unauthorized' });

    const props = loggerSpy.warn.calls.mostRecent().args[1] as {
      status: number;
    };
    expect(props.status).toBe(401);
  });
});
