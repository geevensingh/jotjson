import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AppComponent } from './app.component';
import { LoggerService } from './core/telemetry/logger.service';
import { RouteTracker } from './core/telemetry/route-tracker';
import { AppUpdateService } from './core/update/app-update.service';
import { DocumentDropController } from './core/upload/document-drop-controller.service';
import { provideFakeAuth } from '../testing/auth.testing';

describe('AppComponent', () => {
  let loggerServiceSpy: jasmine.SpyObj<LoggerService>;
  let routeTrackerSpy: jasmine.SpyObj<RouteTracker>;
  let appUpdateServiceSpy: jasmine.SpyObj<AppUpdateService>;

  beforeEach(async () => {
    loggerServiceSpy = jasmine.createSpyObj<LoggerService>(
      'LoggerService',
      ['event', 'connect']
    );
    loggerServiceSpy.connect.and.resolveTo();
    routeTrackerSpy = jasmine.createSpyObj<RouteTracker>(
      'RouteTracker',
      ['start', 'flushPending']
    );
    appUpdateServiceSpy = jasmine.createSpyObj<AppUpdateService>(
      'AppUpdateService',
      ['initialize']
    );

    // Stub DocumentDropController so we don't attach real document-level
    // drag/drop listeners that would leak across the Karma test run after
    // this spec's injector is torn down.
    const dropControllerStub = {
      dropActive: signal(false).asReadonly(),
      registerEditorHandler: () => () => {
        /* noop */
      }
    };

    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([]),
        { provide: LoggerService, useValue: loggerServiceSpy },
        { provide: RouteTracker, useValue: routeTrackerSpy },
        { provide: AppUpdateService, useValue: appUpdateServiceSpy },
        { provide: DocumentDropController, useValue: dropControllerStub },
        ...provideFakeAuth()
      ]
    }).compileComponents();
  });

  it('creates the component', () => {
    const fixture = TestBed.createComponent(AppComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('has the JotJSON title', () => {
    const fixture = TestBed.createComponent(AppComponent);
    expect(fixture.componentInstance.title).toBe('JotJSON');
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
        dirty: jasmine.any(Boolean)
      },
      undefined
    );
    expect(callOrder).toEqual(['event', 'connect']);
  });

  it('initializes web vitals after app.boot connect during lazy initialization', async () => {
    const initSpy = jasmine.createSpy<(
      logger: LoggerService,
      appVersion: string
    ) => Promise<void>>('initWebVitals').and.resolveTo();
    const webVitalsModule = await import('./core/telemetry/web-vitals');
    webVitalsModule.__setInitWebVitalsImplForTesting(initSpy);
    try {
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(initSpy).toHaveBeenCalledTimes(1);
      const [logger, appVersion] = initSpy.calls.mostRecent().args;
      expect(logger).toBe(loggerServiceSpy);
      expect(appVersion).toEqual(jasmine.any(String));
    } finally {
      webVitalsModule.__resetInitWebVitalsImplForTesting();
    }
  });
});
