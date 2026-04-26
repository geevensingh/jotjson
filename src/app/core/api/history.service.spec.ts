import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { environment } from '../../../environments/environment';
import { HistoryService } from './history.service';

describe('HistoryService', () => {
  let service: HistoryService;
  let httpMock: HttpTestingController;
  const base = `${environment.apiBaseUrl}/history`;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()]
    });
    service = TestBed.inject(HistoryService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('GETs /api/history with no params by default', () => {
    let received: unknown;
    service.list().subscribe((page) => (received = page));
    const req = httpMock.expectOne((r) => r.url === base && r.method === 'GET');
    expect(req.request.params.keys().length).toBe(0);
    req.flush({ entries: [] });
    expect(received).toEqual({ entries: [] });
  });

  it('forwards pageSize and continuationToken as query params', () => {
    service.list({ pageSize: 25, continuationToken: 'abc' }).subscribe();
    const req = httpMock.expectOne((r) => r.url === base && r.method === 'GET');
    expect(req.request.params.get('pageSize')).toBe('25');
    expect(req.request.params.get('continuationToken')).toBe('abc');
    req.flush({ entries: [] });
  });

  it('DELETEs /api/history when clearing', () => {
    service.clear().subscribe();
    const req = httpMock.expectOne(base);
    expect(req.request.method).toBe('DELETE');
    req.flush(null, { status: 204, statusText: 'No Content' });
  });

  it('POSTs a paste event with action="pasted"', () => {
    service.recordPaste({ slug: 'abc', title: 'Notes' }).subscribe();
    const req = httpMock.expectOne(base);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      action: 'pasted',
      slug: 'abc',
      title: 'Notes'
    });
    req.flush({ id: 'h-1' });
  });

  it('omits optional fields from the POST body when not provided', () => {
    service.recordPaste().subscribe();
    const req = httpMock.expectOne(base);
    expect(req.request.body).toEqual({ action: 'pasted' });
    req.flush(null, { status: 204, statusText: 'No Content' });
  });
});
