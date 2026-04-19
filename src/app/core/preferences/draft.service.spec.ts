import { TestBed } from '@angular/core/testing';
import { DraftService } from './draft.service';

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

  it('set() persists to localStorage', () => {
    const svc = TestBed.inject(DraftService);
    svc.set('{"b":2}');
    TestBed.flushEffects();
    expect(localStorage.getItem(DRAFT_KEY)).toBe('{"b":2}');
  });

  it('clear() removes the stored draft', () => {
    localStorage.setItem(DRAFT_KEY, 'seed');
    const svc = TestBed.inject(DraftService);
    svc.clear();
    TestBed.flushEffects();
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(svc.content()).toBe('');
  });
});
