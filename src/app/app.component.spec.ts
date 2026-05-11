import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { attachFixtureToBody, expectNoStrictA11yViolations } from '../testing/a11y';
import { provideFakeAuth } from '../testing/auth.testing';
import { AppComponent } from './app.component';
import { LoggerService } from './core/telemetry/logger.service';
import { RouteTracker } from './core/telemetry/route-tracker';
import { AppUpdateService } from './core/update/app-update.service';
import { DocumentDropController } from './core/upload/document-drop-controller.service';

function waitForDoubleAnimationFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

interface RafController {
  step: () => Promise<void>;
  pendingCount: () => number;
  waitForPending: (n: number, timeoutMs?: number) => Promise<void>;
  restore: () => void;
}

// Replaces the real `window.requestAnimationFrame` with a manual queue
// so tests can step rAF turns deterministically. AppComponent's static-
// splash removal hook is `afterNextRender(() => rAF(() => rAF(remove)))`,
// and the previous tests that timed real rAFs were intermittently flaky
// in CI because Angular's afterNextRender outer rAF could land in the
// same animation frame as the test's own rAF. The shim isolates the
// two nested rAFs from any framework-side scheduling.
//
// Note: the shim does NOT control `afterNextRender` itself - that is
// scheduled through Angular's after-render manager, not rAF. Use
// `waitForPending(1)` after `whenStable()` to wait for the outer rAF
// to land in the controlled queue before stepping.
function installControlledRaf(): RafController {
  const queue: FrameRequestCallback[] = [];
  const original = window.requestAnimationFrame;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  }) as typeof window.requestAnimationFrame;
  return {
    step: async () => {
      const cb = queue.shift();
      if (cb) {
        cb(performance.now());
      }
      // Microtask flush so any work scheduled inside the callback
      // settles before the next assertion.
      await Promise.resolve();
    },
    pendingCount: () => queue.length,
    waitForPending: async (n, timeoutMs = 1000) => {
      const start = Date.now();
      while (queue.length < n) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `timed out waiting for ${n} pending rAF callback(s); have ${queue.length}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    },
    restore: () => {
      window.requestAnimationFrame = original;
    },
  };
}

describe('AppComponent', () => {
  let loggerServiceSpy: jasmine.SpyObj<LoggerService>;
  let routeTrackerSpy: jasmine.SpyObj<RouteTracker>;
  let appUpdateServiceSpy: jasmine.SpyObj<AppUpdateService>;
  let teardown: (() => void) | undefined;

  beforeEach(async () => {
    loggerServiceSpy = jasmine.createSpyObj<LoggerService>('LoggerService', ['event', 'connect']);
    loggerServiceSpy.connect.and.resolveTo();
    routeTrackerSpy = jasmine.createSpyObj<RouteTracker>('RouteTracker', ['start', 'flushPending']);
    appUpdateServiceSpy = jasmine.createSpyObj<AppUpdateService>('AppUpdateService', [
      'initialize',
    ]);

    // Stub DocumentDropController so we don't attach real document-level
    // drag/drop listeners that would leak across the Karma test run after
    // this spec's injector is torn down.
    const dropControllerStub = {
      dropActive: signal(false).asReadonly(),
      registerEditorHandler: () => () => {
        /* noop */
      },
    };

    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([]),
        { provide: LoggerService, useValue: loggerServiceSpy },
        { provide: RouteTracker, useValue: routeTrackerSpy },
        { provide: AppUpdateService, useValue: appUpdateServiceSpy },
        { provide: DocumentDropController, useValue: dropControllerStub },
        ...provideFakeAuth(),
      ],
    }).compileComponents();
  });

  afterEach(() => {
    teardown?.();
    teardown = undefined;
    // Clean up any static-splash element a test left behind so it
    // does not bleed into subsequent specs.
    document.getElementById('jot-static-splash')?.remove();
  });

  it('creates the component', () => {
    const fixture = TestBed.createComponent(AppComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('has the JotJSON title', () => {
    const fixture = TestBed.createComponent(AppComponent);
    expect(fixture.componentInstance.title).toBe('JotJSON');
  });

  it('has no critical or serious WCAG 2.1 AA violations in the shell (dark theme)', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    teardown = attachFixtureToBody(fixture, 'dark');

    await expectNoStrictA11yViolations(fixture);
  });

  it('has no critical or serious WCAG 2.1 AA violations in the shell (light theme)', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    teardown = attachFixtureToBody(fixture, 'light');

    await expectNoStrictA11yViolations(fixture);
  });

  it('eagerly instantiates DocumentDropController so drag-drop listeners attach at app start', () => {
    TestBed.createComponent(AppComponent);
    const controller = TestBed.inject(DocumentDropController);
    expect(controller).toBeTruthy();
    // dropActive signal exists and is initially false
    expect(controller.dropActive()).toBe(false);
  });

  it('eagerly initializes AppUpdateService during ngOnInit so SW listeners wire up before any user-visible work', () => {
    const fixture = TestBed.createComponent(AppComponent);
    expect(appUpdateServiceSpy.initialize).not.toHaveBeenCalled();
    // detectChanges drives the component lifecycle including ngOnInit,
    // which is browser-only and calls appUpdate.initialize() directly
    // (no lazy import) so the SwUpdate subscriptions in the service's
    // constructor have already been wired by the time the first
    // VERSION_READY postMessage from the SW could possibly arrive.
    fixture.detectChanges();
    expect(appUpdateServiceSpy.initialize).toHaveBeenCalledTimes(1);
  });

  it('emits app.boot before telemetry connects during lazy initialization', async () => {
    const callOrder: string[] = [];
    loggerServiceSpy.event.and.callFake((messageId) => {
      if (messageId === 'app.boot') {
        callOrder.push('event');
      }
    });
    loggerServiceSpy.connect.and.callFake(() => {
      callOrder.push('connect');
      return Promise.resolve();
    });
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(loggerServiceSpy.event).toHaveBeenCalledOnceWith(
      'app.boot',
      {
        version: jasmine.any(String),
        sha: jasmine.any(String),
        branch: jasmine.any(String),
        buildNumber: jasmine.any(String),
      },
      undefined,
    );
    expect(callOrder).toEqual(['event', 'connect']);
  });

  it('initializes web vitals after app.boot connect during lazy initialization', async () => {
    const initSpy = jasmine
      .createSpy<
        (logger: LoggerService, appVersion: string, buildNumber: string) => Promise<void>
      >('initWebVitals')
      .and.resolveTo();
    const webVitalsModule = await import('./core/telemetry/web-vitals');
    webVitalsModule.__setInitWebVitalsImplForTesting(initSpy);
    try {
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(initSpy).toHaveBeenCalledTimes(1);
      const [logger, appVersion, buildNumber] = initSpy.calls.mostRecent().args;
      expect(logger).toBe(loggerServiceSpy);
      expect(appVersion).toEqual(jasmine.any(String));
      expect(buildNumber).toEqual(jasmine.any(String));
    } finally {
      webVitalsModule.__resetInitWebVitalsImplForTesting();
    }
  });

  describe('static splash removal (v0.12.1)', () => {
    function setUpStaticSplash(): HTMLDivElement {
      // Match the production markup shape from src/index.html so the
      // test exercises the same selector AppComponent's removal hook
      // queries against.
      const splash = document.createElement('div');
      splash.id = 'jot-static-splash';
      splash.className = 'jot-splash';
      splash.setAttribute('role', 'status');
      splash.setAttribute('aria-live', 'polite');
      document.body.appendChild(splash);
      return splash;
    }

    it('removes #jot-static-splash after exactly two rAF turns (paint barrier)', async () => {
      // This merged spec replaces the previous double-rAF + single-rAF
      // sentinel pair. The intent of the sentinel ("guard against the
      // removal hook regressing to single-rAF") is preserved as the
      // intermediate `after 1 rAF the splash is still present`
      // assertion + queue-count check below.
      //
      // Determinism: we install a controlled-rAF shim BEFORE creating
      // the fixture so AppComponent's two nested rAFs are captured by
      // the shim, then poll the queue to wait for Angular's
      // afterNextRender to fire and queue the outer rAF.
      const splash = setUpStaticSplash();
      const raf = installControlledRaf();
      let fixture: ReturnType<typeof TestBed.createComponent<AppComponent>> | undefined;
      try {
        fixture = TestBed.createComponent(AppComponent);
        fixture.detectChanges();
        await fixture.whenStable();

        // afterNextRender runs through Angular's after-render manager,
        // not rAF. Wait for it to fire and queue the outer rAF in the
        // controlled queue before stepping.
        await raf.waitForPending(1);
        expect(raf.pendingCount()).toBe(1);

        // Step 1: outer rAF runs and queues the inner rAF.
        await raf.step();
        expect(document.getElementById('jot-static-splash'))
          .withContext('after 1 rAF the splash is still present (sentinel)')
          .toBe(splash);
        expect(raf.pendingCount())
          .withContext('inner rAF must be queued after outer rAF runs')
          .toBe(1);

        // Step 2: inner rAF removes the splash.
        await raf.step();
        expect(document.getElementById('jot-static-splash'))
          .withContext('after 2 rAFs the splash is removed')
          .toBeNull();
        expect(raf.pendingCount()).withContext('no further rAFs should be queued').toBe(0);
      } finally {
        fixture?.destroy();
        raf.restore();
      }
    });

    it('does not throw when #jot-static-splash is absent (e.g. shell.html serve path)', async () => {
      // shell.html and any post-bootstrap hot-reload path will not
      // have the static splash element. The removal hook is
      // null-safe via optional chaining and must not throw.
      expect(document.getElementById('jot-static-splash')).toBeNull();

      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
      await fixture.whenStable();
      await waitForDoubleAnimationFrame();

      expect(document.getElementById('jot-static-splash')).toBeNull();
    });
  });
});
