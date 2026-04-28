import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { environment } from '../../../environments/environment';
import { BlobService } from './blob.service';

describe('BlobService', () => {
  let service: BlobService;
  let httpMock: HttpTestingController;
  const base = `${environment.apiBaseUrl}/blobs`;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()]
    });
    service = TestBed.inject(BlobService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('GETs /api/blobs/{id} when fetching by id', () => {
    service.get('abc-123').subscribe();
    const req = httpMock.expectOne(`${base}/abc-123`);
    expect(req.request.method).toBe('GET');
    // Relative path so authInterceptor (matching /api/*) attaches the bearer.
    expect(req.request.url.startsWith('/api/')).toBe(true);
    req.flush({});
  });

  it('GETs /api/blobs/{slug} when fetching by slug', () => {
    service.get('aB3dEf').subscribe();
    const req = httpMock.expectOne(`${base}/aB3dEf`);
    expect(req.request.method).toBe('GET');
    req.flush({});
  });

  it('POSTs the correct payload shape to /api/blobs on create', () => {
    service.create('{"a":1}', 'My Blob', true).subscribe();
    const req = httpMock.expectOne(base);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      content: '{"a":1}',
      title: 'My Blob',
      isPublic: true
    });
    req.flush({});
  });

  it('defaults isPublic to false and omits title when not provided on create', () => {
    service.create('{}').subscribe();
    const req = httpMock.expectOne(base);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      content: '{}',
      title: undefined,
      isPublic: false
    });
    req.flush({});
  });

  it('PUTs to /api/blobs/{id} using the UUID id (not slug)', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    service.update(id, { content: '{"x":2}', title: 't' }).subscribe();
    const req = httpMock.expectOne(`${base}/${id}`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ content: '{"x":2}', title: 't' });
    req.flush({});
  });

  it('DELETEs /api/blobs/{id}', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    service.delete(id).subscribe();
    const req = httpMock.expectOne(`${base}/${id}`);
    expect(req.request.method).toBe('DELETE');
    req.flush(null, { status: 204, statusText: 'No Content' });
  });
});
