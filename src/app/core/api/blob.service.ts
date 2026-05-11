import {
  HttpClient,
  HttpErrorResponse,
  HttpEventType,
  HttpHeaders,
  HttpResponse,
  type HttpEvent,
} from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  Observable,
  Subject,
  catchError,
  concat,
  defer,
  mergeMap,
  of,
  tap,
  throwError,
} from 'rxjs';
import { environment } from '../../../environments/environment';
import type { BlobHighlight, CreateBlobResponse, JsonBlob } from './models';

export interface BlobSyncEvent {
  kind: 'conflict';
  id: string;
  blob: JsonBlob;
  status: 412;
}

/**
 * Discriminated union emitted by `BlobService.getWithProgress`.
 *
 * Consumers (the share resolver) use `progress` events to drive the
 * loading splash / route progress bar, the `bytesComplete` event to
 * transition the splash to "Rendering tree..." before the synchronous
 * JSON parse runs, and the terminal `blob` event as the resolved value
 * to forward to the route.
 *
 * Event ordering for a successful fetch:
 *
 *     progress* -> bytesComplete -> blob
 *
 * The `bytesComplete` event is emitted synchronously between the XHR
 * `load` event and the `JSON.parse` call (see `getWithProgress` for
 * why this matters for huge blobs). Consumers MUST NOT assume any
 * specific timing between `bytesComplete` and `blob`; for multi-MB
 * payloads they may be separated by seconds of main-thread work.
 *
 * `total` is `null` whenever the server did not (or could not) declare
 * an uncompressed body length -- typically when the deployment lacks
 * the `X-Jotjson-Body-Length` header. Consumers must treat null as
 * "indeterminate, fall back to spinner-style UI".
 */
export type BlobFetchEvent =
  | { kind: 'progress'; loaded: number; total: number | null }
  | { kind: 'bytesComplete' }
  | { kind: 'blob'; blob: JsonBlob };

const BODY_LENGTH_HEADER = 'X-Jotjson-Body-Length';

@Injectable({ providedIn: 'root' })
export class BlobService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiBaseUrl}/blobs`;
  private readonly versionsByKey = new Map<string, number>();
  private readonly eventsSubject = new Subject<BlobSyncEvent>();

  readonly events$ = this.eventsSubject.asObservable();

  get(idOrSlug: string): Observable<JsonBlob> {
    return this.http
      .get<JsonBlob>(`${this.base}/${idOrSlug}`)
      .pipe(tap((blob) => this.rememberBlob(blob)));
  }

  /**
   * Streaming variant of `get` that emits download-progress events
   * before the terminal blob payload. Used by `shareBlobResolver` to
   * paint a determinate progress bar during cold-boot / in-app
   * navigation to `/s/:slug`.
   *
   * **How `total` is sourced**: Azure Front Door compresses
   * `application/json` on the fly with `Transfer-Encoding: chunked`,
   * which strips `Content-Length`. So Angular's
   * `HttpEventType.DownloadProgress` events arrive without a real
   * `total`. The server therefore stamps the uncompressed UTF-8 byte
   * count onto an `X-Jotjson-Body-Length` response header, which AFD
   * passes through unchanged. We memoize that value when the
   * `ResponseHeader` event fires and attach it to every subsequent
   * progress event.
   *
   * **Why we don't emit a progress event on `ResponseHeader`**: the
   * UI would otherwise flash an empty 0% bar between header arrival
   * and the first body byte. We emit the first progress event on the
   * first `DownloadProgress` event, by which time `loaded > 0` is
   * already a meaningful fraction.
   *
   * **XHR backend dependency**: the `ResponseHeader -> DownloadProgress
   * -> Response` ordering above relies on Angular's default XHR
   * backend (no `withFetch()` in `app.config.ts`). If the app later
   * adopts `withFetch()`, this implementation MUST be re-verified --
   * the Fetch backend has different `HttpEvent` semantics and may
   * not surface `ResponseHeader` separately.
   *
   * **Why `responseType: 'text'` instead of `'json'`**: with the
   * default typed `get<JsonBlob>` overload, Angular's XHR backend
   * calls `JSON.parse` synchronously inside the `onLoad` handler
   * BEFORE emitting the terminal `Response` event. For a multi-MB
   * blob the parse can take several seconds on the main thread, and
   * during that window the consumer has already seen the last
   * `DownloadProgress` (loaded === total) but no terminal event --
   * so the loading splash pins at 100% under "Downloading JSON..."
   * while the user is actually waiting on `JSON.parse`. By taking
   * the body as text we move the parse out of Angular's emit path
   * and can fire a synthetic `bytesComplete` event between the XHR
   * load and our own `JSON.parse`, letting the splash transition to
   * "Rendering tree..." while the parse runs.
   */
  getWithProgress(idOrSlug: string): Observable<BlobFetchEvent> {
    const url = `${this.base}/${idOrSlug}`;
    let memoizedTotal: number | null = null;
    return this.http
      .get(url, {
        observe: 'events',
        reportProgress: true,
        responseType: 'text',
      })
      .pipe(
        mergeMap((event: HttpEvent<string>): Observable<BlobFetchEvent> => {
          if (event.type === HttpEventType.ResponseHeader) {
            memoizedTotal = parseBodyLengthHeader(event.headers.get(BODY_LENGTH_HEADER));
            return of();
          }
          if (event.type === HttpEventType.DownloadProgress) {
            return of({
              kind: 'progress',
              loaded: event.loaded,
              total: memoizedTotal,
            });
          }
          if (event.type === HttpEventType.Response) {
            const response = event as HttpResponse<string>;
            const body = response.body;
            if (!body) {
              return throwError(
                () =>
                  new HttpErrorResponse({
                    status: response.status,
                    statusText: response.statusText,
                    url: response.url ?? url,
                    error: 'empty blob response body',
                  }),
              );
            }
            // Emit `bytesComplete` synchronously BEFORE running the
            // parse so the loading splash can switch to the
            // "Rendering tree..." stage and hide the bar before the
            // main-thread JSON.parse runs. `defer` ensures the parse
            // only runs when the downstream observer subscribes
            // through to the second emission, which happens
            // synchronously in the same microtask.
            return concat(
              of<BlobFetchEvent>({ kind: 'bytesComplete' }),
              defer((): Observable<BlobFetchEvent> => {
                let parsed: JsonBlob;
                try {
                  parsed = JSON.parse(body) as JsonBlob;
                } catch (parseError) {
                  const message =
                    parseError instanceof Error
                      ? `JSON parse failed: ${parseError.message}`
                      : 'JSON parse failed';
                  return throwError(
                    () =>
                      new HttpErrorResponse({
                        status: response.status,
                        statusText: response.statusText,
                        url: response.url ?? url,
                        error: message,
                      }),
                  );
                }
                this.rememberBlob(parsed);
                return of({ kind: 'blob', blob: parsed });
              }),
            );
          }
          return of();
        }),
      );
  }

  list(): Observable<JsonBlob[]> {
    return this.http
      .get<JsonBlob[]>(this.base)
      .pipe(tap((blobs) => blobs.forEach((blob) => this.rememberBlob(blob))));
  }

  create(
    content: string,
    title?: string,
    isPublic = false,
    highlights?: readonly BlobHighlight[],
  ): Observable<CreateBlobResponse> {
    const body =
      highlights === undefined
        ? { content, title, isPublic }
        : { content, title, isPublic, highlights: [...highlights] };
    return this.http.post<CreateBlobResponse>(this.base, body).pipe(
      tap((created) => {
        const { autoDeleted: _autoDeleted, ...blob } = created;
        void _autoDeleted;
        this.rememberBlob(blob);
      }),
    );
  }

  update(
    id: string,
    patch: Partial<Pick<JsonBlob, 'content' | 'title' | 'isPublic' | 'highlights'>>,
  ): Observable<JsonBlob> {
    const version = this.versionsByKey.get(id) ?? 1;
    const headers = new HttpHeaders({ 'If-Match': `"${version}"` });
    return this.http.put<JsonBlob>(`${this.base}/${id}`, patch, { headers }).pipe(
      tap((blob) => this.rememberBlob(blob)),
      catchError((error: HttpErrorResponse) => {
        if (error.status !== 412) {
          return throwError(() => error);
        }
        return this.get(id).pipe(
          tap((blob) => this.eventsSubject.next({ kind: 'conflict', id, blob, status: 412 })),
          catchError(() => of(null)),
          mergeMap(() => throwError(() => error)),
        );
      }),
    );
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/${id}`);
  }

  private rememberBlob(blob: JsonBlob): void {
    this.versionsByKey.set(blob.id, blob.version);
    this.versionsByKey.set(blob.slug, blob.version);
  }
}

function parseBodyLengthHeader(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}
