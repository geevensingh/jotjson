import { TestBed } from '@angular/core/testing';
import { BeaconNavigationService, type BeaconJumpRequest } from './beacon-navigation.service';

describe('BeaconNavigationService', () => {
  let service: BeaconNavigationService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(BeaconNavigationService);
  });

  it('defaults lastActivePane to "tree"', () => {
    expect(service.lastActivePane()).toBe('tree');
  });

  it('markEditorActive flips lastActivePane to editor', () => {
    service.markEditorActive();
    expect(service.lastActivePane()).toBe('editor');
  });

  it('markTreeActive flips lastActivePane back to tree', () => {
    service.markEditorActive();
    service.markTreeActive();
    expect(service.lastActivePane()).toBe('tree');
  });

  it('requestJump emits to jumpRequest$ subscribers', () => {
    const received: BeaconJumpRequest[] = [];
    const sub = service.jumpRequest$.subscribe((request) => received.push(request));
    try {
      service.requestJump({ path: ['a', 0], icon: 'warning', source: 'pill' });
      service.requestJump({ path: ['b'], icon: 'error', source: 'badge' });
    } finally {
      sub.unsubscribe();
    }
    expect(received).toEqual([
      { path: ['a', 0], icon: 'warning', source: 'pill' },
      { path: ['b'], icon: 'error', source: 'badge' },
    ]);
  });

  it('does NOT update lastActivePane on requestJump (the dispatcher reads pre-click state)', () => {
    service.markTreeActive();
    service.requestJump({ path: ['x'], icon: 'flag', source: 'pill' });
    expect(service.lastActivePane()).toBe('tree');
  });

  it('is provided as a singleton at root scope', () => {
    const second = TestBed.inject(BeaconNavigationService);
    expect(second).toBe(service);
  });
});
