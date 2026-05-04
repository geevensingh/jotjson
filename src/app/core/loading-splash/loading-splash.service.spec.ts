import { TestBed } from '@angular/core/testing';
import { PLATFORM_ID } from '@angular/core';
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

  function initOnServerPlatform(initialPath = '/'): LoadingSplashService {
    // Override PLATFORM_ID to simulate the server-platform branch the
    // static prerender pipeline runs in. Other Angular APIs aren't
    // exercised in this spec, so a bare PLATFORM_ID swap is enough
    // -- no need to bring in @angular/platform-server.
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
        { provide: PLATFORM_ID, useValue: 'server' },
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

  it('first nav to /s/:slug shows "blob" through resolver; bytesComplete enters render-pending', () => {
    const service = init('/s/abc');
    start(1, '/s/abc');
    expect(service.kind()).toBe('blob');
    expect(service.renderPending())
      .withContext('render-pending only enters on markBlobBytesComplete, not on NavigationStart')
      .toBeFalse();
    // Resolver receives bytesComplete from BlobService BEFORE the
    // synchronous JSON.parse runs. This is the canonical entry
    // trigger for the render-pending stage.
    service.markBlobBytesComplete();
    expect(service.kind())
      .withContext('kind clears so the bar hides for the render-pending stage')
      .toBeNull();
    expect(service.renderPending()).toBeTrue();
    // NavigationEnd then preserves render-pending and lets the
    // first-nav-complete latch fire normally.
    end(1, '/s/abc');
    expect(service.kind()).toBeNull();
    expect(service.renderPending())
      .withContext('NavigationEnd preserves render-pending so HomeComponent can paint')
      .toBeTrue();
    expect(logger.event)
      .withContext('telemetry only emits on the eventual paint, not on entering the stage')
      .not.toHaveBeenCalled();
  });

  it('NavigationEnd of a blob nav without preceding bytesComplete does NOT enter render-pending', () => {
    // Defensive: with the v0.10.7 fix, render-pending is only entered
    // by markBlobBytesComplete. If a future code path ever lands a
    // NavigationEnd for /s/:slug without bytesComplete firing first,
    // the splash should hide cleanly rather than stick on "Rendering
    // tree..." indefinitely.
    const service = init('/s/abc');
    start(1, '/s/abc');
    expect(service.kind()).toBe('blob');
    end(1, '/s/abc');
    expect(service.kind()).toBeNull();
    expect(service.renderPending()).toBeFalse();
    expect(logger.event).not.toHaveBeenCalled();
  });

  it('markBlobBytesComplete from kind=blob enters render-pending and clears progress', () => {
    const service = init('/s/abc');
    start(1, '/s/abc');
    service.reportBlobProgress(750, 1000);
    expect(service.kind()).toBe('blob');
    expect(service.progress()).toBe(0.75);
    service.markBlobBytesComplete();
    expect(service.kind())
      .withContext('kind clears so the splash bar hides during render-pending')
      .toBeNull();
    expect(service.renderPending()).toBeTrue();
    expect(service.progress())
      .withContext('progress clears so a stale fraction does not leak into a future bar')
      .toBeNull();
    expect(logger.event)
      .withContext('telemetry fires on first paint, not on bytesComplete')
      .not.toHaveBeenCalled();
  });

  it('markBlobBytesComplete is a no-op when kind is "jotjson" (bootstrap stage)', () => {
    const service = init('/');
    expect(service.kind()).toBe('jotjson');
    service.markBlobBytesComplete();
    expect(service.kind())
      .withContext('bootstrap-stage call ignored - bytesComplete only meaningful for blob fetch')
      .toBe('jotjson');
    expect(service.renderPending()).toBeFalse();
  });

  it('markBlobBytesComplete is a no-op when kind is null (post-firstNavComplete)', () => {
    const service = init('/');
    start(1, '/');
    end(1, '/');
    expect(service.kind()).toBeNull();
    // In-app navs land here: kind is null, route progress bar handles
    // any subsequent /s/:slug nav. bytesComplete must NOT re-show the
    // splash.
    service.markBlobBytesComplete();
    expect(service.kind()).toBeNull();
    expect(service.renderPending())
      .withContext('in-app blob fetch must not re-show the splash')
      .toBeFalse();
  });

  it('markBlobBytesComplete is idempotent: second call is a no-op', () => {
    const service = init('/s/abc');
    start(1, '/s/abc');
    service.markBlobBytesComplete();
    expect(service.renderPending()).toBeTrue();
    const startedAtBefore = (service as unknown as { renderPendingStartedAt: number | null })
      .renderPendingStartedAt;
    expect(startedAtBefore).not.toBeNull();
    service.markBlobBytesComplete();
    expect(service.renderPending())
      .withContext('still pending - second call does not re-arm')
      .toBeTrue();
    const startedAtAfter = (service as unknown as { renderPendingStartedAt: number | null })
      .renderPendingStartedAt;
    expect(startedAtAfter)
      .withContext('renderPendingStartedAt is preserved - durationMs starts from the first call')
      .toBe(startedAtBefore);
    expect(logger.event)
      .withContext('no telemetry on the no-op second call')
      .not.toHaveBeenCalled();
  });

  it('markBlobRenderComplete clears renderPending and emits blob.coldBoot.firstPaint', () => {
    const service = init('/s/abc');
    start(1, '/s/abc');
    service.markBlobBytesComplete();
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
    expect(measurements['durationMs'])
      .withContext(
        'durationMs covers bytesComplete -> first paint, including the JSON.parse window',
      )
      .toBeGreaterThanOrEqual(0);
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
    service.markBlobBytesComplete();
    service.markBlobRenderComplete();
    service.markBlobRenderComplete();
    expect(logger.event).toHaveBeenCalledTimes(1);
  });

  it('first nav resolver-redirect-to-/404 does NOT enter render-pending stage', () => {
    // shareBlobResolver pattern: GET 404s, resolver navigates to /404
    // -> Cancel(1) Start(2,/404) End(2,/404). No bytesComplete fired
    // (the GET errored), so render-pending is never entered.
    const service = init('/s/abc');
    start(1, '/s/abc');
    expect(service.kind()).toBe('blob');
    cancel(1, '/s/abc');
    expect(service.kind()).toBeNull();
    expect(service.renderPending())
      .withContext('cancel of a blob nav with no bytesComplete does NOT enter render-pending')
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

  it('NavigationCancel after bytesComplete clears render-pending without telemetry', () => {
    // Edge case: a parse error AFTER bytesComplete fires (e.g.,
    // body bytes received but invalid JSON) causes the resolver to
    // redirect to /404. The cancel of the original /s/:slug nav
    // must clean up render-pending defensively.
    const service = init('/s/abc');
    start(1, '/s/abc');
    service.markBlobBytesComplete();
    expect(service.renderPending()).toBeTrue();
    cancel(1, '/s/abc');
    expect(service.renderPending())
      .withContext('non-End terminal must clear render-pending if it was entered early')
      .toBeFalse();
    expect(logger.event)
      .withContext('abandoned render is not a useful first-paint sample')
      .not.toHaveBeenCalled();
  });

  it('NavigationError after bytesComplete clears render-pending without telemetry', () => {
    const service = init('/s/abc');
    start(1, '/s/abc');
    service.markBlobBytesComplete();
    expect(service.renderPending()).toBeTrue();
    error(1, '/s/abc');
    expect(service.renderPending()).toBeFalse();
    expect(logger.event).not.toHaveBeenCalled();
  });

  it('NavigationSkipped after bytesComplete clears render-pending without telemetry', () => {
    const service = init('/s/abc');
    start(1, '/s/abc');
    service.markBlobBytesComplete();
    expect(service.renderPending()).toBeTrue();
    skipped(1, '/s/abc');
    expect(service.renderPending()).toBeFalse();
    expect(logger.event).not.toHaveBeenCalled();
  });

  it('NavigationError on first blob nav with no bytesComplete does NOT enter render-pending', () => {
    const service = init('/s/abc');
    start(1, '/s/abc');
    expect(service.kind()).toBe('blob');
    error(1, '/s/abc');
    expect(service.kind()).toBeNull();
    expect(service.renderPending()).toBeFalse();
    expect(logger.event).not.toHaveBeenCalled();
  });

  it('NavigationSkipped on first blob nav with no bytesComplete does NOT enter render-pending', () => {
    // The router can fire NavigationSkipped (e.g. for an identical
    // URL) instead of End. Without bytesComplete there is no tree to
    // render, so the splash hides cleanly.
    const service = init('/s/abc');
    start(1, '/s/abc');
    expect(service.kind()).toBe('blob');
    skipped(1, '/s/abc');
    expect(service.kind()).toBeNull();
    expect(service.renderPending()).toBeFalse();
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
    service.markBlobBytesComplete();
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
    // start(1,/s/foo) -> start(2,/s/bar) -> cancel(1) -> bytesComplete (for nav 2) -> end(2)
    // The render-pending stage must enter exactly once, on
    // bytesComplete after the surviving nav's body arrives.
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
    service.markBlobBytesComplete();
    expect(service.renderPending()).toBeTrue();
    end(2, '/s/bar');
    expect(service.kind()).toBeNull();
    expect(service.renderPending())
      .withContext('NavigationEnd preserves render-pending so HomeComponent can paint')
      .toBeTrue();
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
    // bytesComplete still fires from BlobService (it does not know
    // whether this is cold-boot or in-app), but the splash service
    // gates it out via the kind!=='blob' guard.
    service.markBlobBytesComplete();
    expect(service.renderPending())
      .withContext('in-app bytesComplete is gated out by kind!==blob guard')
      .toBeFalse();
    end(2, '/s/xyz');
    expect(service.kind()).toBeNull();
    expect(service.renderPending()).toBeFalse();
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
    service.markBlobBytesComplete();
    expect(service.kind()).toBeNull();
    expect(service.renderPending())
      .withContext('bytesComplete during the in-flight blob window enters render-pending')
      .toBeTrue();
    end(2, '/s/abc');
    expect(service.kind()).toBeNull();
    expect(service.renderPending())
      .withContext('NavigationEnd preserves render-pending')
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
    service.markBlobBytesComplete();
    expect(service.renderPending()).toBeTrue();
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

  describe('prerender-marker boot (v0.12.1: marker is splash-discrimination no-op on browser)', () => {
    function withPrerenderMarker<T>(action: () => T): T {
      const meta = document.createElement('meta');
      meta.setAttribute('name', 'prerendered');
      meta.setAttribute('content', 'true');
      document.head.appendChild(meta);
      try {
        return action();
      } finally {
        meta.remove();
      }
    }

    it('browser-side: <meta name="prerendered"> no longer suppresses the Angular splash', () => {
      // Pre-v0.12.1 the marker pre-latched firstNavComplete so the
      // Angular splash stayed at kind=null; that masked the home
      // server-skeleton bleed-through with a blank screen instead of
      // covering it with a splash. v0.12.1 drops the marker check on
      // browser so the splash boots normally on prerendered routes
      // -- AppComponent's removal of #jot-static-splash hands the
      // overlay off to the Angular splash (visually identical).
      const service = withPrerenderMarker(() => init('/'));
      expect(service.kind())
        .withContext(
          'prerendered route boot must NOT pre-latch firstNavComplete; the Angular splash boots like any other browser cold-boot',
        )
        .toBe('jotjson');
      expect(service.renderPending()).toBeFalse();
    });

    it('browser-side: NavigationStart on prerendered route flows like a normal cold boot', () => {
      const service = withPrerenderMarker(() => init('/'));
      start(1, '/');
      expect(service.kind())
        .withContext('non-blob URL during first-nav window stays at jotjson')
        .toBe('jotjson');
      end(1, '/');
      expect(service.kind())
        .withContext('first NavigationEnd latches firstNavComplete and hides the splash')
        .toBeNull();
      expect(service.renderPending()).toBeFalse();
    });

    it('browser-side: shell-fallback boot (no marker) is identical to marker-present boot', () => {
      // Regression-prevention: with the marker check dropped on
      // browser, marker presence is irrelevant. Both paths must boot
      // at kind=jotjson and follow the standard splash lifecycle.
      const service = init('/blobs');
      expect(service.kind())
        .withContext('no marker -> splash boots at jotjson (matches marker-present case)')
        .toBe('jotjson');
      start(1, '/blobs');
      expect(service.kind()).toBe('jotjson');
      end(1, '/blobs');
      expect(service.kind()).toBeNull();
    });

    it('server platform: kind=null and firstNavComplete is pre-latched (SSR pass renders empty splash for crawlers)', () => {
      // The SSR pass during static prerender must NOT serialize a
      // visible splash overlay into the prerendered HTML; crawlers
      // would index splash markup instead of the route's actual
      // server-side content (e.g. home brand + tagline).
      const service = initOnServerPlatform('/');
      expect(service.kind())
        .withContext('server platform forces kind=null so <app-loading-splash> serializes empty')
        .toBeNull();
      // Firing a synthetic NavigationStart confirms firstNavComplete
      // is pre-latched: kind stays null even before any End event.
      start(1, '/');
      expect(service.kind())
        .withContext('pre-latched firstNavComplete keeps kind=null on server through nav events')
        .toBeNull();
      end(1, '/');
      expect(service.kind()).toBeNull();
      expect(service.renderPending()).toBeFalse();
    });
  });
});
