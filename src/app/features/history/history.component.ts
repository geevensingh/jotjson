import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  effect,
  inject,
  signal
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Subject, debounceTime, distinctUntilChanged, firstValueFrom } from 'rxjs';
import { HistoryService } from '../../core/api/history.service';
import type { HistoryAction, HistoryEntry } from '../../core/api/models';
import { LoggerService } from '../../core/telemetry/logger.service';
import { SeoService } from '../../core/seo/seo.service';
import { AppHeaderComponent } from '../../shared/components/app-header/app-header.component';
import { IconComponent, JjIconName } from '../../shared/components/icon/icon.component';
import {
  ConfirmDialogComponent,
  ConfirmDialogData
} from '../../shared/dialogs/confirm-dialog/confirm-dialog.component';

type LoadState = 'loading' | 'ready' | 'error';

const ALL_ACTIONS: readonly HistoryAction[] = [
  'saved',
  'edited',
  'deleted',
  'viewed',
  'pasted'
];

interface DayGroup {
  /** Stable sort key: YYYY-MM-DD in the user's local timezone. */
  dayKey: string;
  /** Localized header label - "Today", "Yesterday", or absolute date. */
  label: string;
  entries: HistoryEntry[];
}

@Component({
  selector: 'app-history',
  standalone: true,
  imports: [
    RouterLink,
    MatButtonModule,
    MatTooltipModule,
    AppHeaderComponent,
    IconComponent
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './history.component.html',
  styleUrl: './history.component.scss'
})
export class HistoryComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly history = inject(HistoryService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  private readonly router = inject(Router);
  private readonly seo = inject(SeoService);
  private readonly logger = inject(LoggerService);

  readonly state = signal<LoadState>('loading');
  readonly entries = signal<HistoryEntry[]>([]);
  readonly continuationToken = signal<string | undefined>(undefined);
  readonly loadingMore = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly searchTerm = signal('');
  /** Mirrors the input element's value so the field stays controlled. */
  readonly searchInputValue = signal('');
  readonly actionFilter = signal<ReadonlySet<HistoryAction>>(new Set());
  readonly allActions: readonly HistoryAction[] = ALL_ACTIONS;
  /** YYYY-MM-DD strings from the date inputs (or '' when unset). */
  readonly fromDate = signal('');
  readonly toDate = signal('');
  readonly dateRangeError = signal<string | null>(null);

  private readonly searchInput$ = new Subject<string>();

  readonly isEmpty = computed(
    () => this.state() === 'ready' && this.entries().length === 0
  );

  readonly hasMore = computed(() => !!this.continuationToken());

  readonly hasActiveFilters = computed(
    () =>
      this.searchTerm().trim().length > 0 ||
      this.actionFilter().size > 0 ||
      this.fromDate().length > 0 ||
      this.toDate().length > 0
  );

  constructor() {
    inject(DestroyRef);
    this.searchInput$
      .pipe(
        debounceTime(300),
        distinctUntilChanged(),
        takeUntilDestroyed()
      )
      .subscribe((value) => this.applySearchTerm(value));
    // Re-observe the sentinel whenever the page state changes; the
    // sentinel only renders when there's another page (hasMore()) and its
    // DOM element is recreated each time the @if branch toggles, so we
    // need to re-attach the observer.
    effect(() => {
      // Track signals so the effect re-runs when they change.
      this.hasMore();
      this.entries();
      queueMicrotask(() => this.refreshSentinelObservation());
    });
  }

  /**
   * Apply a search term immediately (post-debounce). Public so tests can
   * exercise the search-driven reload without dealing with rxjs scheduler
   * timing inside Angular's zone.
   */
  applySearchTerm(value: string): void {
    const trimmed = value.trim();
    if (trimmed === this.searchTerm()) return;
    this.searchTerm.set(trimmed);
    void this.reload();
  }

  /**
   * Group entries into per-day buckets in display order. We use the user's
   * local timezone so "Today" matches their wall clock - the minor downside
   * is that two events around midnight may land in different buckets,
   * which is acceptable for v1 (better than confusing users by labeling
   * UTC days "Today").
   */
  readonly dayGroups = computed<DayGroup[]>(() => {
    const list = this.entries();
    if (list.length === 0) return [];
    const today = new Date();
    const todayKey = this.localDayKey(today);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = this.localDayKey(yesterday);

    const groups = new Map<string, DayGroup>();
    for (const entry of list) {
      const d = new Date(entry.accessedAt);
      const key = this.localDayKey(d);
      let group = groups.get(key);
      if (!group) {
        const label =
          key === todayKey
            ? $localize`:@@history.day.today:Today`
            : key === yesterdayKey
              ? $localize`:@@history.day.yesterday:Yesterday`
              : d.toLocaleDateString();
        group = { dayKey: key, label, entries: [] };
        groups.set(key, group);
      }
      group.entries.push(entry);
    }
    // Map iteration preserves insertion order, which is the server's
    // newest-first ordering; that's what we want.
    return Array.from(groups.values());
  });

  ngOnInit(): void {
    this.seo.clearBlobTags();
    this.seo.setNoindex(true);
    void this.reload();
  }

  /**
   * Wire up the IntersectionObserver after the view exists. We watch a
   * sentinel `<div>` rendered just above the Load more button; as soon as
   * it scrolls into view we trigger another page. The Load more button
   * stays visible as a keyboard-accessible fallback - users who prefer
   * explicit pagination (or whose browsers don't support IO) still have a
   * way to advance.
   */
  ngAfterViewInit(): void {
    if (typeof IntersectionObserver === 'undefined') return;
    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && this.hasMore() && !this.loadingMore()) {
            void this.loadMore();
          }
        }
      },
      { rootMargin: '200px 0px' }
    );
    this.refreshSentinelObservation();
  }

  ngOnDestroy(): void {
    this.intersectionObserver?.disconnect();
  }

  private refreshSentinelObservation(): void {
    const obs = this.intersectionObserver;
    if (!obs) return;
    obs.disconnect();
    const el = this.sentinel?.nativeElement;
    if (el) obs.observe(el);
  }

  @ViewChild('loadMoreSentinel') sentinel?: ElementRef<HTMLElement>;
  private intersectionObserver?: IntersectionObserver;

  async reload(): Promise<void> {
    this.state.set('loading');
    this.entries.set([]);
    this.continuationToken.set(undefined);
    const opts = this.buildListOptions();
    try {
      const page = await firstValueFrom(
        this.history.list({ pageSize: 50, ...opts })
      );
      this.entries.set(page.entries);
      this.continuationToken.set(page.continuationToken);
      this.state.set('ready');
    } catch (err) {
      this.logger.warn('history.load.failed');
      void err;
      this.errorMessage.set(
        $localize`:@@history.load.failed:Failed to load your history.`
      );
      this.state.set('error');
    }
  }

  async loadMore(): Promise<void> {
    const token = this.continuationToken();
    if (!token || this.loadingMore()) return;
    this.loadingMore.set(true);
    const opts = this.buildListOptions();
    try {
      const page = await firstValueFrom(
        this.history.list({
          pageSize: 50,
          continuationToken: token,
          ...opts
        })
      );
      this.entries.update((current) => [...current, ...page.entries]);
      this.continuationToken.set(page.continuationToken);
    } catch (err) {
      this.logger.warn('history.loadMore.failed');
      void err;
      this.snack.open(
        $localize`:@@history.loadMore.failed:Failed to load more history.`,
        $localize`:@@common.dismiss:Dismiss`,
        { duration: 4000 }
      );
    } finally {
      this.loadingMore.set(false);
    }
  }

  private buildListOptions(): {
    q?: string;
    actions?: HistoryAction[];
    from?: string;
    to?: string;
  } {
    const out: {
      q?: string;
      actions?: HistoryAction[];
      from?: string;
      to?: string;
    } = {};
    const q = this.searchTerm();
    if (q) out.q = q;
    const actions = this.actionFilter();
    if (actions.size > 0) {
      out.actions = ALL_ACTIONS.filter((a) => actions.has(a));
    }
    const from = this.fromIsoStart();
    if (from) out.from = from;
    const to = this.toIsoEnd();
    if (to) out.to = to;
    return out;
  }

  /**
   * Convert the YYYY-MM-DD `from` input to UTC start-of-day ISO. Empty
   * values pass through as undefined. Invalid strings yield undefined so
   * the request still succeeds (validation surfaces via dateRangeError).
   */
  private fromIsoStart(): string | undefined {
    const v = this.fromDate();
    if (!v) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
    return `${v}T00:00:00Z`;
  }

  private toIsoEnd(): string | undefined {
    const v = this.toDate();
    if (!v) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
    return `${v}T23:59:59.999Z`;
  }

  isActionSelected(action: HistoryAction): boolean {
    return this.actionFilter().has(action);
  }

  toggleAction(action: HistoryAction): void {
    const next = new Set(this.actionFilter());
    if (next.has(action)) next.delete(action);
    else next.add(action);
    this.actionFilter.set(next);
    void this.reload();
  }

  onFromDateChange(value: string): void {
    this.fromDate.set(value);
    if (this.validateDateRange()) {
      void this.reload();
    }
  }

  onToDateChange(value: string): void {
    this.toDate.set(value);
    if (this.validateDateRange()) {
      void this.reload();
    }
  }

  clearDateRange(): void {
    this.fromDate.set('');
    this.toDate.set('');
    this.dateRangeError.set(null);
    void this.reload();
  }

  clearAllFilters(): void {
    this.searchInputValue.set('');
    this.searchInput$.next('');
    this.searchTerm.set('');
    this.actionFilter.set(new Set());
    this.fromDate.set('');
    this.toDate.set('');
    this.dateRangeError.set(null);
    void this.reload();
  }

  /** Returns true when the range is valid (or empty). */
  private validateDateRange(): boolean {
    const from = this.fromDate();
    const to = this.toDate();
    if (from && to && from > to) {
      this.dateRangeError.set(
        $localize`:@@history.filter.date.invalid:From date must be on or before To date.`
      );
      return false;
    }
    this.dateRangeError.set(null);
    return true;
  }

  async clearHistory(): Promise<void> {
    const data: ConfirmDialogData = {
      title: $localize`:@@history.clear.title:Clear all history?`,
      message: $localize`:@@history.clear.message:Every entry in your activity history will be permanently removed. The blobs themselves are not affected.`,
      confirmLabel: $localize`:@@history.clear.confirm:Clear history`,
      cancelLabel: $localize`:@@common.cancel:Cancel`,
      destructive: true
    };
    const ref = this.dialog.open<ConfirmDialogComponent, ConfirmDialogData, boolean>(
      ConfirmDialogComponent,
      { data, width: '420px', autoFocus: 'dialog' }
    );
    const confirmed = await firstValueFrom(ref.afterClosed());
    if (!confirmed) return;
    try {
      await firstValueFrom(this.history.clear());
      this.entries.set([]);
      this.continuationToken.set(undefined);
      this.state.set('ready');
      this.snack.open(
        $localize`:@@history.clear.success:History cleared.`,
        $localize`:@@common.dismiss:Dismiss`,
        { duration: 3000 }
      );
    } catch (err) {
      this.logger.warn('history.clear.failed');
      void err;
      this.snack.open(
        $localize`:@@history.clear.failed:Failed to clear history.`,
        $localize`:@@common.dismiss:Dismiss`,
        { duration: 4000 }
      );
    }
  }

  /** Click on a row - navigates to /s/<slug> when one is available. */
  openEntry(entry: HistoryEntry): void {
    if (!entry.slug || entry.action === 'deleted') return;
    void this.router.navigate(['/s', entry.slug]);
  }

  onSearchInput(value: string): void {
    this.searchInputValue.set(value);
    this.searchInput$.next(value);
  }

  clearSearch(): void {
    this.searchInputValue.set('');
    this.searchInput$.next('');
    // Apply immediately too so that callers (and tests) don't have to wait
    // for the debounce window when the input is being reset programmatically.
    this.applySearchTerm('');
  }

  hasLink(entry: HistoryEntry): boolean {
    return !!entry.slug && entry.action !== 'deleted';
  }

  /** Display label: prefer title, fall back to slug, then "(deleted blob)". */
  displayLabel(entry: HistoryEntry): string {
    const t = entry.title?.trim();
    if (t && t.length > 0) return t;
    if (entry.slug) return `/s/${entry.slug}`;
    // Paste events are intentionally blob-less (api/src/shared/history.ts:
    // "absent for pasted events"), so the generic "(deleted blob)" label
    // would be misleading. Use a dedicated label for the no-slug paste case.
    if (entry.action === 'pasted') {
      return $localize`:@@history.pastedContent:Pasted content`;
    }
    return $localize`:@@history.deletedBlob:(deleted blob)`;
  }

  iconFor(action: HistoryEntry['action']): JjIconName {
    switch (action) {
      case 'saved':
        return 'save';
      case 'edited':
        return 'edit';
      case 'deleted':
        return 'trash';
      case 'viewed':
        return 'eye';
      case 'pasted':
        return 'paste';
    }
  }

  actionLabel(action: HistoryEntry['action']): string {
    switch (action) {
      case 'saved':
        return $localize`:@@history.action.saved:Saved`;
      case 'edited':
        return $localize`:@@history.action.edited:Edited`;
      case 'deleted':
        return $localize`:@@history.action.deleted:Deleted`;
      case 'viewed':
        return $localize`:@@history.action.viewed:Viewed`;
      case 'pasted':
        return $localize`:@@history.action.pasted:Pasted`;
    }
  }

  formatTime(iso: string): string {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  /**
   * Compute a stable YYYY-MM-DD key in the user's local timezone. We can't
   * use `toISOString().slice(0, 10)` because that's UTC and would put
   * late-evening events into the next day for users west of UTC.
   */
  private localDayKey(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}
