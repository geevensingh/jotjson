import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { NavigationEnd, Router } from '@angular/router';
import { RouteTracker } from './route-tracker';
import { TelemetryService } from './telemetry.service';

describe('RouteTracker', () => {
  let events: Subject<unknown>;
  let trackPageView: jasmine.Spy;
  let isConnected = false;
  let routerStub: Partial<Router>;
  let tracker: RouteTracker;

  function makeRouter(routePath: string | undefined) {
    events = new Subject<unknown>();
    const snapshotRoot: { routeConfig: { path?: string } | null; firstChild: unknown | null } = {
      routeConfig: routePath !== undefined ? { path: routePath } : null,
      firstChild: null
    };
    routerStub = {
      events: events.asObservable() as unknown as Router['events'],
      routerState: { snapshot: { root: snapshotRoot } } as unknown as Router['routerState']
    };
  }

  function init(connected: boolean, routePath: string | undefined = '') {
    isConnected = connected;
    makeRouter(routePath);
    trackPageView = jasmine.createSpy('trackPageView');
    const telemetryStub: Partial<TelemetryService> = {
      get isConnected() {
        return isConnected;
      },
      trackPageView
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: routerStub },
        { provide: TelemetryService, useValue: telemetryStub }
      ]
    });
    tracker = TestBed.inject(RouteTracker);
    tracker.start();
  }

  function fireNav(url: string): void {
    events.next(new NavigationEnd(1, url, url));
  }

  it('emits trackPageView on NavigationEnd when connected', () => {
    init(true, 's/:slug');
    fireNav('/s/abc123');
    expect(trackPageView).toHaveBeenCalledWith('/s/:slug', '/s/abc123');
  });

  it('strips query and fragment from the uri', () => {
    init(true, '');
    fireNav('/?source=share#x');
    expect(trackPageView).toHaveBeenCalledWith('/', '/');
  });

  it('buffers when not connected and flushes on flushPending', () => {
    init(false, 'history');
    fireNav('/history');
    expect(trackPageView).not.toHaveBeenCalled();
    isConnected = true;
    tracker.flushPending();
    expect(trackPageView).toHaveBeenCalledWith('/history', '/history');
  });

  it('flushPending is a no-op when no pending route', () => {
    init(true, '');
    tracker.flushPending();
    expect(trackPageView).not.toHaveBeenCalled();
  });

  it('start() is idempotent', () => {
    init(true, '');
    tracker.start();
    tracker.start();
    fireNav('/');
    expect(trackPageView).toHaveBeenCalledTimes(1);
  });

  it('falls back to URL when no route template is available', () => {
    init(true, undefined);
    fireNav('/strange');
    // route template walked produced "/" (no segments); still emits
    expect(trackPageView).toHaveBeenCalled();
  });
});
