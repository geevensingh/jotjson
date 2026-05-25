import { TestBed } from '@angular/core/testing';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { type Mocked } from 'vitest';
import {
  attachFixtureToBody,
  expectNoStrictA11yViolations,
  getOverlayContainerElement,
} from '../../../testing/a11y';
import { provideFakeAuth } from '../../../testing/auth.testing';
import { HistoryPage, HistoryService } from '../../core/api/history.service';
import type { HistoryEntry } from '../../core/api/models';
import { LoggerService } from '../../core/telemetry/logger.service';
import { HistoryComponent } from './history.component';

/**
 * Wave 3a (M7g-3a) shell-landmark spec for the /history route. Asserts
 * the skip-link contract: every route must expose
 * `<main id="main-content">` so the app-header skip-link is functional
 * everywhere.
 *
 * Route-level axe coverage remains deferred to the contrast / forms fix
 * waves. Wave 3e adds a strict overlay scan for the clear-history dialog.
 */
describe('HistoryComponent (a11y shell landmarks)', () => {
  let teardown: (() => void) | undefined;

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
    return {
      id: 'entry-1',
      userId: 'user-1',
      blobId: 'blob-1',
      slug: 'abc123',
      title: 'Saved config',
      accessedAt: '2024-01-01T00:00:00Z',
      action: 'viewed',
      ...overrides,
    };
  }

  function configure(listResult: HistoryPage | Error): void {
    const stub = {
      list: jasmine
        .createSpy('list')
        .mockImplementation(() =>
          listResult instanceof Error
            ? throwError(() => listResult)
            : of(listResult satisfies HistoryPage),
        ),
      clear: vi.fn().mockReturnValue(of(undefined)),
    };
    const dialog = {
      open: vi.fn().mockReturnValue({ afterClosed: () => of(false) }),
    };
    const snack = { open: vi.fn() };
    const logger = { event: vi.fn(), warn: vi.fn() } as Mocked<LoggerService>;

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HistoryComponent],
      providers: [
        ...provideFakeAuth(),
        provideRouter([]),
        provideNoopAnimations(),
        { provide: HistoryService, useValue: stub },
        { provide: MatDialog, useValue: dialog },
        { provide: MatSnackBar, useValue: snack },
        { provide: LoggerService, useValue: logger },
      ],
    });
  }

  function configureOverlay(listResult: HistoryPage): void {
    const stub = {
      list: vi.fn().mockReturnValue(of(listResult)),
      clear: vi.fn().mockReturnValue(of(undefined)),
    };
    const snack = { open: vi.fn() };
    const logger = { event: vi.fn(), warn: vi.fn() } as Mocked<LoggerService>;

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HistoryComponent, MatDialogModule],
      providers: [
        ...provideFakeAuth(),
        provideRouter([]),
        provideNoopAnimations(),
        { provide: HistoryService, useValue: stub },
        { provide: MatSnackBar, useValue: snack },
        { provide: LoggerService, useValue: logger },
      ],
    });
  }

  it('renders <main id="main-content"> with tabindex="-1" so the skip-link can focus it', () => {
    configure({ entries: [] });
    const fixture = TestBed.createComponent(HistoryComponent);
    fixture.detectChanges();
    const main = fixture.nativeElement.querySelector('main#main-content') as HTMLElement | null;
    expect(
      main,
      'every route must expose <main id="main-content"> for the app-header skip-link',
    ).not.toBeNull();
    expect(
      main?.getAttribute('tabindex'),
      'non-interactive <main> needs tabindex="-1" so RouteFocusService can focus it',
    ).toBe('-1');
  });

  it('renders an <h1> inside <main> for screen-reader page identification', () => {
    configure({ entries: [] });
    const fixture = TestBed.createComponent(HistoryComponent);
    fixture.detectChanges();
    const heading = fixture.nativeElement.querySelector(
      'main#main-content h1',
    ) as HTMLElement | null;
    expect(
      heading,
      'every route should expose a top-level <h1> for SR page identification',
    ).not.toBeNull();
    expect(
      heading?.textContent?.trim().length,
      'the <h1> must have non-empty content',
    ).toBeGreaterThan(0);
  });

  it('has no critical or serious violations with the clear-history confirmation open', async () => {
    configureOverlay({ entries: [entry()] });
    const fixture = TestBed.createComponent(HistoryComponent);
    teardown = attachFixtureToBody(fixture);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const clearButton = fixture.nativeElement.querySelector('.clear-button') as HTMLButtonElement;
    clearButton.click();
    fixture.detectChanges();
    await fixture.whenStable();

    await expectNoStrictA11yViolations(fixture, {
      target: getOverlayContainerElement(),
    });

    TestBed.inject(MatDialog).closeAll();
  });
});
