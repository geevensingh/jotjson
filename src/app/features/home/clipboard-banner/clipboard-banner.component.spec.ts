import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ClipboardBannerComponent } from './clipboard-banner.component';
import {
  ClipboardPermissionState,
  ClipboardPollingService,
} from '../../../core/clipboard/clipboard-polling.service';
import { PreferencesService } from '../../../core/preferences/preferences.service';
import { DEFAULT_PREFERENCES } from '../../../core/preferences/preferences.service';

describe('ClipboardBannerComponent', () => {
  let permissionState: ReturnType<typeof signal<ClipboardPermissionState>>;
  let prefsSignal: ReturnType<typeof signal<typeof DEFAULT_PREFERENCES>>;
  let enableSpy: jasmine.Spy;
  let updateSpy: jasmine.Spy;

  beforeEach(() => {
    permissionState = signal<ClipboardPermissionState>('prompt');
    prefsSignal = signal({ ...DEFAULT_PREFERENCES });
    enableSpy = jasmine.createSpy('enable').and.resolveTo('granted');
    updateSpy = jasmine
      .createSpy('update')
      .and.callFake((patch: Partial<typeof DEFAULT_PREFERENCES>) => {
        prefsSignal.set({ ...prefsSignal(), ...patch });
      });

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ClipboardBannerComponent],
      providers: [
        {
          provide: ClipboardPollingService,
          useValue: {
            permissionState: permissionState.asReadonly(),
            enable: enableSpy,
          },
        },
        {
          provide: PreferencesService,
          useValue: {
            prefs: prefsSignal.asReadonly(),
            update: updateSpy,
          },
        },
      ],
    });
  });

  function create() {
    const fixture = TestBed.createComponent(ClipboardBannerComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('is visible when state=prompt and banner not seen', () => {
    const fixture = create();
    expect(fixture.componentInstance.visible()).toBe(true);
    expect((fixture.nativeElement as HTMLElement).querySelector('.banner')).toBeTruthy();
  });

  it('is visible when state=unknown', () => {
    permissionState.set('unknown');
    const fixture = create();
    expect(fixture.componentInstance.visible()).toBe(true);
  });

  it('is hidden when state=granted', () => {
    permissionState.set('granted');
    const fixture = create();
    expect(fixture.componentInstance.visible()).toBe(false);
    expect((fixture.nativeElement as HTMLElement).querySelector('.banner')).toBeNull();
  });

  it('is hidden when state=denied', () => {
    permissionState.set('denied');
    const fixture = create();
    expect(fixture.componentInstance.visible()).toBe(false);
  });

  it('is hidden when state=unsupported', () => {
    permissionState.set('unsupported');
    const fixture = create();
    expect(fixture.componentInstance.visible()).toBe(false);
  });

  it('is hidden when seenClipboardBanner=true', () => {
    prefsSignal.set({ ...prefsSignal(), seenClipboardBanner: true });
    const fixture = create();
    expect(fixture.componentInstance.visible()).toBe(false);
  });

  it('Allow click calls enable() and marks banner seen', async () => {
    const fixture = create();
    await fixture.componentInstance.onAllow();
    expect(enableSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith({ seenClipboardBanner: true });
  });

  it('Not now click marks banner seen without calling enable()', () => {
    const fixture = create();
    fixture.componentInstance.onDismiss();
    expect(enableSpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledWith({ seenClipboardBanner: true });
  });

  it('emits dismissed output on Allow and Dismiss', async () => {
    const fixture = create();
    const spy = jasmine.createSpy('dismissed');
    fixture.componentInstance.dismissed.subscribe(spy);
    fixture.componentInstance.onDismiss();
    await fixture.componentInstance.onAllow();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
