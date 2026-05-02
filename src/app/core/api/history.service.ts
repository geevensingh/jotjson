import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { HistoryEntry } from './models';

export interface HistoryPage {
  entries: HistoryEntry[];
  continuationToken?: string;
}

/**
 * Typed wrapper over `/api/history` for the "Recently viewed" timeline.
 * v1 narrowed the surface to `viewed`-only entries; the per-action filter
 * was removed.
 */
@Injectable({ providedIn: 'root' })
export class HistoryService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiBaseUrl}/history`;

  list(
    opts: {
      pageSize?: number;
      continuationToken?: string;
      q?: string;
      from?: string;
      to?: string;
    } = {},
  ): Observable<HistoryPage> {
    let params = new HttpParams();
    if (opts.pageSize !== undefined) {
      params = params.set('pageSize', String(opts.pageSize));
    }
    if (opts.continuationToken) {
      params = params.set('continuationToken', opts.continuationToken);
    }
    if (opts.q !== undefined && opts.q.trim().length > 0) {
      params = params.set('q', opts.q);
    }
    if (opts.from) params = params.set('from', opts.from);
    if (opts.to) params = params.set('to', opts.to);
    return this.http.get<HistoryPage>(this.base, { params });
  }

  clear(): Observable<void> {
    return this.http.delete<void>(this.base);
  }
}
