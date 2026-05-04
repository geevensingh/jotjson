import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { of, throwError } from 'rxjs';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { BlobsComponent } from './blobs.component';
import { BlobService } from '../../core/api/blob.service';
import { provideFakeAuth } from '../../../testing/auth.testing';
import type { JsonBlob } from '../../core/api/models';

/**
 * Wave 3a (M7g-3a) shell-landmark spec for the /blobs route. Asserts the
 * skip-link contract: every route must expose `<main id="main-content">`
 * so the app-header skip-link is functional everywhere.
 *
 * **Full axe scan deferred** to the contrast / forms fix wave (M7g-3d /
 * M7g-3e). The route currently has pre-existing colour-contrast
 * violations on disabled-text shades that fail strict WCAG 2.1 AA; those
 * land with their own remediation per the plan's "specs go strict
 * route-by-route as they are remediated" rule.
 */
describe('BlobsComponent (a11y shell landmarks)', () => {
  function blob(overrides: Partial<JsonBlob> = {}): JsonBlob {
    return {
      id: 'b1',
      slug: 'slug1',
      content: '{}',
      ownerId: 'u1',
      isPublic: false,
      version: 1,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      ...overrides,
    };
  }

  function configure(listResult: JsonBlob[] | Error): void {
    const stub = {
      list: jasmine
        .createSpy('list')
        .and.callFake(() =>
          listResult instanceof Error ? throwError(() => listResult) : of(listResult),
        ),
      delete: jasmine.createSpy('delete'),
      get: jasmine.createSpy('get'),
      create: jasmine.createSpy('create'),
      update: jasmine.createSpy('update'),
    };
    const dialog = {
      open: jasmine.createSpy('open').and.returnValue({ afterClosed: () => of(false) }),
    };
    const snack = { open: jasmine.createSpy('open') };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [BlobsComponent],
      providers: [
        ...provideFakeAuth(),
        provideRouter([]),
        provideNoopAnimations(),
        { provide: BlobService, useValue: stub },
        { provide: MatDialog, useValue: dialog },
        { provide: MatSnackBar, useValue: snack },
      ],
    });
  }

  it('renders <main id="main-content"> with tabindex="-1" so the skip-link can focus it', () => {
    configure([blob()]);
    const fixture = TestBed.createComponent(BlobsComponent);
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
    configure([blob()]);
    const fixture = TestBed.createComponent(BlobsComponent);
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
