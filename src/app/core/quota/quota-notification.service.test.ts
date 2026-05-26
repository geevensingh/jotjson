import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { of } from 'rxjs';
import { type MockInstance } from 'vitest';
import type { UserPreferences } from '../api/models';
import { PreferencesService } from '../preferences/preferences.service';
import {
  QuotaFirstTimeDialogComponent,
  QuotaManualFullDialogComponent,
  QuotaNotificationService,
} from './quota-notification.service';

function appendMainFallback(): HTMLElement {
  const main = document.createElement('main');
  main.id = 'main-content';
  main.tabIndex = -1;
  document.body.appendChild(main);
  return main;
}

describe('QuotaNotificationService', () => {
  let service: QuotaNotificationService;
  let snackOpen: MockInstance;
  let dialogOpen: MockInstance;
  let prefsUpdate: MockInstance;
  let prefsSignal: UserPreferences;

  beforeEach(() => {
    prefsSignal = {
      seenBlobQuotaModal: false,
      blobQuotaStrategy: 'auto_fifo',
    } as unknown as UserPreferences;

    snackOpen = vi.fn();
    dialogOpen = vi.fn();
    prefsUpdate = vi.fn().mockImplementation((patch: Partial<UserPreferences>) => {
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
            update: prefsUpdate,
          },
        },
      ],
    });
    service = TestBed.inject(QuotaNotificationService);
  });

  describe('notifyAutoDeleted', () => {
    it('shows a snackbar using the blob title when available', async () => {
      dialogOpen.mockReturnValue({ afterClosed: () => of('keep_auto') });
      await service.notifyAutoDeleted({ id: 'x', slug: 's1', title: 'My Notes' });
      expect(snackOpen).toHaveBeenCalled();
      const [message] = snackOpen.mock.lastCall;
      expect(message).toContain('My Notes');
    });

    it('falls back to slug when title is missing or blank', async () => {
      dialogOpen.mockReturnValue({ afterClosed: () => of('keep_auto') });
      await service.notifyAutoDeleted({ id: 'x', slug: 'slug42', title: '   ' });
      const [message] = snackOpen.mock.lastCall;
      expect(message).toContain('slug42');
    });

    it('opens the first-time modal and flips seenBlobQuotaModal=true', async () => {
      dialogOpen.mockReturnValue({ afterClosed: () => of('keep_auto') });
      await service.notifyAutoDeleted({ id: 'x', slug: 's' });
      expect(dialogOpen).toHaveBeenCalledWith(QuotaFirstTimeDialogComponent, expect.any(Object));
      expect(prefsUpdate).toHaveBeenCalledWith({ seenBlobQuotaModal: true });
    });

    it('switches the user to manual strategy when they opt out', async () => {
      dialogOpen.mockReturnValue({ afterClosed: () => of('switch_to_manual') });
      await service.notifyAutoDeleted({ id: 'x', slug: 's' });
      expect(prefsUpdate).toHaveBeenCalledWith({ blobQuotaStrategy: 'manual' });
    });

    it('focuses main content after the first-time dialog closes without a trigger', async () => {
      const main = appendMainFallback();
      try {
        dialogOpen.mockReturnValue({ afterClosed: () => of('keep_auto') });
        document.body.focus();
        await service.notifyAutoDeleted({ id: 'x', slug: 's' });
        expect(document.activeElement).toBe(main);
      } finally {
        main.remove();
      }
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
      dialogOpen.mockReturnValue({ afterClosed: () => of('dismiss') });
      await service.notifyQuotaExceededManual();
      expect(dialogOpen).toHaveBeenCalledWith(QuotaManualFullDialogComponent, expect.any(Object));
      expect(prefsUpdate).not.toHaveBeenCalled();
    });

    it('flips the user back to auto_fifo when they opt in', async () => {
      dialogOpen.mockReturnValue({ afterClosed: () => of('switch_to_auto') });
      await service.notifyQuotaExceededManual();
      expect(prefsUpdate).toHaveBeenCalledWith({
        blobQuotaStrategy: 'auto_fifo',
        seenBlobQuotaModal: true,
      });
    });

    it('focuses main content after the manual-full dialog closes without a trigger', async () => {
      const main = appendMainFallback();
      try {
        dialogOpen.mockReturnValue({ afterClosed: () => of('dismiss') });
        document.body.focus();
        await service.notifyQuotaExceededManual();
        expect(document.activeElement).toBe(main);
      } finally {
        main.remove();
      }
    });
  });
});
