import {
  HttpEventType,
  HttpHeaderResponse,
  HttpHeaders,
  HttpResponse,
  provideHttpClient,
  type HttpEvent,
} from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { environment } from '../../../environments/environment';
import { BlobService, type BlobFetchEvent, type BlobSyncEvent } from './blob.service';
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

  it('POSTs highlights on create when provided', () => {
    service.create('{}', undefined, false, [highlight]).subscribe();
    const req = httpMock.expectOne(base);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      content: '{}',
      title: undefined,
      isPublic: false,
      highlights: [highlight],
    });
    req.flush(makeBlob({ content: '{}', highlights: [highlight] }));
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

  describe('getWithProgress', () => {
    it('emits bytesComplete then blob in that order on a flushed Response', () => {
      const events: BlobFetchEvent[] = [];
      service.getWithProgress(slug).subscribe((event) => events.push(event));
      const req = httpMock.expectOne(`${base}/${slug}`);
      expect(req.request.method).toBe('GET');
      expect(req.request.responseType)
        .withContext(
          'must use text responseType so JSON.parse runs in BlobService, not in Angular before Response emits',
        )
        .toBe('text');
      // HttpClientTesting flushes a single Response event without an
      // intermediate ResponseHeader/DownloadProgress pair, so this
      // verifies the terminal-event handling in isolation.
      req.flush(JSON.stringify(makeBlob()));
      expect(events).toEqual([{ kind: 'bytesComplete' }, { kind: 'blob', blob: makeBlob() }]);
    });

    it('preserves the progress* -> bytesComplete -> blob ordering on a streamed fetch', () => {
      const events: BlobFetchEvent[] = [];
      service.getWithProgress(slug).subscribe((event) => events.push(event));
      const req = httpMock.expectOne(`${base}/${slug}`);
      req.event(
        new HttpHeaderResponse({
          headers: new HttpHeaders({ 'X-Jotjson-Body-Length': '10000' }),
          status: 200,
          statusText: 'OK',
          url: req.request.url,
        }),
      );
      for (const loaded of [2500, 5000, 7500, 10000]) {
        req.event({ type: HttpEventType.DownloadProgress, loaded });
      }
      req.flush(JSON.stringify(makeBlob()));
      const kinds = events.map((event) => event.kind);
      expect(kinds).toEqual([
        'progress',
        'progress',
        'progress',
        'progress',
        'bytesComplete',
        'blob',
      ]);
    });

    it('memoizes total from X-Jotjson-Body-Length on ResponseHeader without emitting yet', () => {
      const events: BlobFetchEvent[] = [];
      service.getWithProgress(slug).subscribe((event) => events.push(event));
      const req = httpMock.expectOne(`${base}/${slug}`);
      const headerEvent: HttpEvent<string> = new HttpHeaderResponse({
        headers: new HttpHeaders({ 'X-Jotjson-Body-Length': '4096' }),
        status: 200,
        statusText: 'OK',
        url: req.request.url,
      });
      req.event(headerEvent);
      expect(events)
        .withContext(
          'no progress event should fire on ResponseHeader -- empty 0% bar would flash before first byte',
        )
        .toEqual([]);
      const progressEvent: HttpEvent<string> = {
        type: HttpEventType.DownloadProgress,
        loaded: 1024,
      };
      req.event(progressEvent);
      expect(events).toEqual([{ kind: 'progress', loaded: 1024, total: 4096 }]);
      req.flush(JSON.stringify(makeBlob()));
      expect(events.at(-1)).toEqual({ kind: 'blob', blob: makeBlob() });
    });

    it('emits multiple progress events, all sharing the memoized total', () => {
      const events: BlobFetchEvent[] = [];
      service.getWithProgress(slug).subscribe((event) => events.push(event));
      const req = httpMock.expectOne(`${base}/${slug}`);
      req.event(
        new HttpHeaderResponse({
          headers: new HttpHeaders({ 'X-Jotjson-Body-Length': '10000' }),
          status: 200,
          statusText: 'OK',
          url: req.request.url,
        }),
      );
      for (const loaded of [2500, 5000, 7500, 10000]) {
        req.event({ type: HttpEventType.DownloadProgress, loaded });
      }
      req.flush(JSON.stringify(makeBlob()));
      const progressEvents = events.filter((event) => event.kind === 'progress');
      expect(progressEvents.length).toBe(4);
      for (const progressEvent of progressEvents) {
        expect(progressEvent.total).toBe(10000);
      }
    });

    it('treats a missing X-Jotjson-Body-Length header as null total (indeterminate)', () => {
      const events: BlobFetchEvent[] = [];
      service.getWithProgress(slug).subscribe((event) => events.push(event));
      const req = httpMock.expectOne(`${base}/${slug}`);
      req.event(
        new HttpHeaderResponse({
          headers: new HttpHeaders(),
          status: 200,
          statusText: 'OK',
          url: req.request.url,
        }),
      );
      req.event({ type: HttpEventType.DownloadProgress, loaded: 1234 });
      req.flush(JSON.stringify(makeBlob()));
      expect(events.find((event) => event.kind === 'progress')).toEqual({
        kind: 'progress',
        loaded: 1234,
        total: null,
      });
    });

    it('treats X-Jotjson-Body-Length: 0 as null (indeterminate)', () => {
      const events: BlobFetchEvent[] = [];
      service.getWithProgress(slug).subscribe((event) => events.push(event));
      const req = httpMock.expectOne(`${base}/${slug}`);
      req.event(
        new HttpHeaderResponse({
          headers: new HttpHeaders({ 'X-Jotjson-Body-Length': '0' }),
          status: 200,
          statusText: 'OK',
          url: req.request.url,
        }),
      );
      req.event({ type: HttpEventType.DownloadProgress, loaded: 100 });
      req.flush(JSON.stringify(makeBlob()));
      expect(events.find((event) => event.kind === 'progress')).toEqual({
        kind: 'progress',
        loaded: 100,
        total: null,
      });
    });

    it('treats a non-numeric X-Jotjson-Body-Length as null', () => {
      const events: BlobFetchEvent[] = [];
      service.getWithProgress(slug).subscribe((event) => events.push(event));
      const req = httpMock.expectOne(`${base}/${slug}`);
      req.event(
        new HttpHeaderResponse({
          headers: new HttpHeaders({ 'X-Jotjson-Body-Length': 'banana' }),
          status: 200,
          statusText: 'OK',
          url: req.request.url,
        }),
      );
      req.event({ type: HttpEventType.DownloadProgress, loaded: 100 });
      req.flush(JSON.stringify(makeBlob()));
      expect(events.find((event) => event.kind === 'progress')).toEqual({
        kind: 'progress',
        loaded: 100,
        total: null,
      });
    });

    it('caches the version of the resolved blob on the final event', () => {
      service.getWithProgress(slug).subscribe();
      const req = httpMock.expectOne(`${base}/${slug}`);
      req.flush(JSON.stringify(makeBlob({ version: 11 })));
      // Subsequent update should use If-Match: "11" (proves rememberBlob ran).
      service.update(id, { title: 'after progress get' }).subscribe();
      const update = httpMock.expectOne(`${base}/${id}`);
      expect(update.request.headers.get('If-Match')).toBe('"11"');
      update.flush(makeBlob({ title: 'after progress get', version: 12 }));
    });

    it('errors when Response arrives without a body', () => {
      const events: BlobFetchEvent[] = [];
      let errorStatus: number | undefined;
      service.getWithProgress(slug).subscribe({
        next: (event) => events.push(event),
        error: (error: { status?: number }) => {
          errorStatus = error.status;
        },
      });
      const req = httpMock.expectOne(`${base}/${slug}`);
      req.event(
        new HttpResponse<string>({
          body: null,
          status: 200,
          statusText: 'OK',
          url: req.request.url,
        }),
      );
      expect(errorStatus).toBe(200);
      // bytesComplete must NOT fire on empty body - the splash should
      // not flash "Rendering tree..." before the resolver redirects
      // to /404.
      expect(events).toEqual([]);
    });

    it('emits bytesComplete then errors when the body is not valid JSON', () => {
      const events: BlobFetchEvent[] = [];
      let errorStatus: number | undefined;
      let errorBody: unknown;
      service.getWithProgress(slug).subscribe({
        next: (event) => events.push(event),
        error: (error: { status?: number; error?: unknown }) => {
          errorStatus = error.status;
          errorBody = error.error;
        },
      });
      const req = httpMock.expectOne(`${base}/${slug}`);
      req.flush('not-valid-json{', { status: 200, statusText: 'OK' });
      // The user briefly sees "Rendering tree..." before the resolver
      // redirects to /404 - preferable to mislabelling the heavy
      // parse window as "Downloading JSON...".
      expect(events).toEqual([{ kind: 'bytesComplete' }]);
      expect(errorStatus).toBe(200);
      expect(typeof errorBody).toBe('string');
      expect(errorBody as string).toMatch(/JSON parse failed/);
    });

    it('propagates HTTP errors to subscribers without firing bytesComplete', () => {
      const events: BlobFetchEvent[] = [];
      let errorStatus: number | undefined;
      service.getWithProgress(slug).subscribe({
        next: (event) => events.push(event),
        error: (error: { status?: number }) => {
          errorStatus = error.status;
        },
      });
      const req = httpMock.expectOne(`${base}/${slug}`);
      req.flush('not found', { status: 404, statusText: 'Not Found' });
      expect(errorStatus).toBe(404);
      expect(events).toEqual([]);
    });
  });
});
