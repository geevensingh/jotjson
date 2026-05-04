import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { of, throwError } from 'rxjs';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { HistoryComponent } from './history.component';
import { HistoryService, HistoryPage } from '../../core/api/history.service';
import { provideFakeAuth } from '../../../testing/auth.testing';
import { LoggerService } from '../../core/telemetry/logger.service';

/**
 * Wave 3a (M7g-3a) shell-landmark spec for the /history route. Asserts
 * the skip-link contract: every route must expose
 * `<main id="main-content">` so the app-header skip-link is functional
 * everywhere.
 *
 * Full axe scan deferred to the contrast / forms fix wave per the plan's
 * "specs go strict route-by-route as they are remediated" rule.
 */
describe('HistoryComponent (a11y shell landmarks)', () => {
  function configure(listResult: HistoryPage | Error): void {
    const stub = {
      list: jasmine
        .createSpy('list')
        .and.callFake(() =>
          listResult instanceof Error
            ? throwError(() => listResult)
            : of(listResult satisfies HistoryPage),
        ),
      clear: jasmine.createSpy('clear').and.returnValue(of(undefined)),
    };
    const dialog = {
      open: jasmine.createSpy('open').and.returnValue({ afterClosed: () => of(false) }),
    };
    const snack = { open: jasmine.createSpy('open') };
    const logger = jasmine.createSpyObj<LoggerService>('LoggerService', ['event', 'warn']);

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

  it('renders <main id="main-content"> with tabindex="-1" so the skip-link can focus it', () => {
    configure({ entries: [] });
    const fixture = TestBed.createComponent(HistoryComponent);
    fixture.detectChanges();
    const main = fixture.nativeElement.querySelector('main#main-content') as HTMLElement | null;
    expect(main)
      .withContext('every route must expose <main id="main-content"> for the app-header skip-link')
      .not.toBeNull();
    expect(main?.getAttribute('tabindex'))
      .withContext('non-interactive <main> needs tabindex="-1" so RouteFocusService can focus it')
      .toBe('-1');
  });

  it('renders an <h1> inside <main> for screen-reader page identification', () => {
    configure({ entries: [] });
    const fixture = TestBed.createComponent(HistoryComponent);
    fixture.detectChanges();
    const heading = fixture.nativeElement.querySelector(
      'main#main-content h1',
    ) as HTMLElement | null;
    expect(heading)
      .withContext('every route should expose a top-level <h1> for SR page identification')
      .not.toBeNull();
    expect(heading?.textContent?.trim().length)
      .withContext('the <h1> must have non-empty content')
      .toBeGreaterThan(0);
  });
});
