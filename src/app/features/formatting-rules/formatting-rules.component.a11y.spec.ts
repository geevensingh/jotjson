import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { FormattingRulesComponent } from './formatting-rules.component';
import { RuleSetsService } from '../../core/api/rule-sets.service';
import { PreferencesService } from '../../core/preferences/preferences.service';
import { provideFakeAuth } from '../../../testing/auth.testing';
import type { FormattingRuleSet } from '../../core/api/models';

/**
 * Wave 3a (M7g-3a) shell-landmark spec for the /formatting-rules route.
 * Full axe scan deferred to a later fix wave.
 */
describe('FormattingRulesComponent (a11y shell landmarks)', () => {
  function configure(listResult: FormattingRuleSet[] | Error): void {
    const cache = signal<FormattingRuleSet[] | null>(
      listResult instanceof Error ? null : listResult,
    );
    const defaults = signal<string[]>([]);
    const stub = {
      ruleSets: cache.asReadonly(),
      activeRuleSetIds: defaults.asReadonly(),
      list: jasmine
        .createSpy('list')
        .and.callFake(() =>
          listResult instanceof Error ? throwError(() => listResult) : of(listResult),
        ),
      create: jasmine.createSpy('create'),
      update: jasmine.createSpy('update'),
      delete: jasmine.createSpy('delete'),
      get: jasmine.createSpy('get'),
      refresh: jasmine.createSpy('refresh'),
      toggleActive: jasmine.createSpy('toggleActive'),
    };
    const prefsSig = signal<{ activeRuleSetIds: string[] }>({ activeRuleSetIds: [] });
    const syncStateSig = signal<'synced'>('synced');
    const preferences = {
      prefs: prefsSig.asReadonly(),
      syncState: syncStateSig.asReadonly(),
      update: jasmine.createSpy('preferences.update'),
    };
    const dialog = {
      open: jasmine.createSpy('open').and.returnValue({ afterClosed: () => of(undefined) }),
    };
    const snack = { open: jasmine.createSpy('open') };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [FormattingRulesComponent],
      providers: [
        ...provideFakeAuth(),
        provideRouter([]),
        provideNoopAnimations(),
        { provide: RuleSetsService, useValue: stub },
        { provide: PreferencesService, useValue: preferences },
        { provide: MatDialog, useValue: dialog },
        { provide: MatSnackBar, useValue: snack },
      ],
    });
  }

  it('renders <main id="main-content"> with tabindex="-1" so the skip-link can focus it', () => {
    configure([]);
    const fixture = TestBed.createComponent(FormattingRulesComponent);
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
    configure([]);
    const fixture = TestBed.createComponent(FormattingRulesComponent);
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
