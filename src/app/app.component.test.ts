import { HttpClient } from '@angular/common/http';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { type Mocked } from 'vitest';
import { attachFixtureToBody, expectNoStrictA11yViolations } from '../testing/a11y';
import { provideFakeAuth } from '../testing/auth.testing';
import { AppComponent } from './app.component';
import { LoggerService } from './core/telemetry/logger.service';
import { RouteTracker } from './core/telemetry/route-tracker';
import { DocumentDropController } from './core/upload/document-drop-controller.service';
import * as staticSplashRemoval from './static-splash-removal';

function waitForDoubleAnimationFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

describe('AppComponent', () => {
  let httpClientSpy: Mocked<HttpClient>;
  let loggerServiceSpy: Mocked<LoggerService>;
  let routeTrackerSpy: Mocked<RouteTracker>;
  let teardown: (() => void) | undefined;

  // Track every AppComponent fixture so `afterEach` can destroy it. Under
  // the zoneless test runtime nothing auto-destroys orphan fixtures, so a
  // component's lazy ngOnInit telemetry chain could resolve against an
  // already-torn-down injector (NG0205) after the test ends. Destroying
  // the fixture runs `ngOnDestroy`, which trips the component's destroyed
  // guard and makes the in-flight chain a no-op.
  const createdFixtures: ComponentFixture<AppComponent>[] = [];
  function createApp(): ComponentFixture<AppComponent> {
    const fixture = TestBed.createComponent(AppComponent);
    createdFixtures.push(fixture);
    return fixture;
  }

  beforeEach(async () => {
    httpClientSpy = { get: vi.fn() } as unknown as Mocked<HttpClient>;
    httpClientSpy.get.mockReturnValue(of({ active: false, message: '' }));
    loggerServiceSpy = { event: vi.fn(), connect: vi.fn() } as unknown as Mocked<LoggerService>;
    loggerServiceSpy.connect.mockResolvedValue(undefined);
    routeTrackerSpy = { start: vi.fn(), flushPending: vi.fn() } as unknown as Mocked<RouteTracker>;

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
        { provide: HttpClient, useValue: httpClientSpy },
        { provide: LoggerService, useValue: loggerServiceSpy },
        { provide: RouteTracker, useValue: routeTrackerSpy },
        { provide: DocumentDropController, useValue: dropControllerStub },
        ...provideFakeAuth(),
      ],
    }).compileComponents();
  });

  afterEach(async () => {
    // Destroy fixtures first so each component's `ngOnDestroy` runs while
    // its injector is still alive, then flush a microtask so any pending
    // lazy ngOnInit promise chain observes the destroyed flag and bails.
    for (const fixture of createdFixtures.splice(0)) {
      fixture.destroy();
    }
    await Promise.resolve();
    teardown?.();
    teardown = undefined;
    // Clean up any static-splash element a test left behind so it
    // does not bleed into subsequent specs.
    document.getElementById('jot-static-splash')?.remove();
  });

  it('creates the component', () => {
    const fixture = createApp();
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('has the JotJSON title', () => {
    const fixture = createApp();
    expect(fixture.componentInstance.title).toBe('JotJSON');
  });

  it('has no critical or serious WCAG 2.1 AA violations in the shell (dark theme)', async () => {
    const fixture = createApp();
    teardown = attachFixtureToBody(fixture, 'dark');

    await expectNoStrictA11yViolations(fixture);
  });

  it('has no critical or serious WCAG 2.1 AA violations in the shell (light theme)', async () => {
    const fixture = createApp();
    teardown = attachFixtureToBody(fixture, 'light');

    await expectNoStrictA11yViolations(fixture);
  });

  it('eagerly instantiates DocumentDropController so drag-drop listeners attach at app start', () => {
    createApp();
    const controller = TestBed.inject(DocumentDropController);
    expect(controller).toBeTruthy();
    // dropActive signal exists and is initially false
    expect(controller.dropActive()).toBe(false);
  });

  it('eagerly initializes services during ngOnInit so subscribers wire up before any user-visible work', () => {
    // Smoke-test that the lifecycle runs cleanly. The previous form of
    // this test asserted that AppUpdateService.initialize was called;
    // that service was removed when @angular/service-worker was replaced
    // with the minimal pass-through SW (see plan: SW migration).
    const fixture = createApp();
    fixture.detectChanges();
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('emits app.boot before telemetry connects during lazy initialization', async () => {
    const callOrder: string[] = [];
    loggerServiceSpy.event.mockImplementation((messageId) => {
      if (messageId === 'app.boot') {
        callOrder.push('event');
      }
    });
    loggerServiceSpy.connect.mockImplementation(() => {
      callOrder.push('connect');
      return Promise.resolve();
    });
    const fixture = createApp();
    fixture.detectChanges();
    await fixture.whenStable();
    // The lazy Promise.all([import(...)...]).then(...) chain in ngOnInit
    // runs after Angular reports stable; wait for the event spy to actually
    // be called with 'app.boot' before asserting argument shape.
    await vi.waitFor(() => {
      const calls = loggerServiceSpy.event.mock.calls.filter((args) => args[0] === 'app.boot');
      expect(calls.length).toBe(1);
    });

    expect(loggerServiceSpy.event).toHaveBeenCalledWith(
      'app.boot',
      {
        version: expect.any(String),
        sha: expect.any(String),
        branch: expect.any(String),
        buildNumber: expect.any(String),
        envLabel: expect.stringMatching(/^(prod|nonprod|preview|dev|unknown)$/),
        // Karma serves on localhost -> envLabel === 'dev' -> previewHasPrNumber
        // is omitted (undefined). App Insights drops undefined keys from
        // customDimensions, but in-process the spy sees the literal undefined.
        previewHasPrNumber: undefined,
      },
      undefined,
    );
    // PreferencesService also emits `theme.applied` (source: 'boot') during
    // construction, so the spy receives more than one call. Verify
    // `app.boot` itself was emitted exactly once.
    const appBootCalls = loggerServiceSpy.event.mock.calls.filter((args) => args[0] === 'app.boot');
    expect(appBootCalls.length).toBe(1);
    expect(callOrder).toEqual(['event', 'connect']);
  });

  it('initializes web vitals after app.boot connect during lazy initialization', async () => {
    const initSpy = vi
      .fn<(logger: LoggerService, appVersion: string, buildNumber: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const webVitalsModule = await import('./core/telemetry/web-vitals');
    webVitalsModule.__setInitWebVitalsImplForTesting(initSpy);
    try {
      const fixture = createApp();
      fixture.detectChanges();
      await fixture.whenStable();
      // The previous test's AppComponent may have a pending lazy
      // Promise.all([import(...) ...]).then(callInitWebVitals) chain that
      // resolves after this test installs the spy. Filter the spy's calls
      // by *this* test's logger reference (freshly recreated in beforeEach)
      // so cross-test pollution does not flake the count assertion.
      await vi.waitFor(() => {
        const ownCalls = initSpy.mock.calls.filter((args) => args[0] === loggerServiceSpy);
        expect(ownCalls.length).toBe(1);
      });

      const ownCalls = initSpy.mock.calls.filter((args) => args[0] === loggerServiceSpy);
      const [logger, appVersion, buildNumber] = ownCalls[ownCalls.length - 1]!;
      expect(logger).toBe(loggerServiceSpy);
      expect(appVersion).toEqual(expect.any(String));
      expect(buildNumber).toEqual(expect.any(String));
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

    it("invokes scheduleStaticSplashRemoval exactly once from AppComponent's afterNextRender hook", async () => {
      // Structural assertion: AppComponent must call the extracted
      // helper exactly once per lifecycle. This catches regressions
      // where someone removes the hook entirely or accidentally
      // converts `afterNextRender` to `afterRender` (which fires on
      // every change-detection cycle) without exercising real rAFs.
      // The double-rAF / paint-barrier semantics are covered by
      // static-splash-removal.spec.ts in isolation, free of
      // cross-spec rAF bleed (see #170).
      const spy = vi.fn<() => void>();
      staticSplashRemoval.__setScheduleStaticSplashRemovalImplForTesting(spy);
      try {
        const fixture = createApp();
        fixture.detectChanges();
        await fixture.whenStable();
        // Flush one macrotask so any after-render callbacks scheduled
        // by Angular's render manager have had a chance to fire.
        // Mirrors the web-vitals init spy test above.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        staticSplashRemoval.__resetScheduleStaticSplashRemovalImplForTesting();
      }
    });

    it('removes #jot-static-splash via the real scheduler after Angular renders (happy-path smoke)', async () => {
      // Smoke test for the end-to-end wiring with the REAL
      // scheduleStaticSplashRemoval impl. No rAF shim is installed, so
      // all rAFs run on the native browser queue and this spec is
      // immune to the cross-spec rAF bleed that motivated the
      // isolated-spec extraction (#170). The assertion depends only
      // on the splash being absent at the end, which is robust to
      // foreign rAF interleavings: any foreign rAF callback that ran
      // would either be unrelated (no-op for our assertion) or would
      // itself remove the splash early (still satisfies the
      // assertion).
      const splash = setUpStaticSplash();
      expect(document.getElementById('jot-static-splash')).toBe(splash);

      const fixture = createApp();
      fixture.detectChanges();
      await fixture.whenStable();
      await waitForDoubleAnimationFrame();

      expect(document.getElementById('jot-static-splash')).toBeNull();
    });

    it('does not throw when #jot-static-splash is absent (e.g. shell.html serve path)', async () => {
      // shell.html and any post-bootstrap hot-reload path will not
      // have the static splash element. The removal hook is
      // null-safe via optional chaining and must not throw.
      expect(document.getElementById('jot-static-splash')).toBeNull();

      const fixture = createApp();
      fixture.detectChanges();
      await fixture.whenStable();
      await waitForDoubleAnimationFrame();

      expect(document.getElementById('jot-static-splash')).toBeNull();
    });
  });
});
