import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Subject } from 'rxjs';
import { PreferencesNotificationService } from './preferences-notification.service';
import { PreferencesService } from './preferences.service';

describe('PreferencesNotificationService', () => {
  let snackOpen: jasmine.Spy;
  let events$: Subject<{ kind: 'conflict' }>;
  let originalNow: () => number;
  let nowMs: number;

  beforeEach(() => {
    snackOpen = jasmine.createSpy('open');
    events$ = new Subject<{ kind: 'conflict' }>();
    originalNow = Date.now;
    nowMs = 1_000_000;
    Date.now = () => nowMs;

    TestBed.configureTestingModule({
      providers: [
        PreferencesNotificationService,
        { provide: MatSnackBar, useValue: { open: snackOpen } },
        { provide: PreferencesService, useValue: { events$: events$.asObservable() } },
      ],
    });
  });

  afterEach(() => {
    Date.now = originalNow;
  });

  it('shows a snackbar on conflict events', () => {
    TestBed.inject(PreferencesNotificationService);

    events$.next({ kind: 'conflict' });

    expect(snackOpen).toHaveBeenCalledTimes(1);
    expect(snackOpen.calls.mostRecent().args[0]).toContain('changed in another window');
  });

  it('coalesces bursts within the cooldown window', () => {
    TestBed.inject(PreferencesNotificationService);

    events$.next({ kind: 'conflict' });
    nowMs += 1_000;
    events$.next({ kind: 'conflict' });
    nowMs += 2_000;
    events$.next({ kind: 'conflict' });

    expect(snackOpen).toHaveBeenCalledTimes(1);
  });

  it('shows another toast after the cooldown expires', () => {
    TestBed.inject(PreferencesNotificationService);

    events$.next({ kind: 'conflict' });
    nowMs += 5_001;
    events$.next({ kind: 'conflict' });

    expect(snackOpen).toHaveBeenCalledTimes(2);
  });
});
