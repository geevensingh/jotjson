import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { type Mocked } from 'vitest';
import { provideFakeAuth } from '../../../testing/auth.testing';
import { HistoryPage, HistoryService } from '../../core/api/history.service';
import type { HistoryEntry } from '../../core/api/models';
import { LoggerService } from '../../core/telemetry/logger.service';
import { HistoryComponent } from './history.component';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'h1',
    userId: 'u1',
    blobId: 'b1',
    slug: 'slug1',
    title: 'My Blob',
    accessedAt: '2024-01-01T00:00:00Z',
    action: 'viewed',
    ...overrides,
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
    list: vi.fn().mockImplementation(() => {
      listCalls += 1;
      const result = listCalls === 1 ? opts.listResult : (opts.listSecondResult ?? opts.listResult);
      return result instanceof Error ? throwError(() => result) : of(result ?? { entries: [] });
    }),
    clear: vi
      .fn()
      .mockImplementation(() =>
        opts.clearResult instanceof Error
          ? throwError(() => opts.clearResult as Error)
          : of(undefined),
      ),
  };
  const dialogRef = { afterClosed: () => of(!!opts.confirm) };
  const dialog = { open: vi.fn().mockReturnValue(dialogRef) };
  const snack = { open: vi.fn() };
  const logger = { event: vi.fn(), warn: vi.fn() } as unknown as Mocked<LoggerService>;

  TestBed.configureTestingModule({
    imports: [HistoryComponent],
    providers: [
      ...provideFakeAuth(),
      provideRouter([]),
      { provide: HistoryService, useValue: stub },
      { provide: MatDialog, useValue: dialog },
      { provide: MatSnackBar, useValue: snack },
      { provide: LoggerService, useValue: logger },
    ],
  });

  const fixture = TestBed.createComponent(HistoryComponent);
  return { fixture, stub, dialog, snack, logger };
}

function setupWithRealDialog(listResult: HistoryPage) {
  TestBed.resetTestingModule();

  const stub = {
    list: vi.fn().mockReturnValue(of(listResult)),
    clear: vi.fn().mockReturnValue(of(undefined)),
  };
  const snack = { open: vi.fn() };
  const logger = { event: vi.fn(), warn: vi.fn() } as unknown as Mocked<LoggerService>;

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

  const fixture = TestBed.createComponent(HistoryComponent);
  return { fixture, stub };
}

function attachToBody(fixture: ComponentFixture<unknown>): () => void {
  document.body.appendChild(fixture.nativeElement);
  return () => {
    fixture.nativeElement.remove();
  };
}

function waitForTaskQueue(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(() => resolve(), 0));
}

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

describe('HistoryComponent', () => {
  it('ngOnInit loads the first page and marks state ready', async () => {
    const { fixture, stub } = setup({
      listResult: { entries: [entry()] },
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
    vi.spyOn(console, 'warn');
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
          entry({ id: 'c', accessedAt: older.toISOString() }),
        ],
      },
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
      listResult: { entries: [entry()], continuationToken: 'abc' },
    });
    await fixture.componentInstance.reload();
    expect(fixture.componentInstance.hasMore()).toBe(true);
  });

  it('loadMore appends the next page using the continuation token', async () => {
    const { fixture, stub } = setup({
      listResult: { entries: [entry({ id: 'a' })], continuationToken: 'tok' },
      listSecondResult: { entries: [entry({ id: 'b' })] },
    });
    await fixture.componentInstance.reload();
    await fixture.componentInstance.loadMore();
    expect(stub.list).toHaveBeenCalledWith({
      pageSize: 50,
      continuationToken: 'tok',
    });
    expect(fixture.componentInstance.entries().map((e) => e.id)).toEqual(['a', 'b']);
    expect(fixture.componentInstance.hasMore()).toBe(false);
  });

  it('loadMore is a no-op without a continuation token', async () => {
    const { fixture, stub } = setup({ listResult: { entries: [entry()] } });
    await fixture.componentInstance.reload();
    stub.list.mockClear();
    await fixture.componentInstance.loadMore();
    expect(stub.list).not.toHaveBeenCalled();
  });

  it('clearHistory clears entries when confirmed', async () => {
    const { fixture, stub, dialog, snack } = setup({
      listResult: { entries: [entry()] },
      confirm: true,
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
      confirm: false,
    });
    await fixture.componentInstance.reload();
    await fixture.componentInstance.clearHistory();
    expect(stub.clear).not.toHaveBeenCalled();
    expect(fixture.componentInstance.entries().length).toBe(1);
  });

  it('focuses the page fallback after confirming clear history', async () => {
    const { fixture } = setup({
      listResult: { entries: [entry()] },
      confirm: true,
    });
    const teardown = attachToBody(fixture);
    try {
      await fixture.componentInstance.reload();
      fixture.detectChanges();

      await fixture.componentInstance.clearHistory();
      fixture.detectChanges();
      await waitForTaskQueue();
      fixture.detectChanges();

      const main = fixture.nativeElement.querySelector('main.history') as HTMLElement;
      expect(document.activeElement).toBe(main);
    } finally {
      teardown();
    }
  });

  it('returns focus to the clear-history trigger when the dialog cancel button closes', async () => {
    const { fixture, stub } = setupWithRealDialog({ entries: [entry()] });
    const teardown = attachToBody(fixture);
    try {
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      const trigger = fixture.nativeElement.querySelector('.clear-button') as HTMLButtonElement;
      trigger.focus();
      trigger.click();
      fixture.detectChanges();
      await fixture.whenStable();

      findDialogButton('Cancel').click();
      await fixture.whenStable();
      await waitForTaskQueue();

      expect(stub.clear).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(trigger);
    } finally {
      TestBed.inject(MatDialog).closeAll();
      teardown();
    }
  });

  it('clearHistory toasts on failure and leaves entries intact', async () => {
    const { fixture, snack } = setup({
      listResult: { entries: [entry()] },
      confirm: true,
      clearResult: new Error('boom'),
    });
    vi.spyOn(console, 'warn');
    await fixture.componentInstance.reload();
    await fixture.componentInstance.clearHistory();
    expect(fixture.componentInstance.entries().length).toBe(1);
    expect(snack.open).toHaveBeenCalled();
  });

  it('openEntry navigates to /s/:slug and emits telemetry for entries with a slug', async () => {
    const { fixture, logger } = setup();
    const router = TestBed.inject(Router);
    const spy = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    await fixture.componentInstance.openEntry(entry({ slug: 'abc' }));
    expect(spy).toHaveBeenCalledWith(['/s', 'abc']);
    expect(logger.event).toHaveBeenCalledExactlyOnceWith(
      'history.entry.restored',
      undefined,
      undefined,
    );
  });

  it('openEntry is a no-op when slug is missing', async () => {
    const { fixture, logger } = setup();
    const router = TestBed.inject(Router);
    const spy = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    await fixture.componentInstance.openEntry(entry({ slug: undefined }));
    expect(spy).not.toHaveBeenCalled();
    expect(logger.event).not.toHaveBeenCalled();
  });

  it('openEntry does not emit telemetry when navigation is blocked', async () => {
    const { fixture, logger } = setup();
    const router = TestBed.inject(Router);
    const spy = vi.spyOn(router, 'navigate').mockResolvedValue(false);
    await fixture.componentInstance.openEntry(entry({ slug: 'abc' }));
    expect(spy).toHaveBeenCalledWith(['/s', 'abc']);
    expect(logger.event).not.toHaveBeenCalled();
  });

  it('openEntry does not emit telemetry when navigation rejects', async () => {
    const { fixture, logger } = setup();
    const router = TestBed.inject(Router);
    const spy = vi.spyOn(router, 'navigate').mockRejectedValue(new Error('blocked'));
    await expect(fixture.componentInstance.openEntry(entry({ slug: 'abc' }))).rejects.toThrow(
      'blocked',
    );
    expect(spy).toHaveBeenCalledWith(['/s', 'abc']);
    expect(logger.event).not.toHaveBeenCalled();
  });

  it('hasLink is true only for entries with a slug', () => {
    const { fixture } = setup();
    const c = fixture.componentInstance;
    expect(c.hasLink(entry({ slug: 'abc' }))).toBe(true);
    expect(c.hasLink(entry({ slug: undefined }))).toBe(false);
  });

  it('displayLabel prefers title, then slug, then deleted-blob fallback', () => {
    const { fixture } = setup();
    const c = fixture.componentInstance;
    expect(c.displayLabel(entry({ title: 'Hi' }))).toBe('Hi');
    expect(c.displayLabel(entry({ title: '  ', slug: 'abc' }))).toBe('/s/abc');
    expect(c.displayLabel(entry({ title: undefined, slug: undefined }))).toBe('(deleted blob)');
  });

  it('applySearchTerm updates the search term and reloads with q', async () => {
    const { fixture, stub } = setup({ listResult: { entries: [entry()] } });
    await fixture.componentInstance.reload();
    stub.list.mockClear();
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
    stub.list.mockClear();
    fixture.componentInstance.applySearchTerm('  foo  ');
    await Promise.resolve();
    expect(stub.list).not.toHaveBeenCalled();
  });

  it('onSearchInput pipes through a 300ms debounce', async () => {
    vi.useFakeTimers();
    try {
      const { fixture, stub } = setup({ listResult: { entries: [entry()] } });
      // Run ngOnInit (which kicks off an initial reload) deterministically so
      // its list call cannot land mid-test when a pending render flushes.
      fixture.detectChanges();
      await fixture.whenStable();
      stub.list.mockClear();

      fixture.componentInstance.onSearchInput('foo');
      vi.advanceTimersByTime(299);
      expect(stub.list).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2);
      await Promise.resolve();
      expect(stub.list).toHaveBeenCalledWith({ pageSize: 50, q: 'foo' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clearSearch resets the search term and reloads immediately', async () => {
    const { fixture, stub } = setup({ listResult: { entries: [entry()] } });
    await fixture.componentInstance.reload();
    fixture.componentInstance.applySearchTerm('foo');
    await Promise.resolve();
    await Promise.resolve();
    stub.list.mockClear();

    fixture.componentInstance.clearSearch();
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.componentInstance.searchTerm()).toBe('');
    expect(stub.list).toHaveBeenCalledWith({ pageSize: 50 });
  });

  it('loadMore forwards the active search term as q', async () => {
    const { fixture, stub } = setup({
      listResult: { entries: [entry({ id: 'a' })], continuationToken: 'tok' },
    });
    await fixture.componentInstance.reload();
    fixture.componentInstance.applySearchTerm('foo');
    await Promise.resolve();
    await Promise.resolve();
    stub.list.mockClear();
    stub.list.mockReturnValue(of({ entries: [entry({ id: 'b' })] }));
    await fixture.componentInstance.loadMore();
    expect(stub.list).toHaveBeenCalledWith({
      pageSize: 50,
      continuationToken: 'tok',
      q: 'foo',
    });
  });

  it('onFromDateChange forwards UTC start-of-day ISO as from', async () => {
    const { fixture, stub } = setup({ listResult: { entries: [] } });
    await fixture.componentInstance.reload();
    stub.list.mockClear();
    stub.list.mockReturnValue(of({ entries: [] }));
    fixture.componentInstance.onFromDateChange('2024-02-15');
    await Promise.resolve();
    await Promise.resolve();
    expect(stub.list).toHaveBeenCalledWith({
      pageSize: 50,
      from: '2024-02-15T00:00:00Z',
    });
  });

  it('onToDateChange forwards UTC end-of-day ISO as to', async () => {
    const { fixture, stub } = setup({ listResult: { entries: [] } });
    await fixture.componentInstance.reload();
    stub.list.mockClear();
    stub.list.mockReturnValue(of({ entries: [] }));
    fixture.componentInstance.onToDateChange('2024-02-15');
    await Promise.resolve();
    await Promise.resolve();
    expect(stub.list).toHaveBeenCalledWith({
      pageSize: 50,
      to: '2024-02-15T23:59:59.999Z',
    });
  });

  it('blocks reload when the from date is after the to date', async () => {
    const { fixture, stub } = setup({ listResult: { entries: [] } });
    await fixture.componentInstance.reload();
    fixture.componentInstance.onFromDateChange('2024-03-01');
    await Promise.resolve();
    await Promise.resolve();
    stub.list.mockClear();
    fixture.componentInstance.onToDateChange('2024-02-01');
    await Promise.resolve();
    await Promise.resolve();
    expect(stub.list).not.toHaveBeenCalled();
    expect(fixture.componentInstance.dateRangeError()).toBeTruthy();
  });

  it('clearDateRange resets both inputs and reloads', async () => {
    const { fixture, stub } = setup({ listResult: { entries: [] } });
    await fixture.componentInstance.reload();
    fixture.componentInstance.onFromDateChange('2024-02-01');
    fixture.componentInstance.onToDateChange('2024-02-28');
    await Promise.resolve();
    await Promise.resolve();
    stub.list.mockClear();
    stub.list.mockReturnValue(of({ entries: [] }));
    fixture.componentInstance.clearDateRange();
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.componentInstance.fromDate()).toBe('');
    expect(fixture.componentInstance.toDate()).toBe('');
    expect(stub.list).toHaveBeenCalledWith({ pageSize: 50 });
  });

  it('clearAllFilters resets search and dates', async () => {
    const { fixture, stub } = setup({ listResult: { entries: [] } });
    await fixture.componentInstance.reload();
    fixture.componentInstance.applySearchTerm('foo');
    fixture.componentInstance.onFromDateChange('2024-02-01');
    await Promise.resolve();
    await Promise.resolve();
    stub.list.mockClear();
    stub.list.mockReturnValue(of({ entries: [] }));
    fixture.componentInstance.clearAllFilters();
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.componentInstance.hasActiveFilters()).toBe(false);
    expect(stub.list).toHaveBeenCalledWith({ pageSize: 50 });
  });

  it('hasActiveFilters reflects date filters', () => {
    const { fixture } = setup();
    const c = fixture.componentInstance;
    expect(c.hasActiveFilters()).toBe(false);
    c.fromDate.set('2024-01-01');
    expect(c.hasActiveFilters()).toBe(true);
    c.fromDate.set('');
    c.toDate.set('2024-01-01');
    expect(c.hasActiveFilters()).toBe(true);
  });

  it('IntersectionObserver triggers loadMore when sentinel intersects', async () => {
    let observerCallback: (entries: { isIntersecting: boolean }[]) => void = () => {};
    const observe = vi.fn();
    const disconnect = vi.fn();
    const originalIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    class FakeIO {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        observerCallback = cb;
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
      takeRecords = () => [];
      root: Element | null = null;
      rootMargin = '';
      thresholds: ReadonlyArray<number> = [];
    }
    (globalThis as { IntersectionObserver: unknown }).IntersectionObserver =
      FakeIO as unknown as typeof IntersectionObserver;
    try {
      const { fixture, stub } = setup({
        listResult: { entries: [entry({ id: 'a' })], continuationToken: 'tok' },
        listSecondResult: { entries: [entry({ id: 'b' })] },
      });
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      await Promise.resolve();
      await Promise.resolve();
      expect(observe).toHaveBeenCalled();
      stub.list.mockClear();
      stub.list.mockReturnValue(of({ entries: [entry({ id: 'b' })] }));
      observerCallback([{ isIntersecting: true }]);
      await Promise.resolve();
      await Promise.resolve();
      expect(stub.list).toHaveBeenCalledWith({
        pageSize: 50,
        continuationToken: 'tok',
      });
      fixture.destroy();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      (globalThis as { IntersectionObserver: unknown }).IntersectionObserver =
        originalIO as typeof IntersectionObserver;
    }
  });

  it('IntersectionObserver does not trigger loadMore when there is no next page', async () => {
    let observerCallback: (entries: { isIntersecting: boolean }[]) => void = () => {};
    const originalIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    class FakeIO {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        observerCallback = cb;
      }
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
      takeRecords = () => [];
      root: Element | null = null;
      rootMargin = '';
      thresholds: ReadonlyArray<number> = [];
    }
    (globalThis as { IntersectionObserver: unknown }).IntersectionObserver =
      FakeIO as unknown as typeof IntersectionObserver;
    try {
      const { fixture, stub } = setup({
        listResult: { entries: [entry({ id: 'a' })] },
      });
      fixture.detectChanges();
      await fixture.whenStable();
      await Promise.resolve();
      stub.list.mockClear();
      observerCallback([{ isIntersecting: true }]);
      await Promise.resolve();
      expect(stub.list).not.toHaveBeenCalled();
    } finally {
      (globalThis as { IntersectionObserver: unknown }).IntersectionObserver =
        originalIO as typeof IntersectionObserver;
    }
  });
});
