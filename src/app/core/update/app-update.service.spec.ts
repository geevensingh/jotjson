import { TestBed } from '@angular/core/testing';
import { MatSnackBar, MatSnackBarRef } from '@angular/material/snack-bar';
import {
  SwUpdate,
  UnrecoverableStateEvent,
  VersionEvent,
  VersionReadyEvent
} from '@angular/service-worker';
import { Subject } from 'rxjs';
import { AppUpdateService } from './app-update.service';

/**
 * Lightweight SwUpdate stand-in. We drive the two observables the service
 * listens to and stub `activateUpdate` so the tests don't depend on
 * @angular/service-worker internals.
 */
function makeSwUpdateStub(enabled: boolean): {
  stub: SwUpdate;
  versions$: Subject<VersionEvent>;
  unrecoverable$: Subject<UnrecoverableStateEvent>;
  activate: jasmine.Spy;
} {
  const versions$ = new Subject<VersionEvent>();
  const unrecoverable$ = new Subject<UnrecoverableStateEvent>();
  const activate = jasmine
    .createSpy('activateUpdate')
    .and.returnValue(Promise.resolve(true));
  const stub = {
    isEnabled: enabled,
    versionUpdates: versions$.asObservable(),
    unrecoverable: unrecoverable$.asObservable(),
    activateUpdate: activate
  } as unknown as SwUpdate;
  return { stub, versions$, unrecoverable$, activate };
}

describe('AppUpdateService', () => {
  let snackOpen: jasmine.Spy;
  let actionSubject: Subject<void>;
  let snackRef: MatSnackBarRef<unknown>;

  function setup(enabled: boolean) {
    const sw = makeSwUpdateStub(enabled);
    actionSubject = new Subject<void>();
    snackRef = {
      onAction: () => actionSubject.asObservable()
    } as unknown as MatSnackBarRef<unknown>;
    snackOpen = jasmine.createSpy('snack.open').and.returnValue(snackRef);
    TestBed.configureTestingModule({
      providers: [
        AppUpdateService,
        { provide: SwUpdate, useValue: sw.stub },
        { provide: MatSnackBar, useValue: { open: snackOpen } }
      ]
    });
    const service = TestBed.inject(AppUpdateService);
    const reload = spyOn(
      service as unknown as { reload: () => void },
      'reload'
    );
    return { service, sw, reload };
  }

  it('no-ops when SwUpdate is disabled', () => {
    const { service, sw } = setup(false);
    service.initialize();
    sw.versions$.next({
      type: 'VERSION_READY',
      currentVersion: { hash: 'a' },
      latestVersion: { hash: 'b' }
    } as VersionReadyEvent);
    expect(snackOpen).not.toHaveBeenCalled();
  });

  it('opens a snackbar with a Reload action on VERSION_READY', () => {
    const { service, sw } = setup(true);
    service.initialize();
    sw.versions$.next({
      type: 'VERSION_READY',
      currentVersion: { hash: 'a' },
      latestVersion: { hash: 'b' }
    } as VersionReadyEvent);
    expect(snackOpen).toHaveBeenCalledTimes(1);
    const [, action, config] = snackOpen.calls.mostRecent().args as [
      string,
      string,
      { duration: number }
    ];
    expect(action).toBe('Reload');
    expect(config.duration).toBe(0);
  });

  it('ignores non-VERSION_READY version events', () => {
    const { service, sw } = setup(true);
    service.initialize();
    sw.versions$.next({
      type: 'VERSION_DETECTED',
      version: { hash: 'b' }
    } as VersionEvent);
    sw.versions$.next({
      type: 'NO_NEW_VERSION_DETECTED',
      version: { hash: 'a' }
    } as VersionEvent);
    expect(snackOpen).not.toHaveBeenCalled();
  });

  it('activates the update and reloads when Reload is clicked', async () => {
    const { service, sw, reload } = setup(true);
    service.initialize();
    sw.versions$.next({
      type: 'VERSION_READY',
      currentVersion: { hash: 'a' },
      latestVersion: { hash: 'b' }
    } as VersionReadyEvent);
    actionSubject.next();
    await Promise.resolve();
    await Promise.resolve();
    expect(sw.activate).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('still reloads if activateUpdate throws', async () => {
    const { service, sw, reload } = setup(true);
    sw.activate.and.returnValue(Promise.reject(new Error('boom')));
    spyOn(console, 'warn');
    service.initialize();
    sw.versions$.next({
      type: 'VERSION_READY',
      currentVersion: { hash: 'a' },
      latestVersion: { hash: 'b' }
    } as VersionReadyEvent);
    actionSubject.next();
    // Let the rejected promise + swallow-log + reload microtasks settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('hard-reloads with a cache-busting query on unrecoverable', () => {
    const { service, sw } = setup(true);
    const replace = spyOn(
      service as unknown as { replaceLocation: (url: string) => void },
      'replaceLocation'
    );
    spyOn(console, 'warn');
    service.initialize();
    sw.unrecoverable$.next({
      type: 'UNRECOVERABLE_STATE',
      reason: 'manifest mismatch'
    } as UnrecoverableStateEvent);
    expect(replace).toHaveBeenCalledTimes(1);
    const target = replace.calls.mostRecent().args[0] as string;
    expect(target).toContain('_swreload=');
  });

  it('initialize is idempotent', () => {
    const { service, sw } = setup(true);
    service.initialize();
    service.initialize();
    sw.versions$.next({
      type: 'VERSION_READY',
      currentVersion: { hash: 'a' },
      latestVersion: { hash: 'b' }
    } as VersionReadyEvent);
    expect(snackOpen).toHaveBeenCalledTimes(1);
  });
});
