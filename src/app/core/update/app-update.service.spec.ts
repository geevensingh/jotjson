import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar, MatSnackBarRef } from '@angular/material/snack-bar';
import {
  SwUpdate,
  UnrecoverableStateEvent,
  VersionEvent,
  VersionReadyEvent,
} from '@angular/service-worker';
import { Subject } from 'rxjs';
import { LoggerService } from '../telemetry/logger.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import { AppUpdateService } from './app-update.service';

const AUTO_APPLIED_STORAGE_KEY = 'jotjson.update.autoApplied';
const MIN_CHECK_INTERVAL_MS = 30_000;

/**
 * Lightweight SwUpdate stand-in. We drive the two observables the service
 * listens to, stub `activateUpdate` and `checkForUpdate` so the tests
 * don't depend on @angular/service-worker internals.
 */
function makeSwUpdateStub(enabled: boolean): {
  stub: SwUpdate;
  versions$: Subject<VersionEvent>;
  unrecoverable$: Subject<UnrecoverableStateEvent>;
  activate: jasmine.Spy;
  check: jasmine.Spy;
} {
  const versions$ = new Subject<VersionEvent>();
  const unrecoverable$ = new Subject<UnrecoverableStateEvent>();
  const activate = jasmine.createSpy('activateUpdate').and.returnValue(Promise.resolve(true));
  const check = jasmine.createSpy('checkForUpdate').and.returnValue(Promise.resolve(true));
  const stub = {
    isEnabled: enabled,
    versionUpdates: versions$.asObservable(),
    unrecoverable: unrecoverable$.asObservable(),
    activateUpdate: activate,
    checkForUpdate: check,
  } as unknown as SwUpdate;
  return { stub, versions$, unrecoverable$, activate, check };
}

interface SnackHarness {
  open: jasmine.Spy;
  action: Subject<void>;
  ref: MatSnackBarRef<unknown>;
}

function makeSnackHarness(): SnackHarness {
  const action = new Subject<void>();
  const ref = {
    onAction: () => action.asObservable(),
  } as unknown as MatSnackBarRef<unknown>;
  const open = jasmine.createSpy('snack.open').and.returnValue(ref);
  return { open, action, ref };
}

interface SetupOptions {
  enabled: boolean;
  platform?: 'browser' | 'server';
  keepConstructorTelemetry?: boolean;
}

interface SetupResult {
  service: AppUpdateService;
  sw: ReturnType<typeof makeSwUpdateStub>;
  snack: SnackHarness;
  logger: jasmine.SpyObj<LoggerService>;
  telemetry: jasmine.SpyObj<TelemetryService>;
  reload: jasmine.Spy;
}

function setup(opts: SetupOptions): SetupResult {
  const sw = makeSwUpdateStub(opts.enabled);
  const snack = makeSnackHarness();
  const logger = jasmine.createSpyObj<LoggerService>('LoggerService', ['event', 'warn']);
  const telemetry = jasmine.createSpyObj<TelemetryService>('TelemetryService', ['flush']);
  telemetry.flush.and.returnValue(Promise.resolve());
  TestBed.configureTestingModule({
    providers: [
      AppUpdateService,
      { provide: SwUpdate, useValue: sw.stub },
      { provide: MatSnackBar, useValue: { open: snack.open } },
      { provide: LoggerService, useValue: logger },
      { provide: TelemetryService, useValue: telemetry },
      { provide: PLATFORM_ID, useValue: opts.platform ?? 'browser' },
    ],
  });
  const service = TestBed.inject(AppUpdateService);
  if (!opts.keepConstructorTelemetry) {
    logger.event.calls.reset();
  }
  const reload = spyOn(service as unknown as { reload: () => void }, 'reload');
  return { service, sw, snack, logger, telemetry, reload };
}

/** Drive a real pointerdown so `userInteracted` flips through the
 *  same path production uses. Karma runs in a real browser, so
 *  `document.dispatchEvent` exercises the listener attached in
 *  `initialize()` directly. */
function dispatchPointerDown(): void {
  document.dispatchEvent(new Event('pointerdown'));
}

function dispatchKeyDown(): void {
  document.dispatchEvent(new KeyboardEvent('keydown'));
}

function dispatchVisibilityChange(visible: boolean): void {
  // Karma's headless Chrome does not let us truly hide the window, but
  // we can stub the property on the document for the duration of the
  // dispatch so `document.visibilityState` reads what the test wants.
  const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (visible ? 'visible' : 'hidden'),
  });
  try {
    document.dispatchEvent(new Event('visibilitychange'));
  } finally {
    if (original) {
      Object.defineProperty(Document.prototype, 'visibilityState', original);
    } else {
      // Best-effort cleanup -- restore property to a passthrough.
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
    }
  }
}

function dispatchWindowFocus(): void {
  window.dispatchEvent(new FocusEvent('focus'));
}

function makeVersionReady(fromSha = 'from-sha', toSha = 'to-sha'): VersionReadyEvent {
  return {
    type: 'VERSION_READY',
    currentVersion: { hash: 'a', appData: { buildSha: fromSha } },
    latestVersion: { hash: 'b', appData: { buildSha: toSha } },
  } as VersionReadyEvent;
}

function expectLoggerEvent(
  logger: jasmine.SpyObj<LoggerService>,
  messageId: Parameters<LoggerService['event']>[0],
  props: Parameters<LoggerService['event']>[1],
  measurements: Parameters<LoggerService['event']>[2],
): void {
  expect(logger.event).toHaveBeenCalledWith(messageId, props, measurements);
}

function loggerEventCalls(
  logger: jasmine.SpyObj<LoggerService>,
  messageId: Parameters<LoggerService['event']>[0],
): Parameters<LoggerService['event']>[] {
  return logger.event.calls.allArgs().filter((call) => call[0] === messageId);
}

function withServiceWorkerController<T>(hasController: boolean, action: () => T): T {
  const originalDescriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
  const serviceWorker = {
    controller: hasController ? ({} as ServiceWorker) : null,
  } as unknown as ServiceWorkerContainer;
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    get: () => serviceWorker,
  });
  try {
    return action();
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(navigator, 'serviceWorker', originalDescriptor);
    } else {
      Reflect.deleteProperty(navigator, 'serviceWorker');
    }
  }
}

describe('AppUpdateService', () => {
  let activeService: AppUpdateService | undefined;

  afterEach(() => {
    activeService?.__disposeForTesting();
    activeService = undefined;
    sessionStorage.removeItem(AUTO_APPLIED_STORAGE_KEY);
  });

  describe('service worker state telemetry', () => {
    it('emits update.swState once when SwUpdate is enabled', () => {
      withServiceWorkerController(true, () => {
        const { service, logger } = setup({ enabled: true, keepConstructorTelemetry: true });
        activeService = service;
        expect(logger.event).toHaveBeenCalledOnceWith(
          'update.swState',
          { swEnabled: 'true', swHasController: 'true' },
          undefined,
        );
      });
    });

    it('emits update.swState once when SwUpdate is disabled', () => {
      withServiceWorkerController(false, () => {
        const { service, logger } = setup({ enabled: false, keepConstructorTelemetry: true });
        activeService = service;
        expect(logger.event).toHaveBeenCalledOnceWith(
          'update.swState',
          { swEnabled: 'false', swHasController: 'false' },
          undefined,
        );
      });
    });
  });

  describe('disabled SW', () => {
    it('no-ops when SwUpdate is disabled', () => {
      const { service, sw, snack, reload } = setup({ enabled: false });
      activeService = service;
      service.initialize();
      sw.versions$.next(makeVersionReady());
      expect(snack.open).not.toHaveBeenCalled();
      expect(sw.activate).not.toHaveBeenCalled();
      expect(sw.check).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    });
  });

  describe('server platform', () => {
    it('does not throw on construction and does not touch browser globals', () => {
      const addDocSpy = spyOn(document, 'addEventListener').and.callThrough();
      const addWinSpy = spyOn(window, 'addEventListener').and.callThrough();
      const storageSpy = spyOn(Storage.prototype, 'setItem').and.callThrough();
      // Construction alone (no `initialize()`) must be safe.
      const { service, sw, snack } = setup({ enabled: true, platform: 'server' });
      activeService = service;
      // Even an early VERSION_READY should NOT touch browser APIs on the
      // server platform; the constructor's subscriptions are wired but
      // `onVersionReady` returns immediately when `isBrowser` is false.
      sw.versions$.next(makeVersionReady());
      expect(snack.open).not.toHaveBeenCalled();
      expect(sw.activate).not.toHaveBeenCalled();
      expect(addDocSpy).not.toHaveBeenCalled();
      expect(addWinSpy).not.toHaveBeenCalled();
      expect(storageSpy).not.toHaveBeenCalled();
    });
  });

  describe('constructor subscriptions (no late-subscribe miss)', () => {
    it('catches a VERSION_READY emitted before initialize() runs', async () => {
      const { service, sw, snack } = setup({ enabled: true });
      activeService = service;
      // No initialize(), no user interaction, sessionStorage clear ->
      // cold-launch silent auto-apply path.
      sw.versions$.next(makeVersionReady());
      // Microtask flush so the activateAndReload chain progresses.
      await Promise.resolve();
      expect(sw.activate).toHaveBeenCalledTimes(1);
      // Snackbar must NOT have opened on the silent path.
      expect(snack.open).not.toHaveBeenCalled();
    });

    it('hard-reloads on unrecoverable even before initialize() runs', () => {
      const { service, sw, logger } = setup({ enabled: true });
      activeService = service;
      const replace = spyOn(
        service as unknown as { replaceLocation: (url: string) => void },
        'replaceLocation',
      );
      sw.unrecoverable$.next({
        type: 'UNRECOVERABLE_STATE',
        reason: 'manifest mismatch',
      } as UnrecoverableStateEvent);
      expect(logger.warn).toHaveBeenCalledWith('update.unrecoverable', {
        reason: 'manifest mismatch',
      });
      expectLoggerEvent(logger, 'update.unrecoverable.event', { reasonBucket: 'other' }, undefined);
      expect(replace).toHaveBeenCalledTimes(1);
      const target = replace.calls.mostRecent().args[0] as string;
      expect(target).toContain('_swreload=');
    });

    [
      { reason: 'hash mismatch while reading manifest', reasonBucket: 'hashMismatch' },
      { reason: 'network fetch failed', reasonBucket: 'fetchFailed' },
      { reason: 'unexpected cache state', reasonBucket: 'other' },
    ].forEach((testCase) => {
      it(`emits update.unrecoverable.event reasonBucket=${testCase.reasonBucket}`, () => {
        const { service, sw, logger } = setup({ enabled: true });
        activeService = service;
        spyOn(service as unknown as { replaceLocation: (url: string) => void }, 'replaceLocation');
        sw.unrecoverable$.next({
          type: 'UNRECOVERABLE_STATE',
          reason: testCase.reason,
        } as UnrecoverableStateEvent);
        expectLoggerEvent(
          logger,
          'update.unrecoverable.event',
          { reasonBucket: testCase.reasonBucket },
          undefined,
        );
      });
    });
  });

  describe('proactive checkForUpdate triggers', () => {
    it('initialize() calls checkForUpdate exactly once', () => {
      const { service, sw } = setup({ enabled: true });
      activeService = service;
      service.initialize();
      expect(sw.check).toHaveBeenCalledTimes(1);
    });

    it('does not call checkForUpdate from the constructor (only from initialize)', () => {
      const { service, sw } = setup({ enabled: true });
      activeService = service;
      // No initialize() yet.
      expect(sw.check).not.toHaveBeenCalled();
    });

    it('triggers checkForUpdate on visibilitychange -> visible', () => {
      jasmine.clock().install();
      jasmine.clock().mockDate(new Date(0));
      try {
        const { service, sw } = setup({ enabled: true });
        activeService = service;
        service.initialize();
        sw.check.calls.reset();
        // Advance past the 30s debounce so the visibility trigger fires.
        jasmine.clock().tick(MIN_CHECK_INTERVAL_MS + 1);
        dispatchVisibilityChange(true);
        expect(sw.check).toHaveBeenCalledTimes(1);
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('does not trigger checkForUpdate on visibilitychange -> hidden', () => {
      jasmine.clock().install();
      jasmine.clock().mockDate(new Date(0));
      try {
        const { service, sw } = setup({ enabled: true });
        activeService = service;
        service.initialize();
        sw.check.calls.reset();
        jasmine.clock().tick(MIN_CHECK_INTERVAL_MS + 1);
        dispatchVisibilityChange(false);
        expect(sw.check).not.toHaveBeenCalled();
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('triggers checkForUpdate on window focus', () => {
      jasmine.clock().install();
      jasmine.clock().mockDate(new Date(0));
      try {
        const { service, sw } = setup({ enabled: true });
        activeService = service;
        service.initialize();
        sw.check.calls.reset();
        jasmine.clock().tick(MIN_CHECK_INTERVAL_MS + 1);
        dispatchWindowFocus();
        expect(sw.check).toHaveBeenCalledTimes(1);
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('debounces concurrent triggers to one call within MIN_CHECK_INTERVAL_MS', () => {
      jasmine.clock().install();
      jasmine.clock().mockDate(new Date(0));
      try {
        const { service, sw } = setup({ enabled: true });
        activeService = service;
        service.initialize();
        // initialize() already burned one call; reset to count fresh.
        sw.check.calls.reset();
        // Two triggers in quick succession (well inside 30s) -> still
        // zero calls because the init call already seeded the timestamp.
        dispatchVisibilityChange(true);
        dispatchWindowFocus();
        expect(sw.check).not.toHaveBeenCalled();
        // Move past 30s and try again -> exactly one call (debounce
        // releases) even though both triggers fire again.
        jasmine.clock().tick(MIN_CHECK_INTERVAL_MS + 1);
        dispatchVisibilityChange(true);
        dispatchWindowFocus();
        expect(sw.check).toHaveBeenCalledTimes(1);
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('attaches no listeners and never calls checkForUpdate when SwUpdate is disabled', () => {
      jasmine.clock().install();
      jasmine.clock().mockDate(new Date(0));
      try {
        const { service, sw } = setup({ enabled: false });
        activeService = service;
        service.initialize();
        jasmine.clock().tick(MIN_CHECK_INTERVAL_MS + 1);
        dispatchVisibilityChange(true);
        dispatchWindowFocus();
        expect(sw.check).not.toHaveBeenCalled();
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('swallows checkForUpdate rejections', async () => {
      const { service, sw, logger } = setup({ enabled: true });
      activeService = service;
      sw.check.and.returnValue(Promise.reject(new Error('offline')));
      service.initialize();
      // Let the rejected promise + swallow path settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('emits update.check.result result=noChange when the init check resolves false', async () => {
      const { service, sw, logger } = setup({ enabled: true });
      activeService = service;
      sw.check.and.returnValue(Promise.resolve(false));
      service.initialize();
      await Promise.resolve();
      expect(logger.event).toHaveBeenCalledWith(
        'update.check.result',
        { reason: 'init', result: 'noChange' },
        { durationMs: jasmine.any(Number) },
      );
    });

    it('emits update.check.result result=newVersion when the init check resolves true', async () => {
      const { service, sw, logger } = setup({ enabled: true });
      activeService = service;
      sw.check.and.returnValue(Promise.resolve(true));
      service.initialize();
      await Promise.resolve();
      expect(logger.event).toHaveBeenCalledWith(
        'update.check.result',
        { reason: 'init', result: 'newVersion' },
        { durationMs: jasmine.any(Number) },
      );
    });

    it('emits update.check.result result=error when the init check rejects', async () => {
      const { service, sw, logger } = setup({ enabled: true });
      activeService = service;
      sw.check.and.returnValue(Promise.reject(new Error('offline')));
      service.initialize();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(logger.event).toHaveBeenCalledWith(
        'update.check.result',
        { reason: 'init', result: 'error' },
        { durationMs: jasmine.any(Number) },
      );
    });

    it('emits update.check.result result=swNotReady when SwUpdate is disabled', () => {
      const { service, logger } = setup({ enabled: false });
      activeService = service;
      service.initialize();
      expect(logger.event).toHaveBeenCalledWith(
        'update.check.result',
        { reason: 'init', result: 'swNotReady' },
        { durationMs: jasmine.any(Number) },
      );
    });
  });

  describe('cold-launch silent auto-apply', () => {
    it('emits update.versionReady with pathTaken=silentApply before auto-apply', () => {
      const { service, sw, logger } = setup({ enabled: true });
      activeService = service;
      sw.check.and.returnValue(new Promise<boolean>(() => undefined));
      sw.activate.and.returnValue(new Promise<boolean>(() => undefined));
      service.initialize();
      logger.event.calls.reset();
      sw.versions$.next(makeVersionReady('current-build', 'next-build'));
      expect(logger.event).toHaveBeenCalledWith(
        'update.versionReady',
        {
          userInteracted: 'false',
          guardClaimed: 'true',
          pathTaken: 'silentApply',
          fromSha: 'current-build',
          toSha: 'next-build',
        },
        { msSinceBoot: jasmine.any(Number) },
      );
    });

    it('silently applies + emits update.applied with trigger=autoApply on a pre-interaction VERSION_READY', async () => {
      const { service, sw, snack, logger, telemetry, reload } = setup({ enabled: true });
      activeService = service;
      service.initialize();
      sw.versions$.next(makeVersionReady());
      // Drain microtasks for the activateAndReload chain.
      await Promise.resolve();
      await Promise.resolve();
      expect(snack.open).not.toHaveBeenCalled();
      expect(sw.activate).toHaveBeenCalledTimes(1);
      expectLoggerEvent(logger, 'update.applied', { trigger: 'autoApply' }, undefined);
      expect(loggerEventCalls(logger, 'update.applied')).toHaveSize(1);
      expect(telemetry.flush).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(1);
      // Loop-guard claimed.
      expect(sessionStorage.getItem(AUTO_APPLIED_STORAGE_KEY)).toBe('1');
    });

    it('falls back to the snackbar when the loop-guard is already claimed', () => {
      sessionStorage.setItem(AUTO_APPLIED_STORAGE_KEY, '1');
      const { service, sw, snack } = setup({ enabled: true });
      activeService = service;
      service.initialize();
      sw.versions$.next(makeVersionReady());
      expect(snack.open).toHaveBeenCalledTimes(1);
      expect(sw.activate).not.toHaveBeenCalled();
    });

    it('falls back to the snackbar when sessionStorage.setItem throws', () => {
      const { service, sw, snack } = setup({ enabled: true });
      activeService = service;
      const setItemSpy = spyOn(Storage.prototype, 'setItem').and.throwError('quota');
      service.initialize();
      sw.versions$.next(makeVersionReady());
      expect(snack.open).toHaveBeenCalledTimes(1);
      expect(sw.activate).not.toHaveBeenCalled();
      // The guard read happened before the throwing setItem.
      expect(setItemSpy).toHaveBeenCalled();
    });

    it('a second VERSION_READY in the same session shows the snackbar even if the user still has not interacted', async () => {
      const { service, sw, snack } = setup({ enabled: true });
      activeService = service;
      service.initialize();
      sw.versions$.next(makeVersionReady());
      await Promise.resolve();
      await Promise.resolve();
      // First VERSION_READY went silent -> snackbar must NOT have opened.
      expect(snack.open).not.toHaveBeenCalled();
      // The guard is now set; a second VERSION_READY must surface the snackbar.
      sw.versions$.next(makeVersionReady());
      expect(snack.open).toHaveBeenCalledTimes(1);
    });
  });

  describe('mid-session snackbar path', () => {
    it('emits update.versionReady with pathTaken=snackbar after user interaction', () => {
      const { service, sw, snack, logger } = setup({ enabled: true });
      activeService = service;
      sw.check.and.returnValue(new Promise<boolean>(() => undefined));
      service.initialize();
      logger.event.calls.reset();
      dispatchPointerDown();
      sw.versions$.next(makeVersionReady('current-build', 'next-build'));
      expect(snack.open).toHaveBeenCalledTimes(1);
      expect(logger.event).toHaveBeenCalledWith(
        'update.versionReady',
        {
          userInteracted: 'true',
          guardClaimed: 'false',
          pathTaken: 'snackbar',
          fromSha: 'current-build',
          toSha: 'next-build',
        },
        { msSinceBoot: jasmine.any(Number) },
      );
    });

    it('shows the snackbar after a pointerdown has flipped userInteracted', () => {
      const { service, sw, snack } = setup({ enabled: true });
      activeService = service;
      service.initialize();
      dispatchPointerDown();
      sw.versions$.next(makeVersionReady());
      expect(snack.open).toHaveBeenCalledTimes(1);
      expect(sw.activate).not.toHaveBeenCalled();
      // Loop guard untouched on the mid-session path.
      expect(sessionStorage.getItem(AUTO_APPLIED_STORAGE_KEY)).toBeNull();
    });

    it('keydown also flips userInteracted', () => {
      const { service, sw, snack } = setup({ enabled: true });
      activeService = service;
      service.initialize();
      dispatchKeyDown();
      sw.versions$.next(makeVersionReady());
      expect(snack.open).toHaveBeenCalledTimes(1);
    });

    it('emits update.applied with trigger=snackbar after the user clicks Reload', async () => {
      const { service, sw, snack, logger, telemetry, reload } = setup({ enabled: true });
      activeService = service;
      let resolveFlush: (() => void) | undefined;
      const flushPromise = new Promise<void>((resolve) => {
        resolveFlush = resolve;
      });
      telemetry.flush.and.returnValue(flushPromise);
      service.initialize();
      dispatchPointerDown();
      sw.versions$.next(makeVersionReady());
      snack.action.next();
      await Promise.resolve();
      expect(sw.activate).toHaveBeenCalledTimes(1);
      expectLoggerEvent(logger, 'update.applied', { trigger: 'snackbar' }, undefined);
      expect(loggerEventCalls(logger, 'update.applied')).toHaveSize(1);
      expect(telemetry.flush).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
      if (!resolveFlush) {
        fail('flush promise resolver was not captured');
        return;
      }
      resolveFlush();
      await flushPromise;
      await Promise.resolve();
      expect(reload).toHaveBeenCalledTimes(1);
      expect(logger.event).toHaveBeenCalledBefore(telemetry.flush);
      expect(telemetry.flush).toHaveBeenCalledBefore(reload);
    });

    it('does not emit update.applied or flush telemetry if activateUpdate throws', async () => {
      const { service, sw, snack, logger, telemetry, reload } = setup({ enabled: true });
      activeService = service;
      sw.activate.and.returnValue(Promise.reject(new Error('boom')));
      service.initialize();
      dispatchPointerDown();
      sw.versions$.next(makeVersionReady());
      snack.action.next();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(logger.warn).toHaveBeenCalledWith('update.activate.failed');
      expect(loggerEventCalls(logger, 'update.applied')).toHaveSize(0);
      expect(telemetry.flush).not.toHaveBeenCalled();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('ignores non-VERSION_READY version events', () => {
      const { service, sw, snack } = setup({ enabled: true });
      activeService = service;
      service.initialize();
      sw.versions$.next({ type: 'VERSION_DETECTED', version: { hash: 'b' } } as VersionEvent);
      sw.versions$.next({
        type: 'NO_NEW_VERSION_DETECTED',
        version: { hash: 'a' },
      } as VersionEvent);
      expect(snack.open).not.toHaveBeenCalled();
      expect(sw.activate).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle', () => {
    it('initialize is idempotent', () => {
      const { service, sw } = setup({ enabled: true });
      activeService = service;
      service.initialize();
      service.initialize();
      // Only the first initialize() may seed the immediate maybeCheck and
      // attach listeners; the second must short-circuit.
      expect(sw.check).toHaveBeenCalledTimes(1);
    });
  });
});
