import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { CreateBlobResponse, JsonBlob } from './models';

@Injectable({ providedIn: 'root' })
export class BlobService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiBaseUrl}/blobs`;

  get(idOrSlug: string): Observable<JsonBlob> {
    return this.http.get<JsonBlob>(`${this.base}/${idOrSlug}`);
  }

  list(): Observable<JsonBlob[]> {
    return this.http.get<JsonBlob[]>(this.base);
  }

  create(content: string, title?: string, isPublic = false): Observable<CreateBlobResponse> {
    return this.http.post<CreateBlobResponse>(this.base, { content, title, isPublic });
  }

  update(id: string, patch: Partial<Pick<JsonBlob, 'content' | 'title' | 'isPublic'>>): Observable<JsonBlob> {
    return this.http.put<JsonBlob>(`${this.base}/${id}`, patch);
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/${id}`);
  }
}
