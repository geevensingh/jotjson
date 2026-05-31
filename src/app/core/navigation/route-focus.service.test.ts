import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { NavigationEnd, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { RouteFocusService } from './route-focus.service';

/**
 * Unit spec for the M7g-3a `RouteFocusService`. Verifies the three
 * invariants the service guarantees:
 *  1. The very first NavigationEnd is skipped (browser cold-boot
 *     default keeps focus where the OS placed it).
 *  2. Subsequent NavigationEnd events focus `<main id="main-content">`.
 *  3. A missing `<main id="main-content">` is a graceful no-op (some
 *     routes may temporarily lack the landmark while work-in-progress).
 */
describe('RouteFocusService', () => {
  let events$: Subject<unknown>;
  let main: HTMLElement | null;

  beforeEach(() => {
    events$ = new Subject<unknown>();
    main = null;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: Router, useValue: { events: events$.asObservable() } }],
    });
  });

  afterEach(() => {
    if (main && main.parentNode) main.parentNode.removeChild(main);
    main = null;
  });

  function createMain(): HTMLElement {
    const element = document.createElement('main');
    element.id = 'main-content';
    document.body.appendChild(element);
    return element;
  }

  it('skips the first NavigationEnd', fakeAsync(() => {
    main = createMain();
    TestBed.inject(RouteFocusService);
    vi.spyOn(main, 'focus');

    events$.next(new NavigationEnd(1, '/', '/'));
    tick(0);

    expect(
      main.focus,
      'first NavigationEnd is the cold-boot nav; service must not intervene',
    ).not.toHaveBeenCalled();
  }));

  it('focuses <main id="main-content"> on subsequent NavigationEnd events', fakeAsync(() => {
    main = createMain();
    TestBed.inject(RouteFocusService);
    vi.spyOn(main, 'focus');

    events$.next(new NavigationEnd(1, '/', '/'));
    tick(0);
    events$.next(new NavigationEnd(2, '/', '/blobs'));
    tick(0);

    expect(
      main.focus,
      'second NavigationEnd should move focus to the new route landmark',
    ).toHaveBeenCalledTimes(1);
    expect(main.focus).toHaveBeenCalledWith({ preventScroll: true });
  }));

  it('adds tabindex="-1" to <main> if missing so focus() succeeds', fakeAsync(() => {
    main = createMain();
    expect(main.hasAttribute('tabindex')).toBe(false);
    TestBed.inject(RouteFocusService);

    events$.next(new NavigationEnd(1, '/', '/'));
    tick(0);
    events$.next(new NavigationEnd(2, '/', '/blobs'));
    tick(0);

    expect(
      main.getAttribute('tabindex'),
      'non-interactive <main> needs tabindex=-1 to be focus()-able',
    ).toBe('-1');
  }));

  it('preserves an existing tabindex on <main>', fakeAsync(() => {
    main = createMain();
    main.setAttribute('tabindex', '0');
    TestBed.inject(RouteFocusService);

    events$.next(new NavigationEnd(1, '/', '/'));
    tick(0);
    events$.next(new NavigationEnd(2, '/', '/blobs'));
    tick(0);

    expect(main.getAttribute('tabindex'), 'an existing tabindex must not be overwritten').toBe('0');
  }));

  it('is a no-op when no <main id="main-content"> is in the DOM', fakeAsync(() => {
    TestBed.inject(RouteFocusService);

    events$.next(new NavigationEnd(1, '/', '/'));
    tick(0);
    expect(() => {
      events$.next(new NavigationEnd(2, '/', '/blobs'));
      tick(0);
    }, 'missing landmark must not throw').not.toThrow();
  }));
});
