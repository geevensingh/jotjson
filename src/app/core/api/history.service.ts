import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { HistoryAction, HistoryEntry } from './models';

export interface HistoryPage {
  entries: HistoryEntry[];
  continuationToken?: string;
}

export interface RecordPasteInput {
  slug?: string;
  title?: string;
}

/**
 * Typed wrapper over `/api/history` for the M5b timeline UI. The endpoints
 * exist on the backend (M5a.2) but no UI consumes this service yet - it
 * ships now so the M5b PR can focus on UX without re-litigating the API
 * contract.
 */
@Injectable({ providedIn: 'root' })
export class HistoryService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiBaseUrl}/history`;

  list(opts: {
    pageSize?: number;
    continuationToken?: string;
    q?: string;
    actions?: HistoryAction[];
    from?: string;
    to?: string;
  } = {}): Observable<HistoryPage> {
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
    if (opts.actions && opts.actions.length > 0) {
      params = params.set('actions', opts.actions.join(','));
    }
    if (opts.from) params = params.set('from', opts.from);
    if (opts.to) params = params.set('to', opts.to);
    return this.http.get<HistoryPage>(this.base, { params });
  }

  clear(): Observable<void> {
    return this.http.delete<void>(this.base);
  }

  /**
   * Records a paste event. The server enforces a 60s debounce per user;
   * rapid repeats return 204 with no body, so callers can fire-and-forget.
   * Treat the response as opaque - the entry is only useful to the
   * timeline view, not to the home component.
   */
  recordPaste(input: RecordPasteInput = {}): Observable<HistoryEntry | null> {
    const body: { action: 'pasted'; slug?: string; title?: string } = {
      action: 'pasted',
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      ...(input.title !== undefined ? { title: input.title } : {})
    };
    return this.http.post<HistoryEntry | null>(this.base, body);
  }
}
