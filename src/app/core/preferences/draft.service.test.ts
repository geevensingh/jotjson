import { TestBed } from '@angular/core/testing';
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

  it('set() persists to localStorage after the debounce window', () => {
    vi.useFakeTimers();
    try {
      const svc = TestBed.inject(DraftService);
      svc.set('{"b":2}');
      TestBed.flushEffects();
      // Write is now debounced; nothing in storage yet.
      expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
      vi.advanceTimersByTime(DRAFT_WRITE_DEBOUNCE_MS);
      expect(localStorage.getItem(DRAFT_KEY)).toBe('{"b":2}');
    } finally {
      vi.useRealTimers();
    }
  });

  it('set() coalesces bursty writes into one storage round-trip', () => {
    vi.useFakeTimers();
    try {
      const svc = TestBed.inject(DraftService);
      const spy = vi.spyOn(Storage.prototype, 'setItem');
      svc.set('a');
      svc.set('ab');
      svc.set('abc');
      TestBed.flushEffects();
      vi.advanceTimersByTime(DRAFT_WRITE_DEBOUNCE_MS);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(DRAFT_KEY)).toBe('abc');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clear() removes the stored draft after the debounce window', () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(DRAFT_KEY, 'seed');
      const svc = TestBed.inject(DraftService);
      svc.clear();
      TestBed.flushEffects();
      vi.advanceTimersByTime(DRAFT_WRITE_DEBOUNCE_MS);
      expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
      expect(svc.content()).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes the pending write synchronously on pagehide', () => {
    vi.useFakeTimers();
    try {
      const svc = TestBed.inject(DraftService);
      svc.set('{"c":3}');
      TestBed.flushEffects();
      expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
      window.dispatchEvent(new Event('pagehide'));
      // No timer advance: pagehide must flush synchronously.
      expect(localStorage.getItem(DRAFT_KEY)).toBe('{"c":3}');
      // Drain the now-cancelled timer.
      vi.advanceTimersByTime(DRAFT_WRITE_DEBOUNCE_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes the pending write synchronously on visibilitychange to hidden', () => {
    vi.useFakeTimers();
    try {
      const svc = TestBed.inject(DraftService);
      svc.set('{"d":4}');
      TestBed.flushEffects();
      expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(localStorage.getItem(DRAFT_KEY)).toBe('{"d":4}');
      vi.advanceTimersByTime(DRAFT_WRITE_DEBOUNCE_MS);
    } finally {
      vi.useRealTimers();
    }
  });
});
