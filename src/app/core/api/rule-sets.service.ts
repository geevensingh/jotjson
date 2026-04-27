import { HttpClient, HttpHeaders } from '@angular/common/http';
import {
  DestroyRef,
  Injectable,
  Signal,
  computed,
  effect,
  inject,
  signal
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, tap } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthService } from '../auth/auth.service';
import { PreferencesService } from '../preferences/preferences.service';
import type {
  FormattingRuleSet,
  RuleSetPayload,
  RuleSetPreset
} from './models';

/**
 * Frontend wrapper over `/api/rule-sets`.
 *
 * Owns the in-memory cache of the signed-in user's rule sets so the tree
 * (M6f-3), toolbar (M6f-4), profile (M6f-5), and rule editor (M6d) all read
 * from the same source. Cache lifecycle:
 *
 * - `ruleSets()` is `null` before any successful `list()` and after sign-out.
 * - `list()` overwrites the cache with the server snapshot.
 * - `create()`, `clonePreset()`, `update()`, `delete()` patch the cache only
 *   after the corresponding network call succeeds. We deliberately avoid
 *   optimistic mutations: the rule-editor work in M6d does not need
 *   sub-100ms feedback for save, and the simpler write-after-success path
 *   sidesteps rollback bugs around 412 conflicts.
 *
 * Concurrency: `update()` sends `If-Match: "<version>"` per
 * DESIGN_SPEC.md §Features 7. We pass the version from the caller (the
 * editor screen reads it out of the cached document) rather than rummaging
 * the cache here, because a user with two tabs could legitimately PUT the
 * second tab's version against the first tab's body.
 *
 * Active rule-set selection lives in `UserPreferences.activeRuleSetIds`
 * and is mutated through `PreferencesService.update`. We expose
 * `activeRuleSetIds` and `activeRuleSets` as computed signals so consumers
 * never need to combine prefs and the cache themselves.
 */
@Injectable({ providedIn: 'root' })
export class RuleSetsService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly preferences = inject(PreferencesService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly base = `${environment.apiBaseUrl}/rule-sets`;

  private readonly _ruleSets = signal<FormattingRuleSet[] | null>(null);
  /** Cached rule sets, or `null` when never loaded / signed out. */
  readonly ruleSets: Signal<FormattingRuleSet[] | null> = this._ruleSets.asReadonly();

  /**
   * IDs the user currently has toggled on. Mirrors
   * `UserPreferences.activeRuleSetIds` so any preference change (including
   * server hydration) is observed automatically.
   */
  readonly activeRuleSetIds = computed(() => this.preferences.prefs().activeRuleSetIds);

  /**
   * Active rule sets resolved against the cache, in the order the user
   * configured them. IDs that no longer resolve (e.g. another tab deleted
   * the set) are silently dropped, matching the model contract on
   * `UserPreferences.activeRuleSetIds`.
   *
   * Returns an empty array when the cache has not yet loaded - the engine
   * is a no-op in that state, which is safer than rendering stale styling.
   */
  readonly activeRuleSets = computed<FormattingRuleSet[]>(() => {
    const all = this._ruleSets();
    if (!all) return [];
    const byId = new Map(all.map((set) => [set.id, set]));
    const out: FormattingRuleSet[] = [];
    for (const id of this.activeRuleSetIds()) {
      const set = byId.get(id);
      if (set) out.push(set);
    }
    return out;
  });

  constructor() {
    // Drop the cache when the user signs out so a subsequent sign-in on the
    // same device cannot leak the previous user's rule sets through the
    // tree before its first list() resolves. PreferencesService already
    // resets activeRuleSetIds via DEFAULT_PREFERENCES on sign-out.
    effect(() => {
      const user = this.auth.user();
      if (!user) this._ruleSets.set(null);
    });
  }

  list(): Observable<FormattingRuleSet[]> {
    return this.http.get<FormattingRuleSet[]>(this.base).pipe(
      tap((sets) => this._ruleSets.set(sets))
    );
  }

  get(id: string): Observable<FormattingRuleSet> {
    return this.http.get<FormattingRuleSet>(`${this.base}/${encodeURIComponent(id)}`);
  }

  create(payload: RuleSetPayload): Observable<FormattingRuleSet> {
    return this.http.post<FormattingRuleSet>(this.base, payload).pipe(
      tap((created) => this.upsertCached(created))
    );
  }

  update(id: string, payload: RuleSetPayload, version: number): Observable<FormattingRuleSet> {
    const headers = new HttpHeaders({ 'If-Match': `"${version}"` });
    return this.http
      .put<FormattingRuleSet>(`${this.base}/${encodeURIComponent(id)}`, payload, { headers })
      .pipe(tap((next) => this.upsertCached(next)));
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/${encodeURIComponent(id)}`).pipe(
      tap(() => {
        const current = this._ruleSets();
        if (current) {
          this._ruleSets.set(current.filter((s) => s.id !== id));
        }
        // Also mirror the server-side cleanup of activeRuleSetIds so the
        // toolbar reflects the deletion immediately, before the next prefs
        // hydration round-trips.
        const active = this.preferences.prefs().activeRuleSetIds;
        if (active.includes(id)) {
          this.preferences.update({
            activeRuleSetIds: active.filter((x) => x !== id)
          });
        }
      })
    );
  }

  listPresets(): Observable<RuleSetPreset[]> {
    return this.http.get<RuleSetPreset[]>(`${this.base}/presets`);
  }

  clonePreset(presetId: string): Observable<FormattingRuleSet> {
    return this.http
      .post<FormattingRuleSet>(
        `${this.base}/presets/${encodeURIComponent(presetId)}/clone`,
        {}
      )
      .pipe(tap((created) => this.upsertCached(created)));
  }

  /**
   * Mutate `UserPreferences.activeRuleSetIds`. Callers pass the full ID
   * list; we filter out any IDs not present in the cache so the persisted
   * value does not accumulate dangling references after deletes from
   * other tabs. We DO NOT enforce ordering - the engine consumes them in
   * caller-supplied (== createdAt) order, but the toolbar may reorder
   * for display.
   */
  setActive(ids: readonly string[]): void {
    const cache = this._ruleSets();
    const known = cache ? new Set(cache.map((s) => s.id)) : null;
    const filtered = known ? ids.filter((id) => known.has(id)) : Array.from(ids);
    // De-duplicate while preserving first-seen order.
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const id of filtered) {
      if (!seen.has(id)) {
        seen.add(id);
        deduped.push(id);
      }
    }
    this.preferences.update({ activeRuleSetIds: deduped });
  }

  /** Toggle a single rule set's active state. No-op if the ID is unknown. */
  toggleActive(id: string): void {
    const cache = this._ruleSets();
    if (cache && !cache.some((s) => s.id === id)) return;
    const current = this.preferences.prefs().activeRuleSetIds;
    if (current.includes(id)) {
      this.setActive(current.filter((x) => x !== id));
    } else {
      this.setActive([...current, id]);
    }
  }

  /**
   * Refresh the cache from the server. Sugar over `list()` that swallows
   * the result; consumers that care about the response should call
   * `list()` directly. Kept to make "the toolbar opened, refresh me"
   * call-sites read clearly.
   */
  refresh(): void {
    this.list().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      error: () => {
        /* surface via syncState if/when we add it; silent for now */
      }
    });
  }

  private upsertCached(set: FormattingRuleSet): void {
    const current = this._ruleSets();
    if (!current) {
      // Cache not yet populated - seed it with this single entry rather
      // than discarding the write. The next list() call will fill in the
      // rest.
      this._ruleSets.set([set]);
      return;
    }
    const idx = current.findIndex((s) => s.id === set.id);
    if (idx === -1) {
      this._ruleSets.set([...current, set]);
    } else {
      const next = current.slice();
      next[idx] = set;
      this._ruleSets.set(next);
    }
  }
}
