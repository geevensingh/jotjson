import { isPlatformBrowser } from '@angular/common';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import {
  DestroyRef,
  Injectable,
  PLATFORM_ID,
  Signal,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, Subject, catchError, fromEvent, of, tap, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthService } from '../auth/auth.service';
import { PreferencesService } from '../preferences/preferences.service';
import { LoggerService } from '../telemetry/logger.service';
import type { TelemetryProps } from '../telemetry/telemetry.service';
import type { FormattingRule, FormattingRuleSet, RuleSetPayload, RuleSetPreset } from './models';

/**
 * One pending write that has not yet been acknowledged by the server.
 * `userId` is captured at enqueue time so a hydrated queue from a
 * prior session can be filtered against the currently signed-in user.
 *
 * `update` carries the full payload + the `If-Match` baseVersion the
 * caller intended. `delete` is parameter-free beyond the id.
 */
export type QueuedWrite =
  | {
      kind: 'update';
      userId: string;
      id: string;
      payload: RuleSetPayload;
      baseVersion: number;
    }
  | { kind: 'delete'; userId: string; id: string };

/**
 * Event emitted on `events$` when a queued write fails permanently.
 * `kind: 'conflict'` is a 412 (server moved past the queued
 * baseVersion); `kind: 'error'` is any other non-retryable HTTP
 * status. UI consumers listen for these to surface toasts. The
 * service deliberately stays UI-agnostic.
 */
export interface RuleSetSyncEvent {
  kind: 'conflict' | 'error';
  id: string;
  status?: number;
}

const CACHE_KEY = 'jotjson.ruleSets.cache.v1';
const QUEUE_KEY = 'jotjson.ruleSets.queue.v1';

interface CacheEnvelope {
  userId: string;
  sets: FormattingRuleSet[];
}

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
 *   after the corresponding network call succeeds (or, M6g-4, after enqueue
 *   for offline `update`/`delete` - see Offline pattern below).
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
 *
 * ## Offline pattern (M6g-4)
 *
 * The cache is conceptually `serverSnapshot + projection(queue)`:
 *
 * - `_serverSnapshot` is the source of truth from the server (list / get /
 *   confirmed write).
 * - `_queue` is an array of {@link QueuedWrite}s waiting to drain. New
 *   queued writes coalesce per-id (latest update wins; a delete subsumes
 *   prior updates). The first queued update for an id keeps the original
 *   `baseVersion` so the eventual `If-Match` matches what the server still
 *   has.
 * - `_inFlight` is the queued item currently being dispatched. Coalescing
 *   never touches it (its body has already been sent on the wire).
 * - `ruleSets()` projects updates and deletes from `_inFlight + _queue`
 *   over the snapshot so the UI sees an optimistic view immediately.
 *
 * Offline writes (`update` / `delete`) - whether triggered by
 * `navigator.onLine === false`, an existing non-empty queue, or a network
 * error (HTTP status 0) on the live path - return synchronously with the
 * optimistic value and emit the queued write. `pendingWriteIds()` exposes
 * which rule-set ids have any queued / in-flight write so callers can
 * render a "Saved offline - will sync" affordance distinct from a true
 * server-acknowledged save.
 *
 * Drain runs serially: each `online` event (and each completed write)
 * dispatches the head item. 412 -> drop + emit `conflict` + refresh.
 * Other 4xx -> drop + emit `error` + refresh. 5xx / status 0 -> leave
 * queue intact, wait for the next `online` event. Sign-out / user-switch
 * increments a generation counter so any in-flight callback sees the
 * change and bails out without touching the new user's state.
 *
 * `create` / `clonePreset` are intentionally NOT queued: their server
 * response carries the canonical id we route to, and offline temp-id
 * reconciliation is out of scope for v1.
 */
@Injectable({ providedIn: 'root' })
export class RuleSetsService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly preferences = inject(PreferencesService);
  private readonly logger = inject(LoggerService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly base = `${environment.apiBaseUrl}/rule-sets`;

  private readonly _serverSnapshot = signal<FormattingRuleSet[] | null>(null);
  private readonly _queue = signal<readonly QueuedWrite[]>([]);
  private readonly _inFlight = signal<QueuedWrite | null>(null);

  /**
   * Generation counter incremented on every sign-out / user-switch so
   * in-flight drain callbacks can detect they've been invalidated and
   * skip mutating cache, queue, or telemetry for the wrong user.
   */
  private _drainGen = 0;

  /**
   * Cached rule sets, or `null` when never loaded / signed out. Layered
   * view of the server snapshot with all queued / in-flight writes
   * projected on top so the UI sees optimistic state immediately.
   */
  readonly ruleSets: Signal<FormattingRuleSet[] | null> = computed(() => {
    const snap = this._serverSnapshot();
    if (snap === null) return null;
    const writes: QueuedWrite[] = [];
    const flight = this._inFlight();
    if (flight) writes.push(flight);
    writes.push(...this._queue());
    if (writes.length === 0) return snap;
    return projectQueue(snap, writes);
  });

  /**
   * IDs of rule sets that have at least one queued or in-flight write.
   * Editor / toolbar UI listens to this to render "Saved offline - will
   * sync" affordances.
   */
  readonly pendingWriteIds = computed<ReadonlySet<string>>(() => {
    const ids = new Set<string>();
    const flight = this._inFlight();
    if (flight) ids.add(flight.id);
    for (const item of this._queue()) ids.add(item.id);
    return ids;
  });

  /** Total number of pending writes (queue head + in-flight). */
  readonly pendingWriteCount = computed(() => this._queue().length + (this._inFlight() ? 1 : 0));

  /**
   * Conflict / error events from drain failures. UI surfaces these as
   * toasts; the service stays UI-agnostic.
   */
  readonly events$ = new Subject<RuleSetSyncEvent>();

  /**
   * IDs the user has selected as active. Mirrors
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
    const all = this.ruleSets();
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
    // Persist server snapshot on every change. Skipped when no user is
    // signed in (the sign-out effect handles purging directly).
    effect(() => {
      const snap = this._serverSnapshot();
      const userId = this.auth.user()?.id;
      if (!userId) return;
      tryStorage(() => {
        if (snap === null) {
          localStorage.removeItem(CACHE_KEY);
        } else {
          const envelope: CacheEnvelope = { userId, sets: snap };
          localStorage.setItem(CACHE_KEY, JSON.stringify(envelope));
        }
      });
    });

    // Persist queue on every change. `_inFlight` is intentionally NOT
    // persisted: a reload mid-flight re-prepends in-flight to the queue
    // so the persisted list is the source of truth.
    effect(() => {
      const q = this._queue();
      const userId = this.auth.user()?.id;
      if (!userId) return;
      tryStorage(() => {
        if (q.length === 0) {
          localStorage.removeItem(QUEUE_KEY);
        } else {
          localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
        }
      });
    });

    // Auth lifecycle: clear in-memory + persisted state whenever the
    // user is null (sign-out, or initial pre-auth state). Hydrate the
    // persisted cache + queue once, the first time a user is observed
    // signed in - by then `auth.user().id` is available so the
    // user-scope match in `hydrateFromStorage()` is meaningful.
    //
    // We rely on a simple "is there a user right now?" check rather
    // than a transition detector because Angular effects batch state
    // changes; intermediate values between flushes are not observable.
    // Tests (and production sign-out) always end up with `user === null`
    // when they want a clear, so this matches the required behavior
    // without depending on transition tracking.
    let hydrated = false;
    effect(() => {
      const user = this.auth.user();
      if (!user) {
        this._serverSnapshot.set(null);
        this._queue.set([]);
        this._inFlight.set(null);
        this._drainGen++;
        hydrated = false;
        tryStorage(() => {
          localStorage.removeItem(CACHE_KEY);
          localStorage.removeItem(QUEUE_KEY);
        });
      } else if (!hydrated) {
        hydrated = true;
        this.hydrateFromStorage();
      }
    });

    // Drain trigger: any time the browser comes back online, try to
    // flush the queue. The `tryDrain` guard makes this idempotent.
    // Server platform has no `window` and no online/offline lifecycle,
    // so the subscription is browser-only. Static prerender never
    // queues writes (no auth, no mutators).
    if (this.isBrowser) {
      fromEvent(window, 'online')
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => this.tryDrain());
    }

    // Also kick a drain when the user signs in (and is online with a
    // non-empty queue). This handles the cold-start case where the
    // tab opens with a previously-persisted queue.
    effect(() => {
      const user = this.auth.user();
      const queueLen = this._queue().length;
      if (this.isBrowser && user && queueLen > 0 && navigator.onLine) {
        this.tryDrain();
      }
    });

    // M6g-1: emit `ruleSets.applied` whenever the active rule-set
    // selection changes. Because every mutator funnels through
    // `preferences.update({ activeRuleSetIds })` (setActives,
    // toggleActive, the delete() pruning path, and the
    // PreferencesService server-hydration path), a single effect on the
    // computed signal captures user toggles AND server-driven hydration
    // uniformly without double-counting. We skip the synchronous initial
    // run (the default empty state before any preferences have loaded)
    // so a signed-out user with no hydration produces zero events; the
    // first real change - whether hydration to `[]` or to a populated
    // list, or a user toggle - is the first emit.
    let appliedFirstRun = true;
    effect(() => {
      const ids = this.activeRuleSetIds();
      if (appliedFirstRun) {
        appliedFirstRun = false;
        return;
      }
      this.logger.info('ruleSets.applied', { activeCount: ids.length });
    });
  }

  list(): Observable<FormattingRuleSet[]> {
    return this.http
      .get<FormattingRuleSet[]>(this.base)
      .pipe(tap((sets) => this._serverSnapshot.set(sets)));
  }

  get(id: string): Observable<FormattingRuleSet> {
    return this.http.get<FormattingRuleSet>(`${this.base}/${encodeURIComponent(id)}`).pipe(
      // Seed the snapshot so a subsequent offline `update()` can
      // synthesize an optimistic value from cache (rule-editor cold
      // start opens via `get`, not `list`).
      tap((set) => this.applyServerSet(set)),
    );
  }

  create(payload: RuleSetPayload): Observable<FormattingRuleSet> {
    return this.http.post<FormattingRuleSet>(this.base, payload).pipe(
      tap((created) => {
        this.applyServerSet(created);
        this.logger.info('ruleSets.created', {
          ruleCount: created.rules.length,
          source: 'manual',
        });
      }),
    );
  }

  update(id: string, payload: RuleSetPayload, version: number): Observable<FormattingRuleSet> {
    if (this.shouldQueue()) {
      const userId = this.auth.user()?.id;
      if (userId) {
        return this.enqueueUpdate(userId, id, payload, version);
      }
      // No userId means we can't tag a queue entry; fall through to
      // live HTTP and let the server's auth layer reject. Test specs
      // exercise this path with no fake user signed in.
    }
    const headers = new HttpHeaders({ 'If-Match': `"${version}"` });
    return this.http
      .put<FormattingRuleSet>(`${this.base}/${encodeURIComponent(id)}`, payload, { headers })
      .pipe(
        tap((next) => {
          this.applyServerSet(next);
          this.logger.info('ruleSets.updated', ruleSetSaveTelemetryProps(next.rules));
        }),
        catchError((err: HttpErrorResponse) => {
          // Status 0 is a network failure (offline mid-request, DNS,
          // CORS preflight blocked). The request may or may not have
          // reached the server; we treat it as offline-equivalent and
          // queue. A subsequent 412 on drain surfaces as a conflict
          // event - the same UX as a real conflict - which is the best
          // we can do without a server-side idempotency key.
          if (err.status === 0) {
            const userId = this.auth.user()?.id;
            if (userId) {
              return this.enqueueUpdate(userId, id, payload, version);
            }
          }
          return throwError(() => err);
        }),
      );
  }

  delete(id: string): Observable<void> {
    if (this.shouldQueue()) {
      const userId = this.auth.user()?.id;
      if (userId) {
        return this.enqueueDelete(userId, id);
      }
      // No userId; fall through. See update() for rationale.
    }
    return this.http.delete<void>(`${this.base}/${encodeURIComponent(id)}`).pipe(
      tap(() => {
        this.applyServerDelete(id);
        this.pruneActives(id);
        this.logger.info('ruleSets.deleted');
      }),
      catchError((err: HttpErrorResponse) => {
        if (err.status === 0) {
          const userId = this.auth.user()?.id;
          if (userId) {
            return this.enqueueDelete(userId, id);
          }
        }
        return throwError(() => err);
      }),
    );
  }

  listPresets(): Observable<RuleSetPreset[]> {
    return this.http.get<RuleSetPreset[]>(`${environment.apiBaseUrl}/rule-set-presets`);
  }

  clonePreset(presetId: string): Observable<FormattingRuleSet> {
    return this.http
      .post<FormattingRuleSet>(
        `${environment.apiBaseUrl}/rule-set-presets/${encodeURIComponent(presetId)}/clone`,
        {},
      )
      .pipe(
        tap((created) => {
          this.applyServerSet(created);
          this.logger.info('ruleSets.created', {
            ruleCount: created.rules.length,
            source: 'preset',
          });
        }),
      );
  }

  /**
   * Mutate `UserPreferences.activeRuleSetIds`. Callers pass the full ID
   * list; we filter out any IDs not present in the cache so the persisted
   * value does not accumulate dangling references after deletes from
   * other tabs. We DO NOT enforce ordering - the engine consumes them in
   * caller-supplied (== createdAt) order, but the toolbar may reorder
   * for display.
   */
  setActives(ids: readonly string[]): void {
    const cache = this.ruleSets();
    const known = cache ? new Set(cache.map((s) => s.id)) : null;
    const filtered = known ? ids.filter((id) => known.has(id)) : Array.from(ids);
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
    const cache = this.ruleSets();
    if (cache && !cache.some((s) => s.id === id)) return;
    const current = this.preferences.prefs().activeRuleSetIds;
    if (current.includes(id)) {
      this.setActives(current.filter((x) => x !== id));
    } else {
      this.setActives([...current, id]);
    }
  }

  /**
   * Refresh the cache from the server. Sugar over `list()` that swallows
   * the result; consumers that care about the response should call
   * `list()` directly. Kept to make "the toolbar opened, refresh me"
   * call-sites read clearly.
   */
  refresh(): void {
    this.list()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () => {
          /* surface via syncState if/when we add it; silent for now */
        },
      });
  }

  // ---- offline pattern internals -------------------------------------

  private shouldQueue(): boolean {
    return !navigator.onLine || this._queue().length > 0 || this._inFlight() !== null;
  }

  private enqueueUpdate(
    userId: string,
    id: string,
    payload: RuleSetPayload,
    baseVersion: number,
  ): Observable<FormattingRuleSet> {
    // Need a current cached entry to synthesize an optimistic result.
    // Editor flows always satisfy this because `get(id)` runs on cold
    // start and seeds the snapshot.
    const current = this.ruleSets()?.find((s) => s.id === id);
    if (!current) {
      return throwError(() => new Error('rule set not in cache'));
    }
    const optimistic: FormattingRuleSet = {
      ...current,
      name: payload.name,
      rules: payload.rules,
      updatedAt: new Date().toISOString(),
    };
    const item: QueuedWrite = {
      kind: 'update',
      userId,
      id,
      payload,
      baseVersion,
    };
    this._queue.update((q) => coalesce(q, item, this._inFlight() !== null));
    // Kick a drain immediately - if we're online, the queue should
    // start emptying without waiting for an `online` event (this
    // covers the status-0-on-online-path fallback). We invoke
    // synchronously rather than via `queueMicrotask` so that callers
    // (and tests) see the resulting HTTP request without an extra
    // microtask flush; `tryDrain` is idempotent so re-entry is safe.
    this.tryDrain();
    return of(optimistic);
  }

  private enqueueDelete(userId: string, id: string): Observable<void> {
    // Optimistically prune activeRuleSetIds so the toolbar / profile
    // reflect the user's intent immediately. If the eventual drain
    // fails permanently (4xx), the post-error refresh() restores the
    // canonical state.
    this.pruneActives(id);
    const item: QueuedWrite = { kind: 'delete', userId, id };
    this._queue.update((q) => coalesce(q, item, this._inFlight() !== null));
    this.tryDrain();
    return of(undefined);
  }

  private tryDrain(): void {
    if (this._inFlight() !== null) return;
    if (!navigator.onLine) return;
    const head = this._queue()[0];
    if (!head) return;
    const userId = this.auth.user()?.id;
    if (!userId) return;
    if (head.userId !== userId) {
      // Stale cross-user item; drop and recurse.
      this._queue.update((q) => q.slice(1));
      this.tryDrain();
      return;
    }
    this._inFlight.set(head);
    this._queue.update((q) => q.slice(1));
    const gen = this._drainGen;
    if (head.kind === 'update') {
      const headers = new HttpHeaders({ 'If-Match': `"${head.baseVersion}"` });
      this.http
        .put<FormattingRuleSet>(`${this.base}/${encodeURIComponent(head.id)}`, head.payload, {
          headers,
        })
        .subscribe({
          next: (set) => {
            if (gen !== this._drainGen) return;
            this._inFlight.set(null);
            this.applyServerSet(set);
            this.logger.info('ruleSets.updated', ruleSetSaveTelemetryProps(set.rules));
            this.tryDrain();
          },
          error: (err: HttpErrorResponse) => {
            if (gen !== this._drainGen) return;
            this.handleDrainError(head, err);
          },
        });
    } else {
      this.http.delete<void>(`${this.base}/${encodeURIComponent(head.id)}`).subscribe({
        next: () => {
          if (gen !== this._drainGen) return;
          this._inFlight.set(null);
          this.applyServerDelete(head.id);
          this.logger.info('ruleSets.deleted');
          this.tryDrain();
        },
        error: (err: HttpErrorResponse) => {
          if (gen !== this._drainGen) return;
          // Idempotent delete: if the server says it doesn't exist,
          // treat as success and drop the queue head.
          if (err.status === 404 && head.kind === 'delete') {
            this._inFlight.set(null);
            this.applyServerDelete(head.id);
            this.tryDrain();
            return;
          }
          this.handleDrainError(head, err);
        },
      });
    }
  }

  private handleDrainError(head: QueuedWrite, err: HttpErrorResponse): void {
    const status = err.status ?? 0;
    if (status === 412 && head.kind === 'update') {
      this._inFlight.set(null);
      this.events$.next({ kind: 'conflict', id: head.id });
      this.refresh();
      this.tryDrain();
      return;
    }
    if (status >= 400 && status < 500) {
      this._inFlight.set(null);
      this.events$.next({ kind: 'error', id: head.id, status });
      this.refresh();
      this.tryDrain();
      return;
    }
    // 5xx / status 0: requeue at head and stop draining. The next
    // `online` event (or the next user-driven write) will retry.
    this._queue.update((q) => [head, ...q]);
    this._inFlight.set(null);
  }

  private applyServerSet(set: FormattingRuleSet): void {
    const current = this._serverSnapshot();
    if (!current) {
      this._serverSnapshot.set([set]);
      return;
    }
    const idx = current.findIndex((s) => s.id === set.id);
    if (idx === -1) {
      this._serverSnapshot.set([...current, set]);
    } else {
      const next = current.slice();
      next[idx] = set;
      this._serverSnapshot.set(next);
    }
  }

  private applyServerDelete(id: string): void {
    const current = this._serverSnapshot();
    if (!current) return;
    this._serverSnapshot.set(current.filter((s) => s.id !== id));
  }

  private pruneActives(id: string): void {
    const currentActives = this.preferences.prefs().activeRuleSetIds;
    if (currentActives.includes(id)) {
      this.preferences.update({
        activeRuleSetIds: currentActives.filter((x) => x !== id),
      });
    }
  }

  private hydrateFromStorage(): void {
    const userId = this.auth.user()?.id ?? null;
    // Cache: keep only if the persisted userId matches the current
    // user. Otherwise purge.
    const envelope = readJson<CacheEnvelope>(CACHE_KEY);
    if (envelope && envelope.userId === userId && Array.isArray(envelope.sets)) {
      this._serverSnapshot.set(envelope.sets);
    } else if (envelope) {
      tryStorage(() => localStorage.removeItem(CACHE_KEY));
    }
    // Queue: filter to the current user; defense in depth.
    const persistedQueue = readJson<QueuedWrite[]>(QUEUE_KEY);
    if (persistedQueue && Array.isArray(persistedQueue)) {
      const filtered = userId
        ? persistedQueue.filter((item) => item && item.userId === userId)
        : [];
      this._queue.set(filtered);
      if (filtered.length !== persistedQueue.length) {
        tryStorage(() => {
          if (filtered.length === 0) {
            localStorage.removeItem(QUEUE_KEY);
          } else {
            localStorage.setItem(QUEUE_KEY, JSON.stringify(filtered));
          }
        });
      }
    }
  }
}

function ruleSetSaveTelemetryProps(rules: readonly FormattingRule[]): TelemetryProps {
  let pairRuleCount = 0;
  let predicateRuleCount = 0;

  for (const rule of rules) {
    if (!isPairFormattingRule(rule)) {
      continue;
    }

    pairRuleCount++;
    if (rule.valueMatch.kind === 'predicate') {
      predicateRuleCount++;
    }
  }

  return {
    ruleCount: rules.length,
    pairRuleCount,
    predicateRuleCount,
  };
}

function isPairFormattingRule(
  rule: FormattingRule,
): rule is Extract<FormattingRule, { kind: 'pair' }> {
  return (rule.kind ?? 'simple') === 'pair';
}

/**
 * Apply the queued writes (in order) on top of the server snapshot to
 * produce the optimistic view shown to the UI. Updates that target an
 * id not present in the snapshot are skipped (would otherwise leak
 * partial server state); deletes cleanly remove the matching entry.
 */
function projectQueue(
  snapshot: FormattingRuleSet[],
  writes: readonly QueuedWrite[],
): FormattingRuleSet[] {
  let working = snapshot.slice();
  for (const item of writes) {
    if (item.kind === 'delete') {
      working = working.filter((s) => s.id !== item.id);
      continue;
    }
    const idx = working.findIndex((s) => s.id === item.id);
    if (idx === -1) continue;
    const current = working[idx];
    working[idx] = {
      ...current,
      name: item.payload.name,
      rules: item.payload.rules,
      updatedAt: current.updatedAt,
    };
  }
  return working;
}

/**
 * Coalesce a new queued write into the existing queue per M6g-4 plan:
 *
 * - new `update`: replace any tail-queued `update` for the same id
 *   (latest payload wins, baseVersion stays the original); a tail
 *   `delete` for the same id wins, so the new update is dropped.
 * - new `delete`: remove all prior items for the same id and append.
 *
 * `headInFlight` marks the head item as untouchable - its body has
 * been sent on the wire. New writes coalesce only against indices
 * `>= 1` in that case.
 */
function coalesce(
  queue: readonly QueuedWrite[],
  next: QueuedWrite,
  headInFlight: boolean,
): QueuedWrite[] {
  const startIndex = headInFlight ? 1 : 0;
  if (next.kind === 'delete') {
    const kept: QueuedWrite[] = [];
    for (let i = 0; i < queue.length; i++) {
      if (i >= startIndex && queue[i].id === next.id) continue;
      kept.push(queue[i]);
    }
    kept.push(next);
    return kept;
  }
  // new update: scan from the tail for a coalesce target.
  for (let i = queue.length - 1; i >= startIndex; i--) {
    const existing = queue[i];
    if (existing.id !== next.id) continue;
    if (existing.kind === 'delete') {
      // A delete is queued after this update would land - the delete
      // wins. Drop the new update.
      return queue.slice();
    }
    const merged: QueuedWrite = {
      kind: 'update',
      userId: existing.userId,
      id: existing.id,
      payload: next.payload,
      baseVersion: existing.baseVersion,
    };
    const out = queue.slice();
    out[i] = merged;
    return out;
  }
  return [...queue, next];
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function tryStorage(fn: () => void): void {
  try {
    fn();
  } catch {
    /* private mode / quota / blocked - best effort */
  }
}
