import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { BlobsComponent } from './blobs.component';
import { BlobService } from '../../core/api/blob.service';
import { provideFakeAuth } from '../../../testing/auth.testing';
import type { JsonBlob } from '../../core/api/models';

function blob(overrides: Partial<JsonBlob> = {}): JsonBlob {
  return {
    id: 'b1',
    slug: 'slug1',
    content: '{}',
    ownerId: 'u1',
    isPublic: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

interface SetupOpts {
  listResult?: JsonBlob[] | Error;
  deleteResult?: void | Error;
  confirm?: boolean;
}

function setup(opts: SetupOpts = {}) {
  TestBed.resetTestingModule();

  const stub = {
    list: jasmine
      .createSpy('list')
      .and.callFake(() =>
        opts.listResult instanceof Error
          ? throwError(() => opts.listResult as Error)
          : of(opts.listResult ?? []),
      ),
    delete: jasmine
      .createSpy('delete')
      .and.callFake(() =>
        opts.deleteResult instanceof Error
          ? throwError(() => opts.deleteResult as Error)
          : of(undefined),
      ),
    get: jasmine.createSpy('get'),
    create: jasmine.createSpy('create'),
    update: jasmine.createSpy('update'),
  };
  const dialogRef = { afterClosed: () => of(!!opts.confirm) };
  const dialog = { open: jasmine.createSpy('open').and.returnValue(dialogRef) };
  const snack = { open: jasmine.createSpy('open') };

  TestBed.configureTestingModule({
    imports: [BlobsComponent],
    providers: [
      ...provideFakeAuth(),
      provideRouter([]),
      { provide: BlobService, useValue: stub },
      { provide: MatDialog, useValue: dialog },
      { provide: MatSnackBar, useValue: snack },
    ],
  });

  const fixture = TestBed.createComponent(BlobsComponent);
  return { fixture, stub, dialog, snack };
}

describe('BlobsComponent', () => {
  const originalClipboardDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

  function stubClipboard(writeText: jasmine.Spy): void {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  }

  afterEach(() => {
    // Restore whatever was on `navigator.clipboard` before this spec so
    // subsequent suites (e.g. HomeComponent) can re-spyOn it.
    if (originalClipboardDesc) {
      Object.defineProperty(navigator, 'clipboard', originalClipboardDesc);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (navigator as any).clipboard;
    }
  });

  it('ngOnInit loads blobs and marks state ready', async () => {
    const { fixture } = setup({ listResult: [blob()] });
    await fixture.componentInstance.reload();
    expect(fixture.componentInstance.state()).toBe('ready');
    expect(fixture.componentInstance.blobList().length).toBe(1);
  });

  it('sorts blobs by updatedAt descending', async () => {
    const older = blob({ id: 'a', slug: 'a', updatedAt: '2024-01-01T00:00:00Z' });
    const newer = blob({ id: 'b', slug: 'b', updatedAt: '2024-06-01T00:00:00Z' });
    const { fixture } = setup({ listResult: [older, newer] });
    await fixture.componentInstance.reload();
    expect(fixture.componentInstance.blobList()[0].id).toBe('b');
  });

  it('shows empty state when server returns no blobs', async () => {
    const { fixture } = setup({ listResult: [] });
    await fixture.componentInstance.reload();
    expect(fixture.componentInstance.isEmpty()).toBe(true);
  });

  it('marks state error when the list call fails', async () => {
    const { fixture } = setup({ listResult: new Error('boom') });
    spyOn(console, 'warn');
    await fixture.componentInstance.reload();
    expect(fixture.componentInstance.state()).toBe('error');
    expect(fixture.componentInstance.errorMessage()).toBeTruthy();
  });

  it('deleteBlob removes the blob from the list when confirmed', async () => {
    const { fixture, stub, dialog } = setup({
      listResult: [blob({ id: 'b1' }), blob({ id: 'b2', slug: 'slug2' })],
      confirm: true,
    });
    await fixture.componentInstance.reload();
    await fixture.componentInstance.deleteBlob(fixture.componentInstance.blobList()[0]);
    expect(dialog.open).toHaveBeenCalled();
    expect(stub.delete).toHaveBeenCalled();
    expect(fixture.componentInstance.blobList().length).toBe(1);
  });

  it('deleteBlob is a no-op when the user cancels', async () => {
    const { fixture, stub } = setup({
      listResult: [blob()],
      confirm: false,
    });
    await fixture.componentInstance.reload();
    await fixture.componentInstance.deleteBlob(fixture.componentInstance.blobList()[0]);
    expect(stub.delete).not.toHaveBeenCalled();
    expect(fixture.componentInstance.blobList().length).toBe(1);
  });

  it('deleteBlob toasts an error and keeps the row when delete fails', async () => {
    const { fixture, snack } = setup({
      listResult: [blob()],
      confirm: true,
      deleteResult: new Error('x'),
    });
    spyOn(console, 'warn');
    await fixture.componentInstance.reload();
    await fixture.componentInstance.deleteBlob(fixture.componentInstance.blobList()[0]);
    expect(fixture.componentInstance.blobList().length).toBe(1);
    expect(snack.open).toHaveBeenCalled();
  });

  it('openBlob navigates to /s/:slug', async () => {
    const { fixture } = setup();
    const router = TestBed.inject(Router);
    const spy = spyOn(router, 'navigate').and.resolveTo(true);
    fixture.componentInstance.openBlob(blob({ slug: 'abc' }));
    expect(spy).toHaveBeenCalledWith(['/s', 'abc']);
  });

  it('copyLink writes the absolute URL to the clipboard and toasts success', async () => {
    const { fixture, snack } = setup();
    const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
    stubClipboard(writeText);
    await fixture.componentInstance.copyLink(blob({ slug: 'abc' }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/s/abc`);
    expect(snack.open).toHaveBeenCalled();
    const message = (snack.open.calls.mostRecent().args as unknown[])[0];
    expect(message).toBe('Link copied to clipboard');
  });

  it('copyLink toasts a failure message when the clipboard write fails', async () => {
    const { fixture, snack } = setup();
    const writeText = jasmine.createSpy('writeText').and.rejectWith(new Error('denied'));
    stubClipboard(writeText);
    spyOn(console, 'warn');
    await fixture.componentInstance.copyLink(blob({ slug: 'xyz' }));
    expect(snack.open).toHaveBeenCalled();
    const message = (snack.open.calls.mostRecent().args as unknown[])[0];
    expect(message).toBe('Failed to copy link');
  });

  it('copyLink toasts the unsupported message when navigator.clipboard is missing', async () => {
    const { fixture, snack } = setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });
    spyOn(console, 'warn');
    await fixture.componentInstance.copyLink(blob({ slug: 'no-perm' }));
    expect(snack.open).toHaveBeenCalled();
    const message = (snack.open.calls.mostRecent().args as unknown[])[0];
    expect(message).toBe('Copy is not supported in this browser.');
  });

  it('displayTitle falls back to "Untitled" for blank titles', () => {
    const { fixture } = setup();
    expect(fixture.componentInstance.displayTitle(blob({ title: undefined }))).toBe('Untitled');
    expect(fixture.componentInstance.displayTitle(blob({ title: '   ' }))).toBe('Untitled');
    expect(fixture.componentInstance.displayTitle(blob({ title: 'Hello' }))).toBe('Hello');
  });
});
