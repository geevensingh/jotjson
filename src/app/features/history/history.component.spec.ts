import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { HistoryComponent } from './history.component';
import { HistoryService, HistoryPage } from '../../core/api/history.service';
import { provideFakeAuth } from '../../../testing/auth.testing';
import type { HistoryEntry } from '../../core/api/models';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'h1',
    userId: 'u1',
    blobId: 'b1',
    slug: 'slug1',
    title: 'My Blob',
    accessedAt: '2024-01-01T00:00:00Z',
    action: 'saved',
    ...overrides
  };
}

interface SetupOpts {
  listResult?: HistoryPage | Error;
  listSecondResult?: HistoryPage | Error;
  clearResult?: void | Error;
  confirm?: boolean;
}

function setup(opts: SetupOpts = {}) {
  TestBed.resetTestingModule();

  let listCalls = 0;
  const stub = {
    list: jasmine.createSpy('list').and.callFake(() => {
      listCalls += 1;
      const result =
        listCalls === 1 ? opts.listResult : opts.listSecondResult ?? opts.listResult;
      return result instanceof Error
        ? throwError(() => result)
        : of(result ?? { entries: [] });
    }),
    clear: jasmine.createSpy('clear').and.callFake(() =>
      opts.clearResult instanceof Error
        ? throwError(() => opts.clearResult as Error)
        : of(undefined)
    ),
    recordPaste: jasmine.createSpy('recordPaste').and.returnValue(of(null))
  };
  const dialogRef = { afterClosed: () => of(!!opts.confirm) };
  const dialog = { open: jasmine.createSpy('open').and.returnValue(dialogRef) };
  const snack = { open: jasmine.createSpy('open') };

  TestBed.configureTestingModule({
    imports: [HistoryComponent],
    providers: [
      ...provideFakeAuth(),
      provideRouter([]),
      { provide: HistoryService, useValue: stub },
      { provide: MatDialog, useValue: dialog },
      { provide: MatSnackBar, useValue: snack }
    ]
  });

  const fixture = TestBed.createComponent(HistoryComponent);
  return { fixture, stub, dialog, snack };
}

describe('HistoryComponent', () => {
  it('ngOnInit loads the first page and marks state ready', async () => {
    const { fixture, stub } = setup({
      listResult: { entries: [entry()] }
    });
    await fixture.componentInstance.reload();
    expect(stub.list).toHaveBeenCalledWith({ pageSize: 50 });
    expect(fixture.componentInstance.state()).toBe('ready');
    expect(fixture.componentInstance.entries().length).toBe(1);
  });

  it('shows empty state when the server returns no entries', async () => {
    const { fixture } = setup({ listResult: { entries: [] } });
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

  it('groups entries into Today/Yesterday/older buckets in the local timezone', async () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const older = new Date(now);
    older.setDate(older.getDate() - 5);

    const { fixture } = setup({
      listResult: {
        entries: [
          entry({ id: 'a', accessedAt: now.toISOString() }),
          entry({ id: 'b', accessedAt: yesterday.toISOString() }),
          entry({ id: 'c', accessedAt: older.toISOString() })
        ]
      }
    });
    await fixture.componentInstance.reload();
    const groups = fixture.componentInstance.dayGroups();
    expect(groups.length).toBe(3);
    expect(groups[0].label).toBe('Today');
    expect(groups[1].label).toBe('Yesterday');
    // Third group should be a locale-formatted date, not Today/Yesterday.
    expect(['Today', 'Yesterday']).not.toContain(groups[2].label);
  });

  it('exposes hasMore when the server returns a continuation token', async () => {
    const { fixture } = setup({
      listResult: { entries: [entry()], continuationToken: 'abc' }
    });
    await fixture.componentInstance.reload();
    expect(fixture.componentInstance.hasMore()).toBe(true);
  });

  it('loadMore appends the next page using the continuation token', async () => {
    const { fixture, stub } = setup({
      listResult: { entries: [entry({ id: 'a' })], continuationToken: 'tok' },
      listSecondResult: { entries: [entry({ id: 'b' })] }
    });
    await fixture.componentInstance.reload();
    await fixture.componentInstance.loadMore();
    expect(stub.list).toHaveBeenCalledWith({
      pageSize: 50,
      continuationToken: 'tok'
    });
    expect(fixture.componentInstance.entries().map((e) => e.id)).toEqual(['a', 'b']);
    expect(fixture.componentInstance.hasMore()).toBe(false);
  });

  it('loadMore is a no-op without a continuation token', async () => {
    const { fixture, stub } = setup({ listResult: { entries: [entry()] } });
    await fixture.componentInstance.reload();
    stub.list.calls.reset();
    await fixture.componentInstance.loadMore();
    expect(stub.list).not.toHaveBeenCalled();
  });

  it('clearHistory clears entries when confirmed', async () => {
    const { fixture, stub, dialog, snack } = setup({
      listResult: { entries: [entry()] },
      confirm: true
    });
    await fixture.componentInstance.reload();
    await fixture.componentInstance.clearHistory();
    expect(dialog.open).toHaveBeenCalled();
    expect(stub.clear).toHaveBeenCalled();
    expect(fixture.componentInstance.entries().length).toBe(0);
    expect(snack.open).toHaveBeenCalled();
  });

  it('clearHistory is a no-op when cancelled', async () => {
    const { fixture, stub } = setup({
      listResult: { entries: [entry()] },
      confirm: false
    });
    await fixture.componentInstance.reload();
    await fixture.componentInstance.clearHistory();
    expect(stub.clear).not.toHaveBeenCalled();
    expect(fixture.componentInstance.entries().length).toBe(1);
  });

  it('clearHistory toasts on failure and leaves entries intact', async () => {
    const { fixture, snack } = setup({
      listResult: { entries: [entry()] },
      confirm: true,
      clearResult: new Error('boom')
    });
    spyOn(console, 'warn');
    await fixture.componentInstance.reload();
    await fixture.componentInstance.clearHistory();
    expect(fixture.componentInstance.entries().length).toBe(1);
    expect(snack.open).toHaveBeenCalled();
  });

  it('openEntry navigates to /s/:slug for entries with a slug', async () => {
    const { fixture } = setup();
    const router = TestBed.inject(Router);
    const spy = spyOn(router, 'navigate').and.resolveTo(true);
    fixture.componentInstance.openEntry(entry({ slug: 'abc' }));
    expect(spy).toHaveBeenCalledWith(['/s', 'abc']);
  });

  it('openEntry is a no-op for deleted entries', () => {
    const { fixture } = setup();
    const router = TestBed.inject(Router);
    const spy = spyOn(router, 'navigate').and.resolveTo(true);
    fixture.componentInstance.openEntry(entry({ slug: 'abc', action: 'deleted' }));
    expect(spy).not.toHaveBeenCalled();
  });

  it('openEntry is a no-op when slug is missing', () => {
    const { fixture } = setup();
    const router = TestBed.inject(Router);
    const spy = spyOn(router, 'navigate').and.resolveTo(true);
    fixture.componentInstance.openEntry(entry({ slug: undefined, action: 'pasted' }));
    expect(spy).not.toHaveBeenCalled();
  });

  it('hasLink is true only for non-deleted entries with a slug', () => {
    const { fixture } = setup();
    const c = fixture.componentInstance;
    expect(c.hasLink(entry({ slug: 'abc', action: 'saved' }))).toBe(true);
    expect(c.hasLink(entry({ slug: 'abc', action: 'deleted' }))).toBe(false);
    expect(c.hasLink(entry({ slug: undefined, action: 'pasted' }))).toBe(false);
  });

  it('displayLabel prefers title, then slug, then "(deleted blob)"', () => {
    const { fixture } = setup();
    const c = fixture.componentInstance;
    expect(c.displayLabel(entry({ title: 'Hi' }))).toBe('Hi');
    expect(c.displayLabel(entry({ title: '  ', slug: 'abc' }))).toBe('/s/abc');
    expect(c.displayLabel(entry({ title: undefined, slug: undefined }))).toBe(
      '(deleted blob)'
    );
  });

  it('iconFor maps every action to a JjIconName', () => {
    const { fixture } = setup();
    const c = fixture.componentInstance;
    expect(c.iconFor('saved')).toBe('save');
    expect(c.iconFor('edited')).toBe('edit');
    expect(c.iconFor('deleted')).toBe('trash');
    expect(c.iconFor('viewed')).toBe('eye');
    expect(c.iconFor('pasted')).toBe('paste');
  });

  it('actionLabel returns localized copy for every action', () => {
    const { fixture } = setup();
    const c = fixture.componentInstance;
    expect(c.actionLabel('saved')).toBe('Saved');
    expect(c.actionLabel('edited')).toBe('Edited');
    expect(c.actionLabel('deleted')).toBe('Deleted');
    expect(c.actionLabel('viewed')).toBe('Viewed');
    expect(c.actionLabel('pasted')).toBe('Pasted');
  });

  it('applySearchTerm updates the search term and reloads with q', async () => {
    const { fixture, stub } = setup({ listResult: { entries: [entry()] } });
    await fixture.componentInstance.reload();
    stub.list.calls.reset();
    fixture.componentInstance.applySearchTerm('  Auth  ');
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.componentInstance.searchTerm()).toBe('Auth');
    expect(stub.list).toHaveBeenCalledWith({ pageSize: 50, q: 'Auth' });
  });

  it('applySearchTerm is a no-op when the trimmed term is unchanged', async () => {
    const { fixture, stub } = setup({ listResult: { entries: [entry()] } });
    await fixture.componentInstance.reload();
    fixture.componentInstance.applySearchTerm('foo');
    await Promise.resolve();
    await Promise.resolve();
    stub.list.calls.reset();
    fixture.componentInstance.applySearchTerm('  foo  ');
    await Promise.resolve();
    expect(stub.list).not.toHaveBeenCalled();
  });

  it('onSearchInput pipes through a 300ms debounce', fakeAsync(() => {
    const { fixture, stub } = setup({ listResult: { entries: [entry()] } });
    fixture.componentInstance.reload();
    tick();
    stub.list.calls.reset();

    fixture.componentInstance.onSearchInput('foo');
    tick(299);
    expect(stub.list).not.toHaveBeenCalled();
    tick(2);
    expect(stub.list).toHaveBeenCalledWith({ pageSize: 50, q: 'foo' });
  }));

  it('clearSearch resets the search term and reloads immediately', async () => {
    const { fixture, stub } = setup({ listResult: { entries: [entry()] } });
    await fixture.componentInstance.reload();
    fixture.componentInstance.applySearchTerm('foo');
    await Promise.resolve();
    await Promise.resolve();
    stub.list.calls.reset();

    fixture.componentInstance.clearSearch();
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.componentInstance.searchTerm()).toBe('');
    expect(stub.list).toHaveBeenCalledWith({ pageSize: 50 });
  });

  it('loadMore forwards the active search term as q', async () => {
    const { fixture, stub } = setup({
      listResult: { entries: [entry({ id: 'a' })], continuationToken: 'tok' }
    });
    await fixture.componentInstance.reload();
    fixture.componentInstance.applySearchTerm('foo');
    await Promise.resolve();
    await Promise.resolve();
    stub.list.calls.reset();
    stub.list.and.returnValue(of({ entries: [entry({ id: 'b' })] }));
    await fixture.componentInstance.loadMore();
    expect(stub.list).toHaveBeenCalledWith({
      pageSize: 50,
      continuationToken: 'tok',
      q: 'foo'
    });
  });

  it('hasActiveFilters reflects the trimmed search term', () => {
    const { fixture } = setup();
    const c = fixture.componentInstance;
    expect(c.hasActiveFilters()).toBe(false);
    c.searchTerm.set('foo');
    expect(c.hasActiveFilters()).toBe(true);
    c.searchTerm.set('   ');
    expect(c.hasActiveFilters()).toBe(false);
  });
});
