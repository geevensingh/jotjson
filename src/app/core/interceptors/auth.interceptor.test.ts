import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AuthService } from '../auth/auth.service';
import { authInterceptor } from './auth.interceptor';

function fakeAuthService(opts: {
  signedIn: boolean;
  token: string | null;
}): Pick<AuthService, 'isSignedIn' | 'acquireTokenSilent'> {
  return {
    isSignedIn: (() => opts.signedIn) as AuthService['isSignedIn'],
    acquireTokenSilent: () => Promise.resolve(opts.token),
  };
}

describe('authInterceptor', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;

  function setup(auth: Partial<AuthService>) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: auth },
      ],
    });
    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
  }

  afterEach(() => {
    httpMock?.verify();
  });

  it('attaches Bearer header on /api/* when signed in and token is available', async () => {
    setup(fakeAuthService({ signedIn: true, token: 'abc.def.ghi' }));
    const observed: string[] = [];
    http.get('/api/blobs/1').subscribe();
    // Allow the interceptor's from(Promise) to flush.
    await Promise.resolve();
    const req = httpMock.expectOne('/api/blobs/1');
    observed.push(req.request.headers.get('X-Jotjson-Authorization') ?? '');
    req.flush({});
    expect(observed[0]).toBe('Bearer abc.def.ghi');
  });

  it('does not attach a header when signed in but silent token returns null', async () => {
    setup(fakeAuthService({ signedIn: true, token: null }));
    http.get('/api/public').subscribe();
    await Promise.resolve();
    const req = httpMock.expectOne('/api/public');
    expect(req.request.headers.has('X-Jotjson-Authorization')).toBe(false);
    req.flush({});
  });

  it('does not attach a header and does not call acquireTokenSilent when anonymous', async () => {
    const spy = vi.fn().mockResolvedValue(null);
    setup({
      isSignedIn: (() => false) as AuthService['isSignedIn'],
      acquireTokenSilent: spy,
    });
    http.get('/api/public').subscribe();
    const req = httpMock.expectOne('/api/public');
    expect(req.request.headers.has('X-Jotjson-Authorization')).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    req.flush({});
  });

  it('passes non-/api requests through untouched (no Authorization header even if signed in)', () => {
    setup(fakeAuthService({ signedIn: true, token: 'abc' }));
    http.get('/public-assets/config.json').subscribe();
    const req = httpMock.expectOne('/public-assets/config.json');
    expect(req.request.headers.has('X-Jotjson-Authorization')).toBe(false);
    req.flush({});
  });

  it('never redirects the user on silent-token failure (caller sees 401 and decides)', async () => {
    setup(fakeAuthService({ signedIn: true, token: null }));
    let caught: unknown = null;
    http.get('/api/protected').subscribe({
      error: (e) => (caught = e),
    });
    await Promise.resolve();
    const req = httpMock.expectOne('/api/protected');
    // Verify the request still went out (interceptor did not redirect away).
    expect(req.request.headers.has('X-Jotjson-Authorization')).toBe(false);
    req.flush('unauthorized', { status: 401, statusText: 'Unauthorized' });
    expect(caught).toBeTruthy();
  });

  it('threads dev:<userId> tokens through to Bearer dev:<userId>', async () => {
    setup(fakeAuthService({ signedIn: true, token: 'dev:dev-user-1' }));
    http.get('/api/me').subscribe();
    await Promise.resolve();
    const req = httpMock.expectOne('/api/me');
    expect(req.request.headers.get('X-Jotjson-Authorization')).toBe('Bearer dev:dev-user-1');
    req.flush({});
  });
});
