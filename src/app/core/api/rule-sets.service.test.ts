import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { type Mock } from 'vitest';
import { environment } from '../../../environments/environment';
import { provideFakeAuth, signInFakeUser } from '../../../testing/auth.testing';
import { AuthUser } from '../auth/auth-user';
import { AuthService } from '../auth/auth.service';
import { PreferencesService } from '../preferences/preferences.service';
import { LoggerService } from '../telemetry/logger.service';
import {
  FormattingRule,
  FormattingRuleSet,
  FormattingRuleSimple,
  RuleSetPayload,
  RuleSetPreset,
} from './models';
import { RuleSetsService } from './rule-sets.service';

const BASE = `${environment.apiBaseUrl}/rule-sets`;
const PRESETS_BASE = `${environment.apiBaseUrl}/rule-set-presets`;

type PairFormattingRule = Extract<FormattingRule, { kind: 'pair' }>;

function makeRule(overrides: Partial<FormattingRuleSimple> = {}): FormattingRuleSimple {
  return {
    id: 'rule-1',
    target: 'key',
    matchType: 'exact',
    matchValue: 'error',
    caseSensitive: false,
    style: { backgroundColor: '#ffcdd2' },
    ...overrides,
  };
}

function makePairRule(overrides: Partial<PairFormattingRule> = {}): PairFormattingRule {
  return {
    id: 'pair-1',
    kind: 'pair',
    keyMatch: {
      matchType: 'exact',
      matchValue: 'status',
      caseSensitive: false,
    },
    valueMatch: {
      kind: 'text',
      matchType: 'exact',
      matchValue: 'error',
      caseSensitive: false,
    },
    style: { backgroundColor: '#bbdefb' },
    ...overrides,
  };
}

function makeSet(overrides: Partial<FormattingRuleSet> = {}): FormattingRuleSet {
  return {
    id: 'set-1',
    userId: 'oid-1',
    name: 'My Set',
    rules: [makeRule()],
    version: 1,
    createdAt: '2026-04-27T00:00:00.000Z',
    updatedAt: '2026-04-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('RuleSetsService', () => {
  let service: RuleSetsService;
  let httpMock: HttpTestingController;
  let preferences: PreferencesService;
  let auth: AuthService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideFakeAuth()],
    });
    service = TestBed.inject(RuleSetsService);
    httpMock = TestBed.inject(HttpTestingController);
    preferences = TestBed.inject(PreferencesService);
    auth = TestBed.inject(AuthService);
  });

  afterEach(() => httpMock.verify());

  describe('list()', () => {
    it('GETs /api/rule-sets and seeds the cache', () => {
      const sets = [makeSet({ id: 'a' }), makeSet({ id: 'b' })];
      let received: FormattingRuleSet[] | null = null;
      service.list().subscribe((v) => {
        received = v;
      });
      const req = httpMock.expectOne(BASE);
      expect(req.request.method).toBe('GET');
      req.flush(sets);
      expect(received as FormattingRuleSet[] | null).toEqual(sets);
      expect(service.ruleSets()).toEqual(sets);
    });

    it('overwrites the cache on subsequent calls', () => {
      service.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a' })]);
      service.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'b' })]);
      expect(service.ruleSets()?.map((s) => s.id)).toEqual(['b']);
    });

    it('starts with a null cache', () => {
      expect(service.ruleSets()).toBeNull();
    });
  });

  describe('get()', () => {
    it('GETs /api/rule-sets/{id} URL-encoding the id', () => {
      service.get('weird/id').subscribe();
      const req = httpMock.expectOne(`${BASE}/weird%2Fid`);
      expect(req.request.method).toBe('GET');
      req.flush(makeSet({ id: 'weird/id' }));
    });

    it('seeds the cache from a successful single-doc read (M6g-4)', () => {
      // Cold-start cache so an offline `update()` from the editor has
      // an entry to derive its optimistic value from.
      service.get('a').subscribe();
      httpMock.expectOne(`${BASE}/a`).flush(makeSet({ id: 'a' }));
      expect(service.ruleSets()?.map((s) => s.id)).toEqual(['a']);
    });
  });

  describe('create()', () => {
    const payload: RuleSetPayload = { name: 'X', rules: [makeRule()] };

    it('POSTs the payload and adds the result to the cache', () => {
      service.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a' })]);

      service.create(payload).subscribe();
      const req = httpMock.expectOne(BASE);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual(payload);
      req.flush(makeSet({ id: 'b', name: 'X' }));

      expect(service.ruleSets()?.map((s) => s.id)).toEqual(['a', 'b']);
    });

    it('seeds the cache when the cache is empty', () => {
      expect(service.ruleSets()).toBeNull();
      service.create(payload).subscribe();
      httpMock.expectOne(BASE).flush(makeSet({ id: 'a' }));
      expect(service.ruleSets()?.map((s) => s.id)).toEqual(['a']);
    });

    it('does NOT update the cache when the request fails', () => {
      service.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a' })]);

      service.create(payload).subscribe({ error: () => undefined });
      httpMock
        .expectOne(BASE)
        .flush({ error: 'boom' }, { status: 500, statusText: 'Server Error' });

      expect(service.ruleSets()?.map((s) => s.id)).toEqual(['a']);
    });
  });

  describe('update()', () => {
    const payload: RuleSetPayload = { name: 'Renamed', rules: [makeRule()] };

    it('PUTs with If-Match header carrying the version', () => {
      service.update('a', payload, 7).subscribe();
      const req = httpMock.expectOne(`${BASE}/a`);
      expect(req.request.method).toBe('PUT');
      expect(req.request.headers.get('If-Match')).toBe('"7"');
      expect(req.request.body).toEqual(payload);
      req.flush(makeSet({ id: 'a', name: 'Renamed', version: 8 }));
    });

    it('replaces the cached entry on success', () => {
      service.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a', version: 7 })]);
      service.update('a', payload, 7).subscribe();
      httpMock.expectOne(`${BASE}/a`).flush(makeSet({ id: 'a', name: 'Renamed', version: 8 }));
      const cache = service.ruleSets();
      expect(cache?.length).toBe(1);
      expect(cache?.[0].name).toBe('Renamed');
      expect(cache?.[0].version).toBe(8);
    });

    it('leaves the cache untouched on 412 conflict', () => {
      service.list().subscribe();
      const original = makeSet({ id: 'a', version: 7, name: 'Original' });
      httpMock.expectOne(BASE).flush([original]);

      service.update('a', payload, 7).subscribe({ error: () => undefined });
      httpMock
        .expectOne(`${BASE}/a`)
        .flush({ error: 'conflict' }, { status: 412, statusText: 'Precondition Failed' });
      expect(service.ruleSets()?.[0]).toEqual(original);
    });
  });

  describe('delete()', () => {
    it('DELETEs and removes the entry from the cache', () => {
      service.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a' }), makeSet({ id: 'b' })]);
      service.delete('a').subscribe();
      const req = httpMock.expectOne(`${BASE}/a`);
      expect(req.request.method).toBe('DELETE');
      req.flush(null, { status: 204, statusText: 'No Content' });
      expect(service.ruleSets()?.map((s) => s.id)).toEqual(['b']);
    });

    it('strips the deleted ID from activeRuleSetIds when present', () => {
      service.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a' }), makeSet({ id: 'b' })]);
      preferences.update({ activeRuleSetIds: ['a', 'b'] });

      service.delete('a').subscribe();
      httpMock.expectOne(`${BASE}/a`).flush(null, { status: 204, statusText: 'No Content' });

      expect(preferences.prefs().activeRuleSetIds).toEqual(['b']);
    });

    it('does not touch activeRuleSetIds when the deleted ID was not active', () => {
      service.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a' }), makeSet({ id: 'b' })]);
      preferences.update({ activeRuleSetIds: ['b'] });

      service.delete('a').subscribe();
      httpMock.expectOne(`${BASE}/a`).flush(null, { status: 204, statusText: 'No Content' });

      expect(preferences.prefs().activeRuleSetIds).toEqual(['b']);
    });

    it('does not modify the cache when the request fails', () => {
      service.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a' })]);

      service.delete('a').subscribe({ error: () => undefined });
      httpMock
        .expectOne(`${BASE}/a`)
        .flush({ error: 'nope' }, { status: 500, statusText: 'Server Error' });
      expect(service.ruleSets()?.map((s) => s.id)).toEqual(['a']);
    });
  });

  describe('listPresets()', () => {
    it('GETs /api/rule-set-presets', () => {
      const presets: RuleSetPreset[] = [
        { id: 'error-detection', name: 'Errors', rules: [makeRule()] },
      ];
      let received: RuleSetPreset[] | null = null;
      service.listPresets().subscribe((v) => {
        received = v;
      });
      const req = httpMock.expectOne(PRESETS_BASE);
      expect(req.request.method).toBe('GET');
      req.flush(presets);
      expect(received as RuleSetPreset[] | null).toEqual(presets);
      expect(service.ruleSets()).toBeNull();
    });
  });

  describe('clonePreset()', () => {
    it('POSTs to /api/rule-set-presets/{id}/clone with empty body', () => {
      service.clonePreset('error-detection').subscribe();
      const req = httpMock.expectOne(`${PRESETS_BASE}/error-detection/clone`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({});
      req.flush(makeSet({ id: 'cloned', name: 'Errors' }));
    });

    it('adds the cloned set to the cache', () => {
      service.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a' })]);

      service.clonePreset('error-detection').subscribe();
      httpMock
        .expectOne(`${PRESETS_BASE}/error-detection/clone`)
        .flush(makeSet({ id: 'cloned', name: 'Errors' }));

      expect(service.ruleSets()?.map((s) => s.id)).toEqual(['a', 'cloned']);
    });

    it('URL-encodes the preset id', () => {
      service.clonePreset('weird id').subscribe();
      httpMock.expectOne(`${PRESETS_BASE}/weird%20id/clone`).flush(makeSet());
    });
  });

  describe('activeRuleSetIds / activeRuleSets', () => {
    it('mirrors PreferencesService.prefs().activeRuleSetIds', () => {
      preferences.update({ activeRuleSetIds: ['a', 'b'] });
      expect(service.activeRuleSetIds()).toEqual(['a', 'b']);
    });

    it('resolves activeRuleSets in user-configured order, dropping unknown IDs', () => {
      const a = makeSet({ id: 'a' });
      const b = makeSet({ id: 'b' });
      const c = makeSet({ id: 'c' });
      service.list().subscribe();
      httpMock.expectOne(BASE).flush([a, b, c]);
      preferences.update({ activeRuleSetIds: ['c', 'unknown', 'a'] });
      expect(service.activeRuleSets().map((s) => s.id)).toEqual(['c', 'a']);
    });

    it('returns an empty list when the cache has not loaded', () => {
      preferences.update({ activeRuleSetIds: ['a'] });
      expect(service.ruleSets()).toBeNull();
      expect(service.activeRuleSets()).toEqual([]);
    });
  });

  describe('setActives() / toggleActive()', () => {
    beforeEach(() => {
      service.list().subscribe();
      httpMock
        .expectOne(BASE)
        .flush([makeSet({ id: 'a' }), makeSet({ id: 'b' }), makeSet({ id: 'c' })]);
    });

    it('setActives() filters out IDs not present in the cache', () => {
      service.setActives(['a', 'unknown', 'c']);
      expect(preferences.prefs().activeRuleSetIds).toEqual(['a', 'c']);
    });

    it('setActives() de-duplicates while preserving first-seen order', () => {
      service.setActives(['c', 'a', 'c', 'b', 'a']);
      expect(preferences.prefs().activeRuleSetIds).toEqual(['c', 'a', 'b']);
    });

    it('toggleActive() adds an unknown-to-prefs ID to the end', () => {
      preferences.update({ activeRuleSetIds: ['a'] });
      service.toggleActive('b');
      expect(preferences.prefs().activeRuleSetIds).toEqual(['a', 'b']);
    });

    it('toggleActive() removes an active ID', () => {
      preferences.update({ activeRuleSetIds: ['a', 'b'] });
      service.toggleActive('a');
      expect(preferences.prefs().activeRuleSetIds).toEqual(['b']);
    });

    it('toggleActive() is a no-op for IDs not in the cache', () => {
      preferences.update({ activeRuleSetIds: ['a'] });
      service.toggleActive('does-not-exist');
      expect(preferences.prefs().activeRuleSetIds).toEqual(['a']);
    });
  });

  describe('setActives() before cache loads', () => {
    it('accepts ids verbatim when the cache is null (no filter)', () => {
      // Pre-cache callers (e.g. server hydration) must not be silently
      // dropped just because list() has not resolved yet.
      service.setActives(['x', 'y']);
      expect(preferences.prefs().activeRuleSetIds).toEqual(['x', 'y']);
    });
  });

  describe('sign-out lifecycle', () => {
    it('clears the cache when the auth user becomes null', () => {
      const user: AuthUser = { id: 'oid-1', displayName: 'A', email: 'a@b' };
      signInFakeUser(auth, { user });
      service.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a' })]);
      // Drain any preferences hydration HTTP triggered by sign-in so the
      // outer afterEach `httpMock.verify()` does not flag it.
      const pendingMe = httpMock.match(`${environment.apiBaseUrl}/me`);
      pendingMe.forEach((r) => r.flush(null, { status: 404, statusText: 'Not Found' }));
      expect(service.ruleSets()?.length).toBe(1);

      (auth as unknown as { userSignal: { set(v: AuthUser | null): void } }).userSignal.set(null);
      TestBed.flushEffects();
      expect(service.ruleSets()).toBeNull();
    });
  });

  describe('refresh()', () => {
    it('issues a list() request', () => {
      service.refresh();
      const req = httpMock.expectOne(BASE);
      expect(req.request.method).toBe('GET');
      req.flush([makeSet({ id: 'a' })]);
      expect(service.ruleSets()?.map((s) => s.id)).toEqual(['a']);
    });

    it('swallows errors', () => {
      service.refresh();
      httpMock
        .expectOne(BASE)
        .flush({ error: 'boom' }, { status: 500, statusText: 'Server Error' });
      // No throw, no unhandled rejection. Cache unchanged.
      expect(service.ruleSets()).toBeNull();
    });
  });

  describe('telemetry (M6g-1)', () => {
    let logger: LoggerService;
    let infoSpy: Mock;

    beforeEach(() => {
      // Re-resolve the logger from the same TestBed used by the outer
      // `beforeEach` so the spy intercepts the same instance the
      // service has already injected.
      logger = TestBed.inject(LoggerService);
      infoSpy = vi.spyOn(logger, 'info');
      // Drain the constructor's first effect run so subsequent
      // preference changes are captured as real emits.
      TestBed.flushEffects();
    });

    function saveRulesAndReadUpdatedTelemetry(
      rules: FormattingRule[],
      expectedTelemetry: {
        ruleCount: number;
        pairRuleCount: number;
        predicateRuleCount: number;
      },
    ): Record<string, unknown> {
      const payload: RuleSetPayload = { name: 'X', rules };
      service.update('a', payload, 7).subscribe();
      httpMock.expectOne(`${BASE}/a`).flush(makeSet({ id: 'a', rules }));
      expect(infoSpy).toHaveBeenCalledWith('ruleSets.updated', expectedTelemetry);
      const matchingCall = infoSpy.mock.calls.find((args) => args[0] === 'ruleSets.updated');
      expect(matchingCall).toBeDefined();
      return matchingCall?.[1] as Record<string, unknown>;
    }

    it('emits ruleSets.created with manual source on create() success', () => {
      const payload: RuleSetPayload = { name: 'X', rules: [makeRule()] };
      service.create(payload).subscribe();
      const req = httpMock.expectOne(BASE);
      expect(req.request.method).toBe('POST');
      req.flush(makeSet({ id: 'b', rules: [makeRule(), makeRule({ id: 'r2' })] }));
      expect(infoSpy).toHaveBeenCalledWith('ruleSets.created', {
        ruleCount: 2,
        source: 'manual',
      });
    });

    it('does NOT emit ruleSets.created when create() fails', () => {
      const payload: RuleSetPayload = { name: 'X', rules: [makeRule()] };
      service.create(payload).subscribe({ error: () => undefined });
      httpMock
        .expectOne(BASE)
        .flush({ error: 'boom' }, { status: 500, statusText: 'Server Error' });
      expect(infoSpy).not.toHaveBeenCalledWith('ruleSets.created', expect.anything());
    });

    it('emits zero pair and predicate counts when saved rules are all simple', () => {
      saveRulesAndReadUpdatedTelemetry(
        [
          makeRule({ id: 'r1', kind: 'simple' }),
          makeRule({ id: 'r2', kind: 'simple' }),
          makeRule({ id: 'r3', kind: 'simple' }),
        ],
        { ruleCount: 3, pairRuleCount: 0, predicateRuleCount: 0 },
      );
    });

    it('emits pair and predicate counts when saved rules mix simple, text-pair, and predicate-pair rules', () => {
      saveRulesAndReadUpdatedTelemetry(
        [
          makeRule({ id: 'r1', kind: 'simple' }),
          makePairRule({ id: 'pair-text' }),
          makePairRule({
            id: 'pair-predicate',
            valueMatch: { kind: 'predicate', predicate: 'is_null' },
          }),
        ],
        { ruleCount: 3, pairRuleCount: 2, predicateRuleCount: 1 },
      );
    });

    it('emits matching pair and predicate counts when all saved pair rules use predicates', () => {
      saveRulesAndReadUpdatedTelemetry(
        [
          makePairRule({
            id: 'pair-null',
            valueMatch: { kind: 'predicate', predicate: 'is_null' },
          }),
          makePairRule({
            id: 'pair-empty',
            valueMatch: { kind: 'predicate', predicate: 'is_empty' },
          }),
        ],
        { ruleCount: 2, pairRuleCount: 2, predicateRuleCount: 2 },
      );
    });

    it('treats saved legacy rules with missing kind as simple for pair counts', () => {
      saveRulesAndReadUpdatedTelemetry(
        [makeRule({ id: 'legacy-1' }), makeRule({ id: 'legacy-2' })],
        { ruleCount: 2, pairRuleCount: 0, predicateRuleCount: 0 },
      );
    });

    it('does not include match values, key match shapes, or predicate identities in saved rule telemetry', () => {
      const telemetryPayload = saveRulesAndReadUpdatedTelemetry(
        [
          makePairRule({
            id: 'pair-private-text',
            keyMatch: { matchType: 'contains', matchValue: 'private-key', caseSensitive: true },
            valueMatch: {
              kind: 'text',
              matchType: 'contains',
              matchValue: 'private-value',
              caseSensitive: true,
            },
          }),
          makePairRule({
            id: 'pair-private-predicate',
            keyMatch: {
              matchType: 'starts_with',
              matchValue: 'secret-prefix',
              caseSensitive: false,
            },
            valueMatch: { kind: 'predicate', predicate: 'is_null' },
          }),
        ],
        { ruleCount: 2, pairRuleCount: 2, predicateRuleCount: 1 },
      );
      const telemetryJson = JSON.stringify(telemetryPayload);

      expect(telemetryJson).not.toContain('matchValue');
      expect(telemetryJson).not.toContain('keyMatch');
      expect(telemetryJson).not.toContain('is_null');
      expect(telemetryJson).not.toContain('private-key');
      expect(telemetryJson).not.toContain('private-value');
      expect(telemetryJson).not.toContain('secret-prefix');
    });

    it('does NOT emit ruleSets.updated on 412 conflict', () => {
      const payload: RuleSetPayload = { name: 'X', rules: [makeRule()] };
      service.update('a', payload, 7).subscribe({ error: () => undefined });
      httpMock
        .expectOne(`${BASE}/a`)
        .flush({ error: 'conflict' }, { status: 412, statusText: 'Precondition Failed' });
      expect(infoSpy).not.toHaveBeenCalledWith('ruleSets.updated', expect.anything());
    });

    it('emits ruleSets.deleted (no props) on delete() success', () => {
      service.delete('a').subscribe();
      httpMock.expectOne(`${BASE}/a`).flush(null, { status: 204, statusText: 'No Content' });
      expect(infoSpy).toHaveBeenCalledWith('ruleSets.deleted');
    });

    it('does NOT emit ruleSets.deleted when delete() fails', () => {
      service.delete('a').subscribe({ error: () => undefined });
      httpMock
        .expectOne(`${BASE}/a`)
        .flush({ error: 'boom' }, { status: 500, statusText: 'Server Error' });
      expect(infoSpy).not.toHaveBeenCalledWith('ruleSets.deleted', expect.anything());
    });

    it('emits ruleSets.created with preset source on clonePreset() success', () => {
      service.clonePreset('error-detection').subscribe();
      httpMock
        .expectOne(`${PRESETS_BASE}/error-detection/clone`)
        .flush(makeSet({ id: 'b', rules: [makeRule()] }));
      expect(infoSpy).toHaveBeenCalledWith('ruleSets.created', {
        ruleCount: 1,
        source: 'preset',
      });
    });

    it('emits ruleSets.applied with activeCount on every activeRuleSetIds change', () => {
      service.list().subscribe();
      httpMock
        .expectOne(BASE)
        .flush([makeSet({ id: 'a' }), makeSet({ id: 'b' }), makeSet({ id: 'c' })]);

      service.setActives(['a', 'b']);
      TestBed.flushEffects();
      expect(infoSpy).toHaveBeenCalledWith('ruleSets.applied', { activeCount: 2 });

      infoSpy.mockClear();
      service.toggleActive('c');
      TestBed.flushEffects();
      expect(infoSpy).toHaveBeenCalledWith('ruleSets.applied', { activeCount: 3 });

      infoSpy.mockClear();
      service.toggleActive('a');
      TestBed.flushEffects();
      expect(infoSpy).toHaveBeenCalledWith('ruleSets.applied', { activeCount: 2 });
    });

    it('emits ruleSets.applied when a delete prunes an active id from preferences', () => {
      service.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a' }), makeSet({ id: 'b' })]);
      service.setActives(['a', 'b']);
      TestBed.flushEffects();
      infoSpy.mockClear();

      service.delete('a').subscribe();
      httpMock.expectOne(`${BASE}/a`).flush(null, { status: 204, statusText: 'No Content' });
      TestBed.flushEffects();

      // delete() emits both 'deleted' AND 'applied' (because pruning
      // changed activeRuleSetIds from ['a','b'] to ['b']).
      expect(infoSpy).toHaveBeenCalledWith('ruleSets.deleted');
      expect(infoSpy).toHaveBeenCalledWith('ruleSets.applied', { activeCount: 1 });
    });

    it('does NOT emit ruleSets.applied for the synchronous initial run', () => {
      // The constructor effect has a one-shot guard that skips its
      // first run (the default-empty state before any preferences have
      // hydrated). The outer beforeEach already drained that run, so
      // a fresh check here should see no prior 'applied' emits.
      expect(infoSpy).not.toHaveBeenCalledWith('ruleSets.applied', expect.anything());
    });
  });

  describe('offline-first pattern (M6g-4)', () => {
    const CACHE_KEY = 'jotjson.ruleSets.cache.v1';
    const QUEUE_KEY = 'jotjson.ruleSets.queue.v1';

    function setOnline(value: boolean): void {
      Object.defineProperty(navigator, 'onLine', {
        configurable: true,
        get: () => value,
      });
    }

    function restoreOnline(): void {
      delete (navigator as { onLine?: boolean }).onLine;
    }

    function signedInService(): RuleSetsService {
      const user: AuthUser = { id: 'oid-1', displayName: 'A', email: 'a@b' };
      signInFakeUser(auth, { user });
      // Flush the auth-transition effects so PreferencesService fires
      // its sign-in /api/me hydration request, then drain it. Without
      // the flush the effect hasn't run yet, so match() returns nothing
      // and the request shows up later, after our test does its real
      // work, breaking the outer afterEach `httpMock.verify()`.
      TestBed.flushEffects();
      drainMeRequests(httpMock);
      // A 404 on GET /me triggers a follow-up POST /me to seed the
      // user doc - drain that too so it doesn't hang around.
      drainMeRequests(httpMock);
      return service;
    }

    function drainMeRequests(http: HttpTestingController): void {
      const pending = http.match((r) => r.url === `${environment.apiBaseUrl}/me`);
      pending.forEach((r) => {
        if (r.request.method === 'GET') {
          r.flush(null, { status: 404, statusText: 'Not Found' });
        } else {
          r.flush({ id: 'oid-1', preferences: {} }, { status: 200, statusText: 'OK' });
        }
      });
    }

    afterEach(() => {
      restoreOnline();
    });

    it('queues an offline update and shows the optimistic value via projection', () => {
      const svc = signedInService();
      svc.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a', version: 7, name: 'Original' })]);

      setOnline(false);
      const payload: RuleSetPayload = { name: 'Renamed', rules: [makeRule()] };
      svc.update('a', payload, 7).subscribe();
      // No HTTP fires while offline.
      httpMock.expectNone(`${BASE}/a`);
      expect(svc.ruleSets()?.[0].name).toBe('Renamed');
      expect(svc.pendingWriteIds().has('a')).toBe(true);
      expect(svc.pendingWriteCount()).toBe(1);
    });

    it('queues an offline delete, prunes defaults, and projects removal', () => {
      const svc = signedInService();
      svc.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a' }), makeSet({ id: 'b' })]);
      preferences.update({ activeRuleSetIds: ['a', 'b'] });

      setOnline(false);
      svc.delete('a').subscribe();
      httpMock.expectNone(`${BASE}/a`);
      expect(svc.ruleSets()?.map((s) => s.id)).toEqual(['b']);
      expect(preferences.prefs().activeRuleSetIds).toEqual(['b']);
      expect(svc.pendingWriteIds().has('a')).toBe(true);
    });

    it('drains queued writes when online event fires', () => {
      const svc = signedInService();
      svc.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a', version: 7 })]);

      setOnline(false);
      const payload: RuleSetPayload = { name: 'Renamed', rules: [makeRule()] };
      svc.update('a', payload, 7).subscribe();
      expect(svc.pendingWriteCount()).toBe(1);

      setOnline(true);
      window.dispatchEvent(new Event('online'));
      const req = httpMock.expectOne(`${BASE}/a`);
      expect(req.request.method).toBe('PUT');
      expect(req.request.headers.get('If-Match')).toBe('"7"');
      req.flush(makeSet({ id: 'a', name: 'Renamed', version: 8 }));

      expect(svc.pendingWriteCount()).toBe(0);
      expect(svc.ruleSets()?.[0].name).toBe('Renamed');
      expect(svc.ruleSets()?.[0].version).toBe(8);
    });

    it('emits a conflict event and resyncs on 412 during drain', () => {
      const svc = signedInService();
      svc.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a', version: 7 })]);

      setOnline(false);
      svc.update('a', { name: 'Renamed', rules: [makeRule()] }, 7).subscribe();

      const events: { kind: string; id: string }[] = [];
      svc.events$.subscribe((e) => events.push(e));

      setOnline(true);
      window.dispatchEvent(new Event('online'));
      httpMock
        .expectOne(`${BASE}/a`)
        .flush({ error: 'conflict' }, { status: 412, statusText: 'Precondition Failed' });
      // The post-conflict refresh fires a list().
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a', version: 9, name: 'ServerWon' })]);

      expect(events).toEqual([{ kind: 'conflict', id: 'a' }]);
      expect(svc.pendingWriteCount()).toBe(0);
      expect(svc.ruleSets()?.[0].name).toBe('ServerWon');
    });

    it('leaves the queue intact when drain hits a 5xx', () => {
      const svc = signedInService();
      svc.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a', version: 7 })]);

      setOnline(false);
      svc.update('a', { name: 'Renamed', rules: [makeRule()] }, 7).subscribe();

      setOnline(true);
      window.dispatchEvent(new Event('online'));
      httpMock
        .expectOne(`${BASE}/a`)
        .flush({ error: 'boom' }, { status: 503, statusText: 'Service Unavailable' });

      expect(svc.pendingWriteCount()).toBe(1);
      expect(svc.pendingWriteIds().has('a')).toBe(true);
    });

    it('coalesces consecutive offline updates: latest payload + first baseVersion', () => {
      const svc = signedInService();
      svc.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a', version: 7 })]);

      setOnline(false);
      svc.update('a', { name: 'V1', rules: [makeRule()] }, 7).subscribe();
      svc.update('a', { name: 'V2', rules: [makeRule()] }, 8).subscribe();
      expect(svc.pendingWriteCount()).toBe(1);
      expect(svc.ruleSets()?.[0].name).toBe('V2');

      setOnline(true);
      window.dispatchEvent(new Event('online'));
      const req = httpMock.expectOne(`${BASE}/a`);
      expect(req.request.body).toEqual({ name: 'V2', rules: [makeRule()] });
      // First baseVersion (7) wins so If-Match still matches the
      // server's current version.
      expect(req.request.headers.get('If-Match')).toBe('"7"');
      req.flush(makeSet({ id: 'a', name: 'V2', version: 8 }));
    });

    it('drops queued updates when a delete is queued for the same id', () => {
      const svc = signedInService();
      svc.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a', version: 7 })]);

      setOnline(false);
      svc.update('a', { name: 'Renamed', rules: [makeRule()] }, 7).subscribe();
      svc.delete('a').subscribe();
      expect(svc.pendingWriteCount()).toBe(1);
      expect(svc.ruleSets()?.map((s) => s.id)).toEqual([]);

      setOnline(true);
      window.dispatchEvent(new Event('online'));
      const req = httpMock.expectOne(`${BASE}/a`);
      expect(req.request.method).toBe('DELETE');
      req.flush(null, { status: 204, statusText: 'No Content' });
    });

    it('treats 404 on delete drain as idempotent success', () => {
      const svc = signedInService();
      svc.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a' })]);

      setOnline(false);
      svc.delete('a').subscribe();

      setOnline(true);
      window.dispatchEvent(new Event('online'));
      httpMock
        .expectOne(`${BASE}/a`)
        .flush({ error: 'gone' }, { status: 404, statusText: 'Not Found' });

      expect(svc.pendingWriteCount()).toBe(0);
      expect(svc.ruleSets()?.map((s) => s.id)).toEqual([]);
    });

    it('rejects a hydrated cache with a mismatched userId and removes the key', () => {
      // Persist a cache for a DIFFERENT user, then construct a new
      // service with the current user signed in.
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ userId: 'someone-else', sets: [makeSet({ id: 'x' })] }),
      );
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ providers: [provideFakeAuth()] });
      const newAuth = TestBed.inject(AuthService);
      const newSvc = TestBed.inject(RuleSetsService);
      const newHttp = TestBed.inject(HttpTestingController);
      signInFakeUser(newAuth, { user: { id: 'oid-1', displayName: 'A', email: 'a@b' } });
      TestBed.flushEffects();
      drainMeRequests(newHttp);
      drainMeRequests(newHttp);

      expect(newSvc.ruleSets()).toBeNull();
      expect(localStorage.getItem(CACHE_KEY)).toBeNull();
      newHttp.verify();
    });

    it('clears persisted cache + queue on sign-out', () => {
      const svc = signedInService();
      svc.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a' })]);
      TestBed.flushEffects();
      expect(localStorage.getItem(CACHE_KEY)).not.toBeNull();

      (auth as unknown as { userSignal: { set(v: AuthUser | null): void } }).userSignal.set(null);
      TestBed.flushEffects();

      expect(svc.ruleSets()).toBeNull();
      expect(localStorage.getItem(CACHE_KEY)).toBeNull();
      expect(localStorage.getItem(QUEUE_KEY)).toBeNull();
    });

    it('queues on a status-0 network failure during a live update', () => {
      const svc = signedInService();
      svc.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a', version: 7 })]);

      svc.update('a', { name: 'Renamed', rules: [makeRule()] }, 7).subscribe();
      // Live HTTP fires (online), but the request errors with status 0.
      const live = httpMock.expectOne(`${BASE}/a`);
      live.flush(null, {
        status: 0,
        statusText: 'Unknown Error',
      });

      // The catchError path should have re-routed via the queue and
      // immediately tried to drain. Since onLine is still true, drain
      // pops the queue and fires another PUT.
      const drained = httpMock.expectOne(`${BASE}/a`);
      expect(drained.request.method).toBe('PUT');
      drained.flush(makeSet({ id: 'a', name: 'Renamed', version: 8 }));

      expect(svc.pendingWriteCount()).toBe(0);
      expect(svc.ruleSets()?.[0].name).toBe('Renamed');
    });
  });
});
