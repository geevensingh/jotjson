import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatSnackBar } from '@angular/material/snack-bar';
import { PreferencesService } from './preferences.service';

/**
 * Minimum interval between consecutive "changed elsewhere" toasts.
 * Two tabs that 412 each other in rapid succession would otherwise spam
 * the snackbar; this cooldown collapses bursts to a single visible
 * notification per window. Five seconds matches the snackbar's default
 * visible duration so the user sees the current toast before another
 * can replace it.
 */
const CONFLICT_TOAST_COOLDOWN_MS = 5_000;

/**
 * Subscribes to {@link PreferencesService.events$} and surfaces user-visible
 * notifications when preferences are changed in another window (412 conflict).
 *
 * Mirrors the `QuotaNotificationService` pattern - core/api services do not
 * inject `MatSnackBar` directly; this thin shell sits between the API service's
 * event stream and Material. AppComponent injects this service eagerly so the
 * subscription is alive for the entire session.
 */
@Injectable({ providedIn: 'root' })
export class PreferencesNotificationService {
  private readonly snack = inject(MatSnackBar);
  private readonly prefs = inject(PreferencesService);
  private readonly destroyRef = inject(DestroyRef);

  private lastToastAt = 0;

  constructor() {
    this.prefs.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((event) => {
      if (event.kind === 'conflict') {
        this.showConflictToast();
      }
    });
  }

  private showConflictToast(): void {
    const now = Date.now();
    if (now - this.lastToastAt < CONFLICT_TOAST_COOLDOWN_MS) return;
    this.lastToastAt = now;
    this.snack.open(
      $localize`:@@preferences.changedElsewhere:Preferences were changed in another window. Reverted to the latest version.`,
      $localize`:@@common.dismiss:Dismiss`,
      { duration: 5000 },
    );
  }
}
