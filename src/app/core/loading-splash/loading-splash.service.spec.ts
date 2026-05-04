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
import { LoggerService } from '../telemetry/logger.service';

describe('LoadingSplashService', () => {
  let events: Subject<RouterEvent>;
  let logger: jasmine.SpyObj<LoggerService>;

  function init(initialPath = '/'): LoadingSplashService {
    events = new Subject<RouterEvent>();
    logger = jasmine.createSpyObj<LoggerService>('LoggerService', ['event']);
    const routerStub: Partial<Router> = {
      events: events.asObservable() as unknown as Router['events'],
    };
    history.replaceState(null, '', initialPath);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: routerStub },
        { provide: LoggerService, useValue: logger },
      ],
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
    expect(service.renderPending())
      .withContext('renderPending only flips on first cold-boot blob NavigationEnd')
      .toBeFalse();
  });

  it('initial kind is "jotjson" even when bootstrapping on /s/:slug (no URL preemption)', () => {
    // Drop the prior pre-emption: we now start in the bootstrap stage
    // ("Loading JotJSON...") for any URL, and flip to 'blob' on the
    // first NavigationStart for /s/:slug. The static splash also
    // shows "Loading JotJSON..." for both URLs, so the static->Angular
    // handoff is flicker-free; the bootstrap->download flicker on
    // cold-boot deep-links is accepted as a UX trade for distinct
    // lifecycle stages.
    const service = init('/s/abc123');
    expect(service.kind()).toBe('jotjson');
    expect(service.renderPending()).toBeFalse();
  });

  it('initial kind is "jotjson" for malformed /s/ URLs (bare prefix or extra segments)', () => {
    // The route is /s/:slug (single segment); broader matchers like
    // startsWith('/s/') would over-classify these as blob.
    const bareService = init('/s/');
    expect(bareService.kind()).toBe('jotjson');
    const nestedService = init('/s/foo/bar');
    expect(nestedService.kind()).toBe('jotjson');
  });

  it('first nav to a non-blob URL keeps "jotjson" until End, then null with renderPending false', () => {
    const service = init('/');
    start(1, '/');
    expect(service.kind()).toBe('jotjson');
    end(1, '/');
    expect(service.kind()).toBeNull();
    expect(service.renderPending())
      .withContext('non-blob first nav skips the render-pending stage')
      .toBeFalse();
    expect(logger.event).not.toHaveBeenCalled();
  });

  it('first nav to /s/:slug shows "blob" through resolver, then null + renderPending=true on End', () => {
    const service = init('/s/abc');
    start(1, '/s/abc');
    expect(service.kind()).toBe('blob');
    end(1, '/s/abc');
    expect(service.kind())
      .withContext('kind clears on settle so the bar hides for the render-pending stage')
      .toBeNull();
    expect(service.renderPending())
      .withContext('first cold-boot blob NavigationEnd enters render-pending stage')
      .toBeTrue();
    expect(logger.event)
      .withContext('telemetry only emits on the eventual paint, not on entering the stage')
      .not.toHaveBeenCalled();
  });

  it('markBlobRenderComplete clears renderPending and emits blob.coldBoot.firstPaint', () => {
    const service = init('/s/abc');
    start(1, '/s/abc');
    end(1, '/s/abc');
    expect(service.renderPending()).toBeTrue();
    service.markBlobRenderComplete();
    expect(service.renderPending()).toBeFalse();
    expect(logger.event).toHaveBeenCalledTimes(1);
    const call = logger.event.calls.mostRecent();
    expect(call.args[0]).toBe('blob.coldBoot.firstPaint');
    expect(call.args[1]).withContext('event has no closed-enum properties').toBeUndefined();
    const measurements = call.args[2] ?? {};
    expect(typeof measurements['durationMs']).toBe('number');
    expect(Number.isFinite(measurements['durationMs'])).toBeTrue();
    expect(measurements['durationMs']).toBeGreaterThanOrEqual(0);
  });

  it('markBlobRenderComplete is a no-op when renderPending is false (idempotent)', () => {
    const service = init('/');
    start(1, '/');
    end(1, '/');
    expect(service.renderPending()).toBeFalse();
    service.markBlobRenderComplete();
    expect(service.renderPending()).toBeFalse();
    expect(logger.event)
      .withContext('no telemetry on idempotent no-op call - re-instantiation must not double-count')
      .not.toHaveBeenCalled();
  });

  it('two markBlobRenderComplete calls only emit telemetry once', () => {
    const service = init('/s/abc');
    start(1, '/s/abc');
    end(1, '/s/abc');
    service.markBlobRenderComplete();
    service.markBlobRenderComplete();
    expect(logger.event).toHaveBeenCalledTimes(1);
  });

  it('first nav resolver-redirect-to-/404 does NOT enter render-pending stage', () => {
    // shareBlobResolver pattern: GET 404s, resolver navigates to /404
    // -> Cancel(1) Start(2,/404) End(2,/404). NavigationCancel of a
    // blob nav skips the render-pending stage even though previous
    // kind was 'blob' - there is no tree to render.
    const service = init('/s/abc');
    start(1, '/s/abc');
    expect(service.kind()).toBe('blob');
    cancel(1, '/s/abc');
    expect(service.kind()).toBeNull();
    expect(service.renderPending())
      .withContext('cancel of a blob nav does NOT enter render-pending')
      .toBeFalse();
    start(2, '/404');
    expect(service.renderPending()).toBeFalse();
    expect(service.kind())
      .withContext('after first nav settles the splash never reappears for in-app nav')
      .toBeNull();
    end(2, '/404');
    expect(service.kind()).toBeNull();
    expect(service.renderPending()).toBeFalse();
    expect(logger.event).not.toHaveBeenCalled();
  });

  it('NavigationError on first blob nav does NOT enter render-pending stage', () => {
    const service = init('/s/abc');
    start(1, '/s/abc');
    expect(service.kind()).toBe('blob');
    error(1, '/s/abc');
    expect(service.kind()).toBeNull();
    expect(service.renderPending()).toBeFalse();
    expect(logger.event).not.toHaveBeenCalled();
  });

  it('NavigationSkipped on first blob nav does NOT enter render-pending stage', () => {
    // The router can fire NavigationSkipped (e.g. for an identical
    // URL) instead of End. Like Cancel/Error, this should skip the
    // render-pending stage - there is no first-paint signal to wait
    // for and no tree to render.
    const service = init('/s/abc');
    start(1, '/s/abc');
    expect(service.kind()).toBe('blob');
    skipped(1, '/s/abc');
    expect(service.kind()).toBeNull();
    expect(service.renderPending())
      .withContext('skipped blob nav skips render-pending; same as cancel/error')
      .toBeFalse();
    expect(logger.event).not.toHaveBeenCalled();
  });

  it('NavigationSkipped on first non-blob nav hides splash, no render-pending', () => {
    const service = init('/');
    start(1, '/');
    skipped(1, '/');
    expect(service.kind()).toBeNull();
    expect(service.renderPending()).toBeFalse();
  });

  it('NavigationStart while renderPending=true clears it (user navigated away mid-render)', () => {
    const service = init('/s/abc');
    start(1, '/s/abc');
    end(1, '/s/abc');
    expect(service.renderPending()).toBeTrue();
    // User clicks away before HomeComponent paints (e.g., quickly
    // navigates to /history). The new nav must clear render-pending
    // so the splash does not get stuck. No telemetry emits because
    // the abandoned render is not a useful first-paint sample.
    start(2, '/history');
    expect(service.renderPending())
      .withContext('NavigationStart aborts the render-pending stage')
      .toBeFalse();
    expect(logger.event).not.toHaveBeenCalled();
  });

  it('cancel/replace mid-blob-nav: render-pending fires once for surviving nav', () => {
    // start(1,/s/foo) -> start(2,/s/bar) -> cancel(1) -> end(2)
    // The render-pending stage must enter exactly once, on end(2).
    const service = init('/s/foo');
    start(1, '/s/foo');
    expect(service.kind()).toBe('blob');
    start(2, '/s/bar');
    expect(service.kind()).toBe('blob');
    cancel(1, '/s/foo');
    expect(service.kind())
      .withContext('blob nav 2 still in flight, splash stays on blob')
      .toBe('blob');
    expect(service.renderPending())
      .withContext('cancel of one of multiple in-flight blob navs does not pre-fire render-pending')
      .toBeFalse();
    end(2, '/s/bar');
    expect(service.kind()).toBeNull();
    expect(service.renderPending()).toBeTrue();
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
    expect(service.renderPending())
      .withContext('render-pending only fires on first cold-boot blob nav')
      .toBeFalse();
    end(2, '/s/xyz');
    expect(service.kind()).toBeNull();
    expect(service.renderPending())
      .withContext('in-app /s/:slug NavigationEnd does NOT enter render-pending')
      .toBeFalse();
    expect(logger.event)
      .withContext('telemetry only fires on cold-boot first-paint, not in-app navs')
      .not.toHaveBeenCalled();
  });

  it('in-app nav to a non-blob route after first nav settles stays null', () => {
    const service = init('/');
    start(1, '/');
    end(1, '/');
    start(2, '/history');
    end(2, '/history');
    expect(service.kind()).toBeNull();
    expect(service.renderPending()).toBeFalse();
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
    expect(service.renderPending())
      .withContext('previous kind was blob and event was End -> render-pending')
      .toBeTrue();
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
    expect(service.renderPending()).toBeTrue();
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
