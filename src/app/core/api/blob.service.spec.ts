import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { environment } from '../../../environments/environment';
import { BlobService, type BlobSyncEvent } from './blob.service';
import type { BlobHighlight, JsonBlob } from './models';

describe('BlobService', () => {
  let service: BlobService;
  let httpMock: HttpTestingController;
  const base = `${environment.apiBaseUrl}/blobs`;
  const id = '550e8400-e29b-41d4-a716-446655440000';
  const slug = 'aB3dEf';
  const highlight: BlobHighlight = { path: '$.x', color: '#ffeb3b', cascade: false };

  function makeBlob(overrides: Partial<JsonBlob> = {}): JsonBlob {
    return {
      id,
      slug,
      content: '{"a":1}',
      title: 'My Blob',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ownerId: 'owner-1',
      isPublic: false,
      version: 1,
      ...overrides,
    };
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
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
    req.flush(makeBlob({ id: 'abc-123' }));
  });

  it('GETs /api/blobs/{slug} when fetching by slug', () => {
    service.get(slug).subscribe();
    const req = httpMock.expectOne(`${base}/${slug}`);
    expect(req.request.method).toBe('GET');
    req.flush(makeBlob());
  });

  it('POSTs the correct payload shape to /api/blobs on create', () => {
    service.create('{"a":1}', 'My Blob', true).subscribe();
    const req = httpMock.expectOne(base);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      content: '{"a":1}',
      title: 'My Blob',
      isPublic: true,
    });
    req.flush(makeBlob({ isPublic: true }));
  });

  it('defaults isPublic to false and omits title when not provided on create', () => {
    service.create('{}').subscribe();
    const req = httpMock.expectOne(base);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      content: '{}',
      title: undefined,
      isPublic: false,
    });
    req.flush(makeBlob({ content: '{}' }));
  });

  it('uses the cached version as If-Match on PUT by UUID id', () => {
    service.get(id).subscribe();
    httpMock.expectOne(`${base}/${id}`).flush(makeBlob({ version: 7 }));

    service.update(id, { content: '{"x":2}', title: 't' }).subscribe();
    const req = httpMock.expectOne(`${base}/${id}`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.headers.get('If-Match')).toBe('"7"');
    expect(req.request.body).toEqual({ content: '{"x":2}', title: 't' });
    req.flush(makeBlob({ content: '{"x":2}', title: 't', version: 8 }));
  });

  it('caches versions from list results', () => {
    service.list().subscribe();
    httpMock.expectOne(base).flush([makeBlob({ version: 5 })]);

    service.update(id, { title: 'from list' }).subscribe();
    const req = httpMock.expectOne(`${base}/${id}`);
    expect(req.request.headers.get('If-Match')).toBe('"5"');
    req.flush(makeBlob({ title: 'from list', version: 6 }));
  });

  it('caches versions from create results', () => {
    service.create('{}').subscribe();
    httpMock.expectOne(base).flush(makeBlob({ content: '{}', version: 3 }));

    service.update(id, { title: 'created then updated' }).subscribe();
    const req = httpMock.expectOne(`${base}/${id}`);
    expect(req.request.headers.get('If-Match')).toBe('"3"');
    req.flush(makeBlob({ title: 'created then updated', version: 4 }));
  });

  for (const testCase of [
    { name: 'content', patch: { content: '{"x":2}' } },
    { name: 'title', patch: { title: 'Renamed' } },
    { name: 'isPublic', patch: { isPublic: true } },
    { name: 'highlights', patch: { highlights: [highlight] } },
  ] satisfies Array<{
    name: string;
    patch: Partial<Pick<JsonBlob, 'content' | 'title' | 'isPublic' | 'highlights'>>;
  }>) {
    it(`includes If-Match for ${testCase.name} updates`, () => {
      service.get(id).subscribe();
      httpMock.expectOne(`${base}/${id}`).flush(makeBlob({ version: 7 }));

      service.update(id, testCase.patch).subscribe();
      const req = httpMock.expectOne(`${base}/${id}`);
      expect(req.request.method).toBe('PUT');
      expect(req.request.headers.get('If-Match')).toBe('"7"');
      expect(req.request.body).toEqual(testCase.patch);
      req.flush(makeBlob({ ...testCase.patch, version: 8 }));
    });
  }

  it('emits a conflict event and refetches after a 412', () => {
    const events: BlobSyncEvent[] = [];
    let errorStatus: number | undefined;
    service.events$.subscribe((event) => events.push(event));
    service.get(id).subscribe();
    httpMock.expectOne(`${base}/${id}`).flush(makeBlob({ version: 7 }));

    service.update(id, { content: '{"local":true}' }).subscribe({
      error: (error: { status?: number }) => {
        errorStatus = error.status;
      },
    });
    const putRequest = httpMock.expectOne(`${base}/${id}`);
    expect(putRequest.request.headers.get('If-Match')).toBe('"7"');
    putRequest.flush({ error: 'conflict' }, { status: 412, statusText: 'Precondition Failed' });

    const refreshed = makeBlob({ content: '{"remote":true}', version: 9 });
    httpMock.expectOne(`${base}/${id}`).flush(refreshed);

    expect(events).toEqual([{ kind: 'conflict', id, blob: refreshed, status: 412 }]);
    expect(errorStatus).toBe(412);
  });

  it('uses the refetched version after a 412 conflict', () => {
    service.get(id).subscribe();
    httpMock.expectOne(`${base}/${id}`).flush(makeBlob({ version: 7 }));

    service.update(id, { title: 'local' }).subscribe({ error: () => undefined });
    httpMock
      .expectOne(`${base}/${id}`)
      .flush({ error: 'conflict' }, { status: 412, statusText: 'Precondition Failed' });
    httpMock.expectOne(`${base}/${id}`).flush(makeBlob({ title: 'remote', version: 9 }));

    service.update(id, { title: 'replace remote' }).subscribe();
    const retryRequest = httpMock.expectOne(`${base}/${id}`);
    expect(retryRequest.request.headers.get('If-Match')).toBe('"9"');
    retryRequest.flush(makeBlob({ title: 'replace remote', version: 10 }));
  });

  it('DELETEs /api/blobs/{id}', () => {
    service.delete(id).subscribe();
    const req = httpMock.expectOne(`${base}/${id}`);
    expect(req.request.method).toBe('DELETE');
    req.flush(null, { status: 204, statusText: 'No Content' });
  });
});
