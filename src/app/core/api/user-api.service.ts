import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, of } from 'rxjs';
import type { User, UserPreferences } from './models';

/**
 * HTTP surface for `/api/me` endpoints.
 *
 * URLs are intentionally relative so the auth interceptor (which only
 * matches `/api/*`) attaches the access token. Do not switch these to the
 * absolute-URL form.
 */
@Injectable({ providedIn: 'root' })
export class UserApiService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/me';

  /**
   * Read the current user's document. Returns `null` if the server responds
   * 404 - this indicates the user has signed in but has never had a
   * document seeded. Other errors propagate.
   */
  getMe(): Observable<User | null> {
    return this.http.get<User>(this.base).pipe(
      catchError((error: HttpErrorResponse) => {
        if (error.status === 404) return of(null);
        throw error;
      })
    );
  }

  /** Seed a fresh user doc with client-provided preferences. */
  seed(preferences: UserPreferences): Observable<User> {
    return this.http.post<User>(this.base, { preferences });
  }

  /** Replace the user's preferences with a fully-normalized payload. */
  putPreferences(preferences: UserPreferences): Observable<UserPreferences> {
    return this.http.put<UserPreferences>(`${this.base}/preferences`, preferences);
  }
}
