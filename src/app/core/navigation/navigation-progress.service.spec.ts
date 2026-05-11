import { TestBed } from '@angular/core/testing';
import {
  NavigationCancel,
  NavigationCancellationCode,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  NavigationSkippedCode,
  NavigationStart,
  Router,
  Event as RouterEvent,
} from '@angular/router';
import { Subject } from 'rxjs';
import { NavigationProgressService } from './navigation-progress.service';

describe('NavigationProgressService', () => {
  let events: Subject<RouterEvent>;
  let service: NavigationProgressService;

  function init(): void {
    events = new Subject<RouterEvent>();
    const routerStub: Partial<Router> = {
      events: events.asObservable() as unknown as Router['events'],
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: Router, useValue: routerStub }],
    });
    service = TestBed.inject(NavigationProgressService);
  }

  function fire(event: RouterEvent): void {
    events.next(event);
  }

  function start(id: number, url = `/route-${id}`): NavigationStart {
    const event = new NavigationStart(id, url);
    fire(event);
    return event;
  }

  function end(id: number, url = `/route-${id}`): void {
    fire(new NavigationEnd(id, url, url));
  }

  function cancel(id: number, url = `/route-${id}`): void {
    fire(new NavigationCancel(id, url, '', NavigationCancellationCode.Aborted));
  }

  function error(id: number, url = `/route-${id}`): void {
    fire(new NavigationError(id, url, new Error('test')));
  }

  function skipped(id: number, url = `/route-${id}`): void {
    fire(new NavigationSkipped(id, url, '', NavigationSkippedCode.IgnoredSameUrlNavigation));
  }

  it('initial pending() is false', () => {
    init();
    expect(service.pending()).toBeFalse();
  });

  it('NavigationStart flips pending() to true; NavigationEnd flips it back', () => {
    init();
    start(1);
    expect(service.pending()).toBeTrue();
    end(1);
    expect(service.pending()).toBeFalse();
  });

  it('NavigationCancel terminates the in-flight navigation', () => {
    init();
    start(1);
    expect(service.pending()).toBeTrue();
    cancel(1);
    expect(service.pending()).toBeFalse();
  });

  it('NavigationError terminates the in-flight navigation', () => {
    init();
    start(1);
    expect(service.pending()).toBeTrue();
    error(1);
    expect(service.pending()).toBeFalse();
  });

  it('NavigationSkipped is treated as terminal (covers same-URL ignored navs)', () => {
    init();
    start(1);
    expect(service.pending()).toBeTrue();
    skipped(1);
    expect(service.pending())
      .withContext('skipped without End must clear pending so the bar does not stick')
      .toBeFalse();
  });

  it('resolver-redirect-to-/404 sequence keeps pending until the second nav ends', () => {
    // shareBlobResolver does this exact pattern: GET fails, resolver
    // calls router.navigate(['/404'], { replaceUrl: true }), which
    // cancels the current nav and starts a new one. The bar must NOT
    // flicker off and back on between the two.
    init();
    start(1, '/s/abc');
    expect(service.pending()).withContext('initial /s/abc nav started').toBeTrue();
    cancel(1, '/s/abc');
    start(2, '/404');
    expect(service.pending())
      .withContext('after Cancel(1)+Start(2), pending should still be true')
      .toBeTrue();
    end(2, '/404');
    expect(service.pending()).withContext('only after End(2) should pending clear').toBeFalse();
  });

  it('overlap sequence keeps pending true while any nav is in flight', () => {
    // Start(1) -> Start(2) -> Cancel(1) -> End(2). pending must be
    // continuously true because nav 2 is still active when nav 1
    // cancels.
    init();
    start(1);
    start(2);
    expect(service.pending()).toBeTrue();
    cancel(1);
    expect(service.pending())
      .withContext('nav 2 is still in flight after nav 1 cancels')
      .toBeTrue();
    end(2);
    expect(service.pending()).toBeFalse();
  });

  it('duplicate NavigationStart with the same id is idempotent', () => {
    // Defensive: we should not double-count if Angular ever fires the
    // same id twice. (It does not in practice, but the Set keeps us
    // safe.)
    init();
    start(1);
    start(1);
    end(1);
    expect(service.pending()).toBeFalse();
  });

  it('terminal event for an unknown id is a no-op', () => {
    init();
    end(99);
    expect(service.pending()).toBeFalse();
    start(1);
    end(99);
    expect(service.pending())
      .withContext('unknown End must not clear an unrelated in-flight nav')
      .toBeTrue();
    end(1);
    expect(service.pending()).toBeFalse();
  });

  it('subscription is established in the constructor (catches first NavigationStart)', () => {
    // The cold-boot deep-link case: NavigationProgressService must be
    // ready to observe the very first NavigationStart. TestBed.inject
    // constructs the service; firing immediately after must register.
    init();
    fire(new NavigationStart(42, '/s/cold-boot'));
    expect(service.pending()).toBeTrue();
  });
});
