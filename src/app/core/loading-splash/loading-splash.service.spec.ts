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

  describe('progress signal', () => {
    it('starts as null (indeterminate)', () => {
      const service = init('/s/abc');
      expect(service.progress()).toBeNull();
    });

    it('reportBlobProgress(loaded, total) sets the clamped fraction', () => {
      const service = init('/s/abc');
      start(1, '/s/abc');
      service.reportBlobProgress(0, 1000);
      expect(service.progress()).toBe(0);
      service.reportBlobProgress(250, 1000);
      expect(service.progress()).toBe(0.25);
      service.reportBlobProgress(1000, 1000);
      expect(service.progress()).toBe(1);
    });

    it('clamps loaded > total to 1.0', () => {
      const service = init('/s/abc');
      start(1, '/s/abc');
      service.reportBlobProgress(1500, 1000);
      expect(service.progress()).toBe(1);
    });

    it('clamps loaded < 0 to 0', () => {
      const service = init('/s/abc');
      start(1, '/s/abc');
      service.reportBlobProgress(-1, 1000);
      expect(service.progress()).toBe(0);
    });

    it('treats null total as indeterminate', () => {
      const service = init('/s/abc');
      start(1, '/s/abc');
      service.reportBlobProgress(500, 1000);
      expect(service.progress()).toBe(0.5);
      service.reportBlobProgress(750, null);
      expect(service.progress()).toBeNull();
    });

    it('treats zero or negative total as indeterminate', () => {
      const service = init('/s/abc');
      start(1, '/s/abc');
      service.reportBlobProgress(500, 0);
      expect(service.progress()).toBeNull();
      service.reportBlobProgress(500, -100);
      expect(service.progress()).toBeNull();
    });

    it('treats non-finite total as indeterminate', () => {
      const service = init('/s/abc');
      start(1, '/s/abc');
      service.reportBlobProgress(500, Number.NaN);
      expect(service.progress()).toBeNull();
      service.reportBlobProgress(500, Number.POSITIVE_INFINITY);
      expect(service.progress()).toBeNull();
    });

    it('treats non-finite loaded as indeterminate', () => {
      const service = init('/s/abc');
      start(1, '/s/abc');
      service.reportBlobProgress(Number.NaN, 1000);
      expect(service.progress()).toBeNull();
    });

    it('resets to null on every NavigationStart (handles cancelled-then-restarted blob navs)', () => {
      const service = init('/s/abc');
      start(1, '/s/abc');
      service.reportBlobProgress(500, 1000);
      expect(service.progress()).toBe(0.5);
      // User cancels nav 1 by clicking another share link mid-fetch.
      cancel(1, '/s/abc');
      // Splash already hid (firstNavComplete latched), but verify the
      // signal is null too -- guards against stale fractions leaking
      // into the next blob nav.
      expect(service.progress()).toBeNull();
    });

    it('resets to null on NavigationStart even mid-fraction', () => {
      const service = init('/');
      start(1, '/');
      end(1, '/');
      // First nav complete; splash hidden. User clicks a blob, route
      // bar takes over.
      service.reportBlobProgress(750, 1000);
      // Wait, that would never happen because no NavigationStart yet.
      // Let's do it the realistic way: another nav starts.
      start(2, '/s/xyz');
      expect(service.progress())
        .withContext('NavigationStart resets stale progress before the new fetch reports')
        .toBeNull();
      service.reportBlobProgress(100, 1000);
      expect(service.progress()).toBe(0.1);
      // Mid-fetch, user clicks yet another link.
      start(3, '/s/another');
      expect(service.progress())
        .withContext('overlapping NavigationStart wipes stale fraction from cancelled fetch')
        .toBeNull();
    });

    it('resets to null on first-nav-settle (alongside kind transitioning to null)', () => {
      const service = init('/s/abc');
      start(1, '/s/abc');
      service.reportBlobProgress(800, 1000);
      expect(service.progress()).toBe(0.8);
      end(1, '/s/abc');
      expect(service.kind()).toBeNull();
      expect(service.progress())
        .withContext('progress must clear when the splash hides so the route bar starts clean')
        .toBeNull();
    });
  });
});
