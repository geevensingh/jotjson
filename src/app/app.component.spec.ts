import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AppComponent } from './app.component';
import { LoggerService } from './core/telemetry/logger.service';
import { RouteTracker } from './core/telemetry/route-tracker';
import { AppUpdateService } from './core/update/app-update.service';
import { DocumentDropController } from './core/upload/document-drop-controller.service';
import { attachFixtureToBody, expectNoStrictA11yViolations } from '../testing/a11y';
import { provideFakeAuth } from '../testing/auth.testing';

function waitForSingleAnimationFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function waitForDoubleAnimationFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
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

    it('removes #jot-static-splash after the Angular splash has painted on top', async () => {
      const splash = setUpStaticSplash();
      expect(document.getElementById('jot-static-splash'))
        .withContext('precondition: static splash present in DOM before AppComponent mounts')
        .toBe(splash);

      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
      await fixture.whenStable();
      // Both rAFs of the double-rAF paint barrier must flush before
      // the removal hook fires; matches the AppComponent
      // afterNextRender + double-rAF idiom.
      await waitForDoubleAnimationFrame();

      expect(document.getElementById('jot-static-splash'))
        .withContext('static splash must be removed once Angular splash takes over')
        .toBeNull();
    });

    it('keeps #jot-static-splash present after only one rAF turn (guards single-rAF regression)', async () => {
      // Sentinel test: if the removal hook ever drops the inner rAF
      // (regressing back to single-rAF after afterNextRender), this
      // assertion fails because the static splash gets detached one
      // rAF earlier than intended -- before the browser has actually
      // committed the Angular splash paint, leaving a flash gap.
      setUpStaticSplash();

      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
      await fixture.whenStable();
      await waitForSingleAnimationFrame();

      expect(document.getElementById('jot-static-splash'))
        .withContext(
          'static splash must still be present after only one rAF turn so the Angular splash has time to paint',
        )
        .not.toBeNull();
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
