import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideNoopAnimations } from '@angular/platform-browser/animations';

import {
  attachFixtureToBody,
  expectNoStrictA11yViolations,
  getOverlayContainerElement,
} from '../../../testing/a11y';
import type { UserPreferences } from '../api/models';
import { PreferencesService } from '../preferences/preferences.service';
import { QuotaNotificationService } from './quota-notification.service';

@Component({
  standalone: true,
  template: `<main id="main-content" tabindex="-1">Quota host</main>`,
})
class QuotaDialogHostComponent {}

describe('QuotaNotificationService (a11y overlays)', () => {
  let teardown: (() => void) | undefined;
  let service: QuotaNotificationService;
  let prefsSignal: UserPreferences;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    prefsSignal = {
      seenBlobQuotaModal: false,
      blobQuotaStrategy: 'auto_fifo',
    } as unknown as UserPreferences;

    await TestBed.configureTestingModule({
      imports: [QuotaDialogHostComponent, MatDialogModule],
      providers: [
        provideNoopAnimations(),
        QuotaNotificationService,
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        {
          provide: PreferencesService,
          useValue: {
            prefs: () => prefsSignal,
            update: (patch: Partial<UserPreferences>) => Object.assign(prefsSignal, patch),
          },
        },
      ],
    }).compileComponents();
    service = TestBed.inject(QuotaNotificationService);
  });

  afterEach(() => {
    TestBed.inject(MatDialog).closeAll();
    teardown?.();
    teardown = undefined;
  });

  it('has no critical or serious violations with the first-time quota dialog open', async () => {
    const fixture = TestBed.createComponent(QuotaDialogHostComponent);
    teardown = attachFixtureToBody(fixture);
    fixture.detectChanges();

    const pending = service.notifyAutoDeleted({
      id: 'old-1',
      slug: 'oldslug',
      title: 'Old config',
    });
    await fixture.whenStable();

    await expectNoStrictA11yViolations(fixture, {
      target: getOverlayContainerElement(),
    });

    findDialogButton('OK, got it').click();
    await pending;
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.closest('.mat-mdc-dialog-container')).toBeNull();
  });

  it('has no critical or serious violations with the manual-full quota dialog open', async () => {
    const fixture = TestBed.createComponent(QuotaDialogHostComponent);
    teardown = attachFixtureToBody(fixture);
    fixture.detectChanges();

    const pending = service.notifyQuotaExceededManual();
    await fixture.whenStable();

    await expectNoStrictA11yViolations(fixture, {
      target: getOverlayContainerElement(),
    });

    findDialogButton('OK').click();
    await pending;
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.closest('.mat-mdc-dialog-container')).toBeNull();
  });
});

function findDialogButton(label: string): HTMLButtonElement {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.mat-mdc-dialog-container button'),
  ).find((candidate) => candidate.textContent?.trim() === label);
  expect(button).not.toBeNull();
  if (!button) {
    throw new Error(`Expected dialog button "${label}".`);
  }
  return button;
}
