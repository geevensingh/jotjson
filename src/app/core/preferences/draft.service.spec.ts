import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { DRAFT_WRITE_DEBOUNCE_MS, DraftService } from './draft.service';

const DRAFT_KEY = 'jotjson.draft.v1';

describe('DraftService', () => {
  beforeEach(() => {
    localStorage.removeItem(DRAFT_KEY);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    localStorage.removeItem(DRAFT_KEY);
  });

  it('starts empty when no draft is stored', () => {
    const svc = TestBed.inject(DraftService);
    expect(svc.content()).toBe('');
  });

  it('loads existing draft from localStorage', () => {
    localStorage.setItem(DRAFT_KEY, '{"a":1}');
    const svc = TestBed.inject(DraftService);
    expect(svc.content()).toBe('{"a":1}');
  });

  it('set() persists to localStorage after the debounce window', fakeAsync(() => {
    const svc = TestBed.inject(DraftService);
    svc.set('{"b":2}');
    TestBed.flushEffects();
    // Write is now debounced; nothing in storage yet.
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    tick(DRAFT_WRITE_DEBOUNCE_MS);
    expect(localStorage.getItem(DRAFT_KEY)).toBe('{"b":2}');
  }));

  it('set() coalesces bursty writes into one storage round-trip', fakeAsync(() => {
    const svc = TestBed.inject(DraftService);
    const spy = spyOn(Storage.prototype, 'setItem').and.callThrough();
    svc.set('a');
    svc.set('ab');
    svc.set('abc');
    TestBed.flushEffects();
    tick(DRAFT_WRITE_DEBOUNCE_MS);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(DRAFT_KEY)).toBe('abc');
  }));

  it('clear() removes the stored draft after the debounce window', fakeAsync(() => {
    localStorage.setItem(DRAFT_KEY, 'seed');
    const svc = TestBed.inject(DraftService);
    svc.clear();
    TestBed.flushEffects();
    tick(DRAFT_WRITE_DEBOUNCE_MS);
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(svc.content()).toBe('');
  }));

  it('flushes the pending write synchronously on pagehide', fakeAsync(() => {
    const svc = TestBed.inject(DraftService);
    svc.set('{"c":3}');
    TestBed.flushEffects();
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    window.dispatchEvent(new Event('pagehide'));
    // No tick: pagehide must flush in the same tick.
    expect(localStorage.getItem(DRAFT_KEY)).toBe('{"c":3}');
    // Discard the now-cancelled timer so fakeAsync doesn't complain.
    tick(DRAFT_WRITE_DEBOUNCE_MS);
  }));

  it('flushes the pending write synchronously on visibilitychange to hidden', fakeAsync(() => {
    const svc = TestBed.inject(DraftService);
    svc.set('{"d":4}');
    TestBed.flushEffects();
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    spyOnProperty(document, 'visibilityState').and.returnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(localStorage.getItem(DRAFT_KEY)).toBe('{"d":4}');
    tick(DRAFT_WRITE_DEBOUNCE_MS);
  }));
});
