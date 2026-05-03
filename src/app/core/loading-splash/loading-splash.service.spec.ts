import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import {
  Event as RouterEvent,
  NavigationCancel,
  NavigationCancellationCode,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  NavigationSkippedCode,
  NavigationStart,
  Router,
} from '@angular/router';
import { LoadingSplashService } from './loading-splash.service';

describe('LoadingSplashService', () => {
  let events: Subject<RouterEvent>;

  function init(initialPath = '/'): LoadingSplashService {
    events = new Subject<RouterEvent>();
    const routerStub: Partial<Router> = {
      events: events.asObservable() as unknown as Router['events'],
    };
    history.replaceState(null, '', initialPath);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: Router, useValue: routerStub }],
    });
    return TestBed.inject(LoadingSplashService);
  }

  function start(id: number, url = `/route-${id}`): void {
    events.next(new NavigationStart(id, url));
  }

  function end(id: number, url = `/route-${id}`): void {
    events.next(new NavigationEnd(id, url, url));
  }

  function cancel(id: number, url = `/route-${id}`): void {
    events.next(new NavigationCancel(id, url, '', NavigationCancellationCode.Aborted));
  }

  function error(id: number, url = `/route-${id}`): void {
    events.next(new NavigationError(id, url, new Error('boom')));
  }

  function skipped(id: number, url = `/route-${id}`): void {
    events.next(new NavigationSkipped(id, url, '', NavigationSkippedCode.IgnoredSameUrlNavigation));
  }

  it('initial kind is "jotjson" for non-blob URLs', () => {
    const service = init('/');
    expect(service.kind()).toBe('jotjson');
  });

  it('initial kind is "blob" when bootstrapping on /s/:slug (cold-boot deep-link)', () => {
    const service = init('/s/abc123');
    expect(service.kind())
      .withContext(
        'splash must paint with the blob label immediately so the cold-boot transition is seamless',
      )
      .toBe('blob');
  });

  it('initial kind is "jotjson" for malformed /s/ URLs (bare prefix or extra segments)', () => {
    // The route is /s/:slug (single segment); broader matchers like
    // startsWith('/s/') would over-classify these as blob.
    const bareService = init('/s/');
    expect(bareService.kind()).toBe('jotjson');
    const nestedService = init('/s/foo/bar');
    expect(nestedService.kind()).toBe('jotjson');
  });

  it('first nav to a non-blob URL keeps "jotjson" until End, then null', () => {
    const service = init('/');
    start(1, '/');
    expect(service.kind()).toBe('jotjson');
    end(1, '/');
    expect(service.kind()).toBeNull();
  });

  it('first nav to /s/:slug shows "blob" through the resolver, then null on End', () => {
    const service = init('/s/abc');
    start(1, '/s/abc');
    expect(service.kind()).toBe('blob');
    end(1, '/s/abc');
    expect(service.kind()).toBeNull();
  });

  it('first nav resolver-redirect-to-/404 hides splash once the first nav cancels', () => {
    // shareBlobResolver pattern: GET 404s, resolver navigates to /404
    // -> Cancel(1) Start(2,/404) End(2,/404). With the current
    // simpler design we accept a brief blank between Cancel(1) and
    // /404 mount; firstNavComplete latches on Cancel(1) because
    // inFlight is empty in that moment.
    const service = init('/s/abc');
    start(1, '/s/abc');
    expect(service.kind()).toBe('blob');
    cancel(1, '/s/abc');
    expect(service.kind()).toBeNull();
    start(2, '/404');
    expect(service.kind())
      .withContext('after first nav settles the splash never reappears for in-app nav')
      .toBeNull();
    end(2, '/404');
    expect(service.kind()).toBeNull();
  });

  it('NavigationError on first nav hides splash', () => {
    const service = init('/s/abc');
    start(1, '/s/abc');
    error(1, '/s/abc');
    expect(service.kind()).toBeNull();
  });

  it('NavigationSkipped on first nav hides splash', () => {
    const service = init('/');
    start(1, '/');
    skipped(1, '/');
    expect(service.kind()).toBeNull();
  });

  it('in-app nav to /s/:slug after first nav settles does NOT re-show the splash (Option 2)', () => {
    const service = init('/');
    start(1, '/');
    end(1, '/');
    expect(service.kind()).toBeNull();
    // User clicks a share link.
    start(2, '/s/xyz');
    expect(service.kind())
      .withContext('Option 2: in-app blob nav uses the route progress bar, not the splash')
      .toBeNull();
    end(2, '/s/xyz');
    expect(service.kind()).toBeNull();
  });

  it('in-app nav to a non-blob route after first nav settles stays null', () => {
    const service = init('/');
    start(1, '/');
    end(1, '/');
    start(2, '/history');
    end(2, '/history');
    expect(service.kind()).toBeNull();
  });

  it('overlapping start during first nav: any in-flight blob flips kind to blob', () => {
    // Pathological: a guard or interceptor triggers a second Start
    // while the first is still in flight. Splash kind should reflect
    // whichever in-flight nav is a blob.
    const service = init('/');
    start(1, '/');
    expect(service.kind()).toBe('jotjson');
    start(2, '/s/abc');
    expect(service.kind())
      .withContext('any in-flight blob nav during the first-nav window flips kind to blob')
      .toBe('blob');
    end(1, '/');
    expect(service.kind())
      .withContext('blob nav still in flight, splash should stay on blob')
      .toBe('blob');
    end(2, '/s/abc');
    expect(service.kind()).toBeNull();
  });

  it('subscription is established in the constructor (catches first NavigationStart)', () => {
    const service = init('/s/abc');
    // Without waiting, fire NavigationStart immediately:
    events.next(new NavigationStart(1, '/s/abc'));
    expect(service.kind()).toBe('blob');
  });

  it('isBlobUrl accepts query strings and fragments on the share route', () => {
    const service = init('/');
    start(1, '/s/abc?foo=bar');
    expect(service.kind()).toBe('blob');
    end(1, '/s/abc?foo=bar');
    expect(service.kind()).toBeNull();
  });
});
