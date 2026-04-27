import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { environment } from '../../../environments/environment';
import { AuthService } from '../auth/auth.service';
import { AuthUser } from '../auth/auth-user';
import { PreferencesService } from '../preferences/preferences.service';
import { provideFakeAuth, signInFakeUser } from '../../../testing/auth.testing';
import {
  FormattingRule,
  FormattingRuleSet,
  RuleSetPayload,
  RuleSetPreset
} from './models';
import { RuleSetsService } from './rule-sets.service';

const BASE = `${environment.apiBaseUrl}/rule-sets`;

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
      httpMock.expectOne(`${BASE}/a`).flush(
        { error: 'nope' },
        { status: 500, statusText: 'Server Error' }
      );
      expect(service.ruleSets()?.map((s) => s.id)).toEqual(['a']);
    });
  });

  describe('listPresets()', () => {
    it('GETs /api/rule-sets/presets', () => {
      const presets: RuleSetPreset[] = [
        { id: 'error-detection', name: 'Errors', rules: [makeRule()] }
      ];
      let received: RuleSetPreset[] | null = null;
      service.listPresets().subscribe((v) => {
        received = v;
      });
      const req = httpMock.expectOne(`${BASE}/presets`);
      expect(req.request.method).toBe('GET');
      req.flush(presets);
      expect(received as RuleSetPreset[] | null).toEqual(presets);
      expect(service.ruleSets()).toBeNull();
    });
  });

  describe('clonePreset()', () => {
    it('POSTs to /api/rule-sets/presets/{id}/clone with empty body', () => {
      service.clonePreset('error-detection').subscribe();
      const req = httpMock.expectOne(`${BASE}/presets/error-detection/clone`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({});
      req.flush(makeSet({ id: 'cloned', name: 'Errors' }));
    });

    it('adds the cloned set to the cache', () => {
      service.list().subscribe();
      httpMock.expectOne(BASE).flush([makeSet({ id: 'a' })]);

      service.clonePreset('error-detection').subscribe();
      httpMock
        .expectOne(`${BASE}/presets/error-detection/clone`)
        .flush(makeSet({ id: 'cloned', name: 'Errors' }));

      expect(service.ruleSets()?.map((s) => s.id)).toEqual(['a', 'cloned']);
    });

    it('URL-encodes the preset id', () => {
      service.clonePreset('weird id').subscribe();
      httpMock.expectOne(`${BASE}/presets/weird%20id/clone`).flush(makeSet());
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

  describe('setActive() / toggleActive()', () => {
    beforeEach(() => {
      service.list().subscribe();
      httpMock.expectOne(BASE).flush([
        makeSet({ id: 'a' }),
        makeSet({ id: 'b' }),
        makeSet({ id: 'c' })
      ]);
    });

    it('setActive() filters out IDs not present in the cache', () => {
      service.setActive(['a', 'unknown', 'c']);
      expect(preferences.prefs().activeRuleSetIds).toEqual(['a', 'c']);
    });

    it('setActive() de-duplicates while preserving first-seen order', () => {
      service.setActive(['c', 'a', 'c', 'b', 'a']);
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

  describe('setActive() before cache loads', () => {
    it('accepts ids verbatim when the cache is null (no filter)', () => {
      // Pre-cache callers (e.g. server hydration) must not be silently
      // dropped just because list() has not resolved yet.
      service.setActive(['x', 'y']);
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
});
