import { TestBed } from '@angular/core/testing';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import {
  attachFixtureToBody,
  expectNoStrictA11yViolations,
  getOverlayContainerElement,
} from '../../../testing/a11y';
import { provideFakeAuth } from '../../../testing/auth.testing';
import { BlobService } from '../../core/api/blob.service';
import type { JsonBlob } from '../../core/api/models';
import { BlobsComponent } from './blobs.component';

/**
 * Wave 3a (M7g-3a) shell-landmark spec for the /blobs route. Asserts the
 * skip-link contract: every route must expose `<main id="main-content">`
 * so the app-header skip-link is functional everywhere.
 *
 * Route-level axe coverage remains deferred to the contrast / forms fix
 * waves. Wave 3e adds a strict overlay scan for the delete-confirm dialog.
 */
describe('BlobsComponent (a11y shell landmarks)', () => {
  let teardown: (() => void) | undefined;

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

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

  function configureOverlay(listResult: JsonBlob[]): void {
    const stub = {
      list: jasmine.createSpy('list').and.returnValue(of(listResult)),
      delete: jasmine.createSpy('delete').and.returnValue(of(undefined)),
      get: jasmine.createSpy('get'),
      create: jasmine.createSpy('create'),
      update: jasmine.createSpy('update'),
    };
    const snack = { open: jasmine.createSpy('open') };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [BlobsComponent, MatDialogModule],
      providers: [
        ...provideFakeAuth(),
        provideRouter([]),
        provideNoopAnimations(),
        { provide: BlobService, useValue: stub },
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

  it('has no critical or serious violations with the delete confirmation open', async () => {
    configureOverlay([blob({ title: 'Saved config' })]);
    const fixture = TestBed.createComponent(BlobsComponent);
    teardown = attachFixtureToBody(fixture);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const deleteButton = fixture.nativeElement.querySelector('.blob-delete') as HTMLButtonElement;
    deleteButton.click();
    fixture.detectChanges();
    await fixture.whenStable();

    await expectNoStrictA11yViolations(fixture, {
      target: getOverlayContainerElement(),
    });

    TestBed.inject(MatDialog).closeAll();
  });
});
