import { HttpClient, HttpErrorResponse, HttpResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
import type { User, UserPreferences } from './models';

export interface UserWithEtag {
  user: User;
  etag: string | null;
}

export interface PreferencesWithEtag {
  preferences: UserPreferences;
  etag: string | null;
}

/**
 * HTTP surface for `/api/me` endpoints.
 *
 * URLs are intentionally relative so the auth interceptor (which only
 * matches `/api/*`) attaches the access token. Do not switch these to the
 * absolute-URL form.
 *
 * Every method that returns a user/preferences body also returns the
 * Cosmos version as an opaque `ETag` (already wrapped in quotes per
 * RFC 7232). Callers thread it back via the `If-Match` header on the
 * next write so the server can detect concurrent edits and return 412.
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
  getMe(): Observable<UserWithEtag | null> {
    return this.http.get<User>(this.base, { observe: 'response' }).pipe(
      map((response: HttpResponse<User>) => ({
        user: response.body as User,
        etag: response.headers.get('ETag'),
      })),
      catchError((error: HttpErrorResponse) => {
        if (error.status === 404) return of(null);
        throw error;
      }),
    );
  }

  /** Seed a fresh user doc with client-provided preferences. */
  seed(preferences: UserPreferences): Observable<UserWithEtag> {
    return this.http.post<User>(this.base, { preferences }, { observe: 'response' }).pipe(
      map((response: HttpResponse<User>) => ({
        user: response.body as User,
        etag: response.headers.get('ETag'),
      })),
    );
  }

  /**
   * Replace the user's preferences with a fully-normalized payload.
   *
   * `ifMatch` is required: the server returns 400 when it is missing
   * and 412 when it does not match the stored version (concurrent
   * edit detected). Callers should treat 412 as "preferences were
   * changed in another window" and refetch.
   */
  putPreferences(preferences: UserPreferences, ifMatch: string): Observable<PreferencesWithEtag> {
    return this.http
      .put<UserPreferences>(`${this.base}/preferences`, preferences, {
        headers: { 'If-Match': ifMatch },
        observe: 'response',
      })
      .pipe(
        map((response: HttpResponse<UserPreferences>) => ({
          preferences: response.body as UserPreferences,
          etag: response.headers.get('ETag'),
        })),
      );
  }
}
