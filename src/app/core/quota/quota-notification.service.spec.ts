import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import {
  QuotaFirstTimeDialogComponent,
  QuotaManualFullDialogComponent,
  QuotaNotificationService
} from './quota-notification.service';
import { PreferencesService } from '../preferences/preferences.service';
import type { UserPreferences } from '../api/models';

describe('QuotaNotificationService', () => {
  let service: QuotaNotificationService;
  let snackOpen: jasmine.Spy;
  let dialogOpen: jasmine.Spy;
  let prefsUpdate: jasmine.Spy;
  let prefsSignal: UserPreferences;

  beforeEach(() => {
    prefsSignal = {
      seenBlobQuotaModal: false,
      blobQuotaStrategy: 'auto_fifo'
    } as unknown as UserPreferences;

    snackOpen = jasmine.createSpy('snack.open');
    dialogOpen = jasmine.createSpy('dialog.open');
    prefsUpdate = jasmine.createSpy('prefs.update').and.callFake((patch: Partial<UserPreferences>) => {
      Object.assign(prefsSignal, patch);
    });

    TestBed.configureTestingModule({
      providers: [
        QuotaNotificationService,
        { provide: MatSnackBar, useValue: { open: snackOpen } },
        { provide: MatDialog, useValue: { open: dialogOpen } },
        {
          provide: PreferencesService,
          useValue: {
            prefs: () => prefsSignal,
            update: prefsUpdate
          }
        }
      ]
    });
    service = TestBed.inject(QuotaNotificationService);
  });

  describe('notifyAutoDeleted', () => {
    it('shows a snackbar using the blob title when available', async () => {
      dialogOpen.and.returnValue({ afterClosed: () => of('keep_auto') });
      await service.notifyAutoDeleted({ id: 'x', slug: 's1', title: 'My Notes' });
      expect(snackOpen).toHaveBeenCalled();
      const [message] = snackOpen.calls.mostRecent().args;
      expect(message).toContain('My Notes');
    });

    it('falls back to slug when title is missing or blank', async () => {
      dialogOpen.and.returnValue({ afterClosed: () => of('keep_auto') });
      await service.notifyAutoDeleted({ id: 'x', slug: 'slug42', title: '   ' });
      const [message] = snackOpen.calls.mostRecent().args;
      expect(message).toContain('slug42');
    });

    it('opens the first-time modal and flips seenBlobQuotaModal=true', async () => {
      dialogOpen.and.returnValue({ afterClosed: () => of('keep_auto') });
      await service.notifyAutoDeleted({ id: 'x', slug: 's' });
      expect(dialogOpen).toHaveBeenCalledWith(
        QuotaFirstTimeDialogComponent,
        jasmine.any(Object)
      );
      expect(prefsUpdate).toHaveBeenCalledWith({ seenBlobQuotaModal: true });
    });

    it('switches the user to manual strategy when they opt out', async () => {
      dialogOpen.and.returnValue({ afterClosed: () => of('switch_to_manual') });
      await service.notifyAutoDeleted({ id: 'x', slug: 's' });
      expect(prefsUpdate).toHaveBeenCalledWith({ blobQuotaStrategy: 'manual' });
    });

    it('skips the modal when the user has already seen it', async () => {
      prefsSignal.seenBlobQuotaModal = true;
      await service.notifyAutoDeleted({ id: 'x', slug: 's' });
      expect(dialogOpen).not.toHaveBeenCalled();
      expect(prefsUpdate).not.toHaveBeenCalled();
    });
  });

  describe('notifyQuotaExceededManual', () => {
    it('opens the manual-full dialog and does not change prefs on dismiss', async () => {
      dialogOpen.and.returnValue({ afterClosed: () => of('dismiss') });
      await service.notifyQuotaExceededManual();
      expect(dialogOpen).toHaveBeenCalledWith(
        QuotaManualFullDialogComponent,
        jasmine.any(Object)
      );
      expect(prefsUpdate).not.toHaveBeenCalled();
    });

    it('flips the user back to auto_fifo when they opt in', async () => {
      dialogOpen.and.returnValue({ afterClosed: () => of('switch_to_auto') });
      await service.notifyQuotaExceededManual();
      expect(prefsUpdate).toHaveBeenCalledWith({
        blobQuotaStrategy: 'auto_fifo',
        seenBlobQuotaModal: true
      });
    });
  });
});
