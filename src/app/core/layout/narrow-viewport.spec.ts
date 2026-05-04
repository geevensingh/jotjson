import { Component, inject, Injector, runInInjectionContext, Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createNarrowViewportSignal } from './narrow-viewport';
import {
  installMatchMediaStub,
  type MatchMediaHarness,
} from '../../../testing/match-media.testing';

const NARROW_QUERY = '(max-width: 767.98px)';

@Component({ standalone: true, template: '' })
class HostComponent {
  readonly narrow: Signal<boolean>;
  constructor() {
    this.narrow = createNarrowViewportSignal();
  }
}

describe('createNarrowViewportSignal', () => {
  let harness: MatchMediaHarness;

  beforeEach(() => {
    harness = installMatchMediaStub();
  });

  afterEach(() => {
    harness.uninstall();
  });

  it('seeds synchronously from matchMedia.matches=true', () => {
    harness.set(NARROW_QUERY, true);
    const fixture = TestBed.createComponent(HostComponent);
    expect(fixture.componentInstance.narrow()).toBeTrue();
  });

  it('seeds synchronously from matchMedia.matches=false', () => {
    harness.set(NARROW_QUERY, false);
    const fixture = TestBed.createComponent(HostComponent);
    expect(fixture.componentInstance.narrow()).toBeFalse();
  });

  it('updates when the media query change event fires', () => {
    harness.set(NARROW_QUERY, false);
    const fixture = TestBed.createComponent(HostComponent);
    expect(fixture.componentInstance.narrow()).toBeFalse();

    harness.fire(NARROW_QUERY, true);
    expect(fixture.componentInstance.narrow()).toBeTrue();

    harness.fire(NARROW_QUERY, false);
    expect(fixture.componentInstance.narrow()).toBeFalse();
  });

  it('returns a static false signal when matchMedia is unavailable', () => {
    harness.uninstall();
    const original = window.matchMedia;
    (window as unknown as { matchMedia: typeof window.matchMedia | undefined }).matchMedia =
      undefined;
    try {
      const injector = TestBed.inject(Injector);
      const narrow = runInInjectionContext(injector, () => createNarrowViewportSignal());
      expect(narrow()).toBeFalse();
    } finally {
      window.matchMedia = original;
      harness = installMatchMediaStub();
    }
  });
});
