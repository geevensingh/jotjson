import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { environment } from '../../../environments/environment';
import { AuthService } from '../auth/auth.service';
import { AuthUser } from '../auth/auth-user';
import { PreferencesService } from '../preferences/preferences.service';
import { LoggerService } from '../telemetry/logger.service';
import { provideFakeAuth, signInFakeUser } from '../../../testing/auth.testing';
import {
  FormattingRule,
  FormattingRuleSet,
  RuleSetPayload,
  RuleSetPreset
} from './models';
import { RuleSetsService } from './rule-sets.service';

const BASE = `${environment.apiBaseUrl}/rule-sets`;
const PRESETS_BASE = `${environment.apiBaseUrl}/rule-set-presets`;

function makeRule(overrides: Partial<FormattingRule> = {}): FormattingRule {
  return {
    id: 'rule-1',
    target: 'key',
    matchType: 'exact',
    matchValue: 'error',
    caseSensitive: false,
    style: { backgroundColor: '#ffcdd2' },
    ...overrides
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
    ...overrides
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
      providers: [provideFakeAuth()]
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

    it('does NOT touch the cache (single-doc reads are bypass-only)', () => {
      service.get('a').subscribe();
      httpMock.expectOne(`${BASE}/a`).flush(makeSet({ id: 'a' }));
      expect(service.ruleSets()).toBeNull();
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
      httpMock.expectOne(BASE).flush(
        { error: 'boom' },
        { status: 500, statusText: 'Server Error' }
      );

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
      httpMock.expectOne(`${BASE}/a`).flush(
        { error: 'conflict' },
        { status: 412, statusText: 'Precondition Failed' }
      );
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

    it('strips the deleted ID from defaultRuleSetIds when present', () => {
      service.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a' }), makeSet({ id: 'b' })]);
      preferences.update({ defaultRuleSetIds: ['a', 'b'] });

      service.delete('a').subscribe();
      httpMock.expectOne(`${BASE}/a`).flush(null, { status: 204, statusText: 'No Content' });

      expect(preferences.prefs().defaultRuleSetIds).toEqual(['b']);
    });

    it('does not touch defaultRuleSetIds when the deleted ID was not active', () => {
      service.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a' }), makeSet({ id: 'b' })]);
      preferences.update({ defaultRuleSetIds: ['b'] });

      service.delete('a').subscribe();
      httpMock.expectOne(`${BASE}/a`).flush(null, { status: 204, statusText: 'No Content' });

      expect(preferences.prefs().defaultRuleSetIds).toEqual(['b']);
    });

    it('does not modify the cache when the request fails', () => {
      service.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a' })]);

      service.delete('a').subscribe({ error: () => undefined });
      httpMock.expectOne(`${BASE}/a`).flush(
        { error: 'nope' },
        { status: 500, statusText: 'Server Error' }
      );
      expect(service.ruleSets()?.map((s) => s.id)).toEqual(['a']);
    });
  });

  describe('listPresets()', () => {
    it('GETs /api/rule-set-presets', () => {
      const presets: RuleSetPreset[] = [
        { id: 'error-detection', name: 'Errors', rules: [makeRule()] }
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

  describe('defaultRuleSetIds / activeRuleSets', () => {
    it('mirrors PreferencesService.prefs().defaultRuleSetIds', () => {
      preferences.update({ defaultRuleSetIds: ['a', 'b'] });
      expect(service.defaultRuleSetIds()).toEqual(['a', 'b']);
    });

    it('resolves activeRuleSets in user-configured order, dropping unknown IDs', () => {
      const a = makeSet({ id: 'a' });
      const b = makeSet({ id: 'b' });
      const c = makeSet({ id: 'c' });
      service.list().subscribe();
      httpMock.expectOne(BASE).flush([a, b, c]);
      preferences.update({ defaultRuleSetIds: ['c', 'unknown', 'a'] });
      expect(service.defaultRuleSets().map((s) => s.id)).toEqual(['c', 'a']);
    });

    it('returns an empty list when the cache has not loaded', () => {
      preferences.update({ defaultRuleSetIds: ['a'] });
      expect(service.ruleSets()).toBeNull();
      expect(service.defaultRuleSets()).toEqual([]);
    });
  });

  describe('setDefaults() / toggleDefault()', () => {
    beforeEach(() => {
      service.list().subscribe();
      httpMock.expectOne(BASE).flush([
        makeSet({ id: 'a' }),
        makeSet({ id: 'b' }),
        makeSet({ id: 'c' })
      ]);
    });

    it('setDefaults() filters out IDs not present in the cache', () => {
      service.setDefaults(['a', 'unknown', 'c']);
      expect(preferences.prefs().defaultRuleSetIds).toEqual(['a', 'c']);
    });

    it('setDefaults() de-duplicates while preserving first-seen order', () => {
      service.setDefaults(['c', 'a', 'c', 'b', 'a']);
      expect(preferences.prefs().defaultRuleSetIds).toEqual(['c', 'a', 'b']);
    });

    it('toggleDefault() adds an unknown-to-prefs ID to the end', () => {
      preferences.update({ defaultRuleSetIds: ['a'] });
      service.toggleDefault('b');
      expect(preferences.prefs().defaultRuleSetIds).toEqual(['a', 'b']);
    });

    it('toggleDefault() removes an active ID', () => {
      preferences.update({ defaultRuleSetIds: ['a', 'b'] });
      service.toggleDefault('a');
      expect(preferences.prefs().defaultRuleSetIds).toEqual(['b']);
    });

    it('toggleDefault() is a no-op for IDs not in the cache', () => {
      preferences.update({ defaultRuleSetIds: ['a'] });
      service.toggleDefault('does-not-exist');
      expect(preferences.prefs().defaultRuleSetIds).toEqual(['a']);
    });
  });

  describe('setDefaults() before cache loads', () => {
    it('accepts ids verbatim when the cache is null (no filter)', () => {
      // Pre-cache callers (e.g. server hydration) must not be silently
      // dropped just because list() has not resolved yet.
      service.setDefaults(['x', 'y']);
      expect(preferences.prefs().defaultRuleSetIds).toEqual(['x', 'y']);
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
    let infoSpy: jasmine.Spy;

    beforeEach(() => {
      // Re-resolve the logger from the same TestBed used by the outer
      // `beforeEach` so the spy intercepts the same instance the
      // service has already injected.
      logger = TestBed.inject(LoggerService);
      infoSpy = spyOn(logger, 'info');
      // Drain the constructor's first effect run so subsequent
      // preference changes are captured as real emits.
      TestBed.flushEffects();
    });

    it('emits ruleSets.created with manual source on create() success', () => {
      const payload: RuleSetPayload = { name: 'X', rules: [makeRule()] };
      service.create(payload).subscribe();
      const req = httpMock.expectOne(BASE);
      expect(req.request.method).toBe('POST');
      req.flush(makeSet({ id: 'b', rules: [makeRule(), makeRule({ id: 'r2' })] }));
      expect(infoSpy).toHaveBeenCalledWith('ruleSets.created', {
        ruleCount: 2,
        source: 'manual'
      });
    });

    it('does NOT emit ruleSets.created when create() fails', () => {
      const payload: RuleSetPayload = { name: 'X', rules: [makeRule()] };
      service.create(payload).subscribe({ error: () => undefined });
      httpMock.expectOne(BASE).flush(
        { error: 'boom' },
        { status: 500, statusText: 'Server Error' }
      );
      expect(infoSpy).not.toHaveBeenCalledWith(
        'ruleSets.created',
        jasmine.anything()
      );
    });

    it('emits ruleSets.updated with the rule count on update() success', () => {
      const payload: RuleSetPayload = { name: 'X', rules: [makeRule()] };
      service.update('a', payload, 7).subscribe();
      httpMock.expectOne(`${BASE}/a`).flush(
        makeSet({ id: 'a', rules: [makeRule(), makeRule({ id: 'r2' }), makeRule({ id: 'r3' })] })
      );
      expect(infoSpy).toHaveBeenCalledWith('ruleSets.updated', { ruleCount: 3 });
    });

    it('does NOT emit ruleSets.updated on 412 conflict', () => {
      const payload: RuleSetPayload = { name: 'X', rules: [makeRule()] };
      service.update('a', payload, 7).subscribe({ error: () => undefined });
      httpMock.expectOne(`${BASE}/a`).flush(
        { error: 'conflict' },
        { status: 412, statusText: 'Precondition Failed' }
      );
      expect(infoSpy).not.toHaveBeenCalledWith(
        'ruleSets.updated',
        jasmine.anything()
      );
    });

    it('emits ruleSets.deleted (no props) on delete() success', () => {
      service.delete('a').subscribe();
      httpMock.expectOne(`${BASE}/a`).flush(null, { status: 204, statusText: 'No Content' });
      expect(infoSpy).toHaveBeenCalledWith('ruleSets.deleted');
    });

    it('does NOT emit ruleSets.deleted when delete() fails', () => {
      service.delete('a').subscribe({ error: () => undefined });
      httpMock.expectOne(`${BASE}/a`).flush(
        { error: 'boom' },
        { status: 500, statusText: 'Server Error' }
      );
      expect(infoSpy).not.toHaveBeenCalledWith(
        'ruleSets.deleted',
        jasmine.anything()
      );
    });

    it('emits ruleSets.created with preset source on clonePreset() success', () => {
      service.clonePreset('error-detection').subscribe();
      httpMock.expectOne(`${PRESETS_BASE}/error-detection/clone`).flush(
        makeSet({ id: 'b', rules: [makeRule()] })
      );
      expect(infoSpy).toHaveBeenCalledWith('ruleSets.created', {
        ruleCount: 1,
        source: 'preset'
      });
    });

    it('emits ruleSets.applied with activeCount on every defaultRuleSetIds change', () => {
      service.list().subscribe();
      httpMock.expectOne(BASE).flush([
        makeSet({ id: 'a' }),
        makeSet({ id: 'b' }),
        makeSet({ id: 'c' })
      ]);

      service.setDefaults(['a', 'b']);
      TestBed.flushEffects();
      expect(infoSpy).toHaveBeenCalledWith('ruleSets.applied', { activeCount: 2 });

      infoSpy.calls.reset();
      service.toggleDefault('c');
      TestBed.flushEffects();
      expect(infoSpy).toHaveBeenCalledWith('ruleSets.applied', { activeCount: 3 });

      infoSpy.calls.reset();
      service.toggleDefault('a');
      TestBed.flushEffects();
      expect(infoSpy).toHaveBeenCalledWith('ruleSets.applied', { activeCount: 2 });
    });

    it('emits ruleSets.applied when a delete prunes an active id from preferences', () => {
      service.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a' }), makeSet({ id: 'b' })]);
      service.setDefaults(['a', 'b']);
      TestBed.flushEffects();
      infoSpy.calls.reset();

      service.delete('a').subscribe();
      httpMock.expectOne(`${BASE}/a`).flush(null, { status: 204, statusText: 'No Content' });
      TestBed.flushEffects();

      // delete() emits both 'deleted' AND 'applied' (because pruning
      // changed defaultRuleSetIds from ['a','b'] to ['b']).
      expect(infoSpy).toHaveBeenCalledWith('ruleSets.deleted');
      expect(infoSpy).toHaveBeenCalledWith('ruleSets.applied', { activeCount: 1 });
    });

    it('does NOT emit ruleSets.applied for the synchronous initial run', () => {
      // The constructor effect has a one-shot guard that skips its
      // first run (the default-empty state before any preferences have
      // hydrated). The outer beforeEach already drained that run, so
      // a fresh check here should see no prior 'applied' emits.
      expect(infoSpy).not.toHaveBeenCalledWith(
        'ruleSets.applied',
        jasmine.anything()
      );
    });
  });
});
