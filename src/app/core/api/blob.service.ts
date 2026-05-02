import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Observable, Subject, catchError, mergeMap, of, tap, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { BlobHighlight, CreateBlobResponse, JsonBlob } from './models';

export interface BlobSyncEvent {
  kind: 'conflict';
  id: string;
  blob: JsonBlob;
  status: 412;
}

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
