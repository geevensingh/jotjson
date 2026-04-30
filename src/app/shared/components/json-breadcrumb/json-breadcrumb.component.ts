import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild
} from '@angular/core';
import { MatMenuModule } from '@angular/material/menu';
import { IconComponent } from '../icon/icon.component';

/**
 * One step in a tree breadcrumb. `label` is what the user sees (e.g.
 * `users`, `[0]`, `Root`); `canonicalPath` is the JsonPath-form path
 * string (e.g. `$.users[0]`) the parent will pass back to
 * `selectByPathString()` on click. `current` is `true` for the chip
 * that represents the currently-selected tree row (used to render
 * `aria-current="location"` and the selected-row highlight).
 */
export interface BreadcrumbCrumb {
  readonly label: string;
  readonly canonicalPath: string;
  readonly current: boolean;
}

/**
 * A clicked-segment payload. `depth` is the 0-based index of the
 * crumb within the full crumbs() array (0 = root).
 */
export interface BreadcrumbClick {
  readonly canonicalPath: string;
  readonly depth: number;
}

/**
 * Breadcrumb above the JSON tree showing the path from the root to
 * the currently-selected row (selected node included; flagged via
 * `current: true`). Each segment is a clickable chip; clicking one
 * re-selects that node in the tree (via the parent's
 * `selectByPathString()` flow).
 *
 * Pure presentational component - no path parsing, no tree access.
 * The parent (JsonTreeComponent) owns the view-model.
 *
 * Truncation: width-driven. Chips render at their natural width; if
 * the row overflows its container, middle chips are progressively
 * popped into an overflow `...` menu (first chip and last chip stay
 * visible) until the row fits. As a final safety net, individual
 * chips can shrink and ellipsize.
 *
 * The bar also exposes a trailing "Copy JSON path" button driven by
 * the parent (`copyPathClick` output). The parent decides whether
 * the button is enabled (typically: enabled iff a row is selected).
 */
@Component({
  selector: 'jj-breadcrumb',
  standalone: true,
  imports: [MatMenuModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './json-breadcrumb.component.html',
  styleUrl: './json-breadcrumb.component.scss'
})
export class JsonBreadcrumbComponent {
  private readonly destroyRef = inject(DestroyRef);

  /**
   * Ordered list of crumbs, root first, deepest last. The crumb
   * representing the currently-selected row carries `current: true`.
   * An empty array renders the placeholder.
   */
  readonly crumbs = input<readonly BreadcrumbCrumb[]>([]);

  /**
   * Plain-text shown when `crumbs` is empty. Localized by the
   * parent (this component is i18n-agnostic - its only English
   * literal is the "Breadcrumb" nav aria-label, which is overridable
   * via `navAriaLabel`).
   */
  readonly emptyPlaceholder = input<string>('');

  /**
   * Localized accessible name for the wrapping `<nav>` element.
   * Falls back to the literal "Breadcrumb" if the parent does not
   * supply a value.
   */
  readonly navAriaLabel = input<string>('Breadcrumb');

  /**
   * Localized accessible name for the overflow trigger. Defaults to
   * a short English string to avoid a hard requirement on the parent.
   */
  readonly overflowAriaLabel = input<string>('Show hidden ancestors');

  /**
   * Localized title (tooltip) for the trailing copy-path button.
   */
  readonly copyPathTitle = input<string>('Copy JSON path');

  /**
   * Localized accessible name for the trailing copy-path button.
   */
  readonly copyPathAriaLabel = input<string>('Copy JSON path of selected row');

  /**
   * Disables the trailing copy-path button. Parent typically sets
   * this to `true` when no row is selected.
   */
  readonly copyPathDisabled = input<boolean>(false);

  readonly crumbClick = output<BreadcrumbClick>();
  readonly copyPathClick = output<void>();

  /** Reference to the `<ol>` chip list, used to measure overflow. */
  private readonly listRef = viewChild<ElementRef<HTMLElement>>('list');

  /**
   * How many middle crumbs are currently hidden in the overflow
   * menu. `0` = all visible (no overflow chip rendered). Set by
   * `fitStep()` driven by ResizeObserver and by the crumbs-change
   * effect.
   */
  readonly hiddenMiddleCount = signal(0);

  /** `true` iff at least one middle crumb is hidden. */
  readonly hasOverflow = computed(() => this.hiddenMiddleCount() > 0);

  /**
   * `true` when the collapse algorithm is fully collapsed - either
   * because there are too few crumbs to ever produce an overflow
   * chip (1 or 2), or because every collapsible middle crumb is
   * already hidden. Used to flip the host class
   * `is-fully-collapsed`, which in turn lets the SCSS make the
   * very last chip flex-shrinkable as a final ellipsis fallback.
   * Empty crumbs return `false` so the placeholder branch never
   * carries the class.
   */
  readonly isFullyCollapsed = computed(() => {
    const total = this.crumbs().length;
    if (total === 0) return false;
    if (total < 3) return true;
    return this.hiddenMiddleCount() === total - 2;
  });

  /** The first crumb (always visible whenever crumbs is non-empty). */
  readonly leadingCrumb = computed<BreadcrumbCrumb | null>(() => {
    const all = this.crumbs();
    return all.length > 0 ? all[0]! : null;
  });

  /**
   * Crumbs hidden in the overflow menu. Empty when there is no
   * overflow.
   */
  readonly hiddenCrumbs = computed<readonly BreadcrumbCrumb[]>(() => {
    const k = this.hiddenMiddleCount();
    if (k === 0) return [];
    return this.crumbs().slice(1, 1 + k);
  });

  /**
   * Crumbs after the overflow chip (or all crumbs after the first if
   * no overflow). When the list contains only the root crumb, this
   * is empty.
   */
  readonly trailingCrumbs = computed<readonly BreadcrumbCrumb[]>(() => {
    const all = this.crumbs();
    if (all.length <= 1) return [];
    return all.slice(1 + this.hiddenMiddleCount());
  });

  /**
   * Index of `crumb` within the full `crumbs()` array. Used to
   * report the absolute depth in the click payload regardless of
   * which slot the chip rendered in.
   */
  indexOf(crumb: BreadcrumbCrumb): number {
    return this.crumbs().indexOf(crumb);
  }

  onCrumbClick(crumb: BreadcrumbCrumb): void {
    this.crumbClick.emit({
      canonicalPath: crumb.canonicalPath,
      depth: this.indexOf(crumb)
    });
  }

  onCopyClick(): void {
    this.copyPathClick.emit();
  }

  // ---------------------------------------------------------------
  // Width-driven truncation
  //
  // Algorithm: render every crumb at its natural width. If the
  // chip list's `scrollWidth` exceeds its `clientWidth`, hide one
  // middle crumb at a time (replacing the hidden range with a
  // single overflow chip) until the row fits OR we cannot hide
  // any more (only the first and last crumb remain inline alongside
  // the overflow chip). Each step runs in its own animation frame
  // so the DOM has a chance to relayout between measurements.
  //
  // Re-runs on:
  //   - `crumbs()` changes (reset to 0 hidden, then re-fit).
  //   - container resize via ResizeObserver (same reset + re-fit).
  // ---------------------------------------------------------------

  private rafHandle: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimeoutHandle: number | null = null;

  /**
   * How long to wait after the last ResizeObserver fire before
   * re-running the fit algorithm. Avoids RAF/relayout thrash during
   * an active window-resize drag.
   */
  private static readonly RESIZE_DEBOUNCE_MS = 100;

  constructor() {
    // Re-fit when the crumb list changes. Reset to "all visible" and
    // schedule a measurement after Angular renders the new list.
    // Selection-driven; NOT debounced - the breadcrumb should snap
    // instantly to a new selection.
    effect(() => {
      this.crumbs(); // track crumb list identity
      untracked(() => {
        this.hiddenMiddleCount.set(0);
        this.scheduleFit();
      });
    });

    // Attach (and re-attach) the ResizeObserver to whatever <ol>
    // element viewChild currently points at. The <ol> lives inside
    // an @else block that is destroyed when crumbs() is empty (no
    // selection), so the element identity changes across deselect ->
    // re-select cycles. A signal-driven effect handles that without
    // any extra glue.
    effect(() => {
      const list = this.listRef()?.nativeElement;
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      if (!list) return;
      this.resizeObserver = new ResizeObserver(() => this.onResize());
      this.resizeObserver.observe(list);
    });

    this.destroyRef.onDestroy(() => {
      if (this.rafHandle !== null) {
        cancelAnimationFrame(this.rafHandle);
        this.rafHandle = null;
      }
      if (this.resizeTimeoutHandle !== null) {
        clearTimeout(this.resizeTimeoutHandle);
        this.resizeTimeoutHandle = null;
      }
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
    });
  }

  /**
   * ResizeObserver-driven recalc, debounced 100ms trailing-edge.
   * During an active window-resize drag the bar may visibly clip on
   * the right edge for up to ~100ms after the user pauses; that's
   * the deliberate trade-off vs. running the full reset/measure
   * cascade on every frame of the drag.
   */
  private onResize(): void {
    if (this.resizeTimeoutHandle !== null) {
      clearTimeout(this.resizeTimeoutHandle);
    }
    this.resizeTimeoutHandle = window.setTimeout(() => {
      this.resizeTimeoutHandle = null;
      this.hiddenMiddleCount.set(0);
      this.scheduleFit();
    }, JsonBreadcrumbComponent.RESIZE_DEBOUNCE_MS);
  }

  private scheduleFit(): void {
    if (this.rafHandle !== null) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      this.fitStep();
    });
  }

  /**
   * One iteration of the fit loop: if the chip list still overflows
   * its container and we can hide one more middle crumb, do so and
   * schedule another iteration after the next layout pass.
   */
  private fitStep(): void {
    const list = this.listRef()?.nativeElement;
    if (!list) return;
    const total = this.crumbs().length;
    // Need at least 3 crumbs to ever produce an overflow chip
    // (we always keep the first and last visible).
    if (total < 3) return;
    if (list.scrollWidth <= list.clientWidth) return;
    if (this.hiddenMiddleCount() >= total - 2) return; // can't hide more
    this.hiddenMiddleCount.update((k) => k + 1);
    this.scheduleFit();
  }
}
