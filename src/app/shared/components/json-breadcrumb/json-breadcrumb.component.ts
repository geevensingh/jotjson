import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output
} from '@angular/core';
import { MatMenuModule } from '@angular/material/menu';
import { IconComponent } from '../icon/icon.component';

/**
 * One step in a tree breadcrumb. `label` is what the user sees (e.g.
 * `users`, `[0]`, `Root`); `canonicalPath` is the JsonPath-form path
 * string (e.g. `$.users[0]`) the parent will pass back to
 * `selectByPathString()` on click.
 */
export interface BreadcrumbCrumb {
  readonly label: string;
  readonly canonicalPath: string;
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
 * Breadcrumb above the JSON tree showing the ancestor chain of the
 * currently-selected row. Each segment is a clickable chip; clicking
 * one re-selects that ancestor in the tree (via the parent's
 * `selectByPathString()` flow).
 *
 * Pure presentational component - no path parsing, no tree access.
 * The parent (JsonTreeComponent) owns the view-model.
 *
 * Truncation: count-based. If `<= 5` crumbs, all are visible. If
 * more, only `[crumbs[0], crumbs[1], OVERFLOW, crumbs[n-2],
 * crumbs[n-1]]` show; the overflow chip opens a menu listing the
 * hidden middle ancestors. Per-chip width is also capped via CSS so
 * a single 50-char key can't blow out the row.
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
  /**
   * Ordered list of ancestors, root first, deepest last. The parent
   * is responsible for excluding the currently-selected node itself
   * if "parents only" semantics are desired. An empty array renders
   * the placeholder.
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

  readonly crumbClick = output<BreadcrumbClick>();

  /**
   * Maximum number of crumbs shown inline before the overflow chip
   * kicks in. With `THRESHOLD = 5`, 1..5 crumbs all render; 6+ get
   * collapsed.
   */
  static readonly THRESHOLD = 5;

  /**
   * `true` iff overflow is active. Drives the template's branching
   * between "all inline" and "first/last + overflow chip" layouts.
   */
  readonly hasOverflow = computed(() => this.crumbs().length > JsonBreadcrumbComponent.THRESHOLD);

  /**
   * The first two crumbs when overflow is active; empty otherwise.
   * Template uses `leadingCrumbs()` followed by overflow chip
   * followed by `trailingCrumbs()`.
   */
  readonly leadingCrumbs = computed<readonly BreadcrumbCrumb[]>(() => {
    if (!this.hasOverflow()) return [];
    return this.crumbs().slice(0, 2);
  });

  /**
   * Crumbs that disappear into the overflow menu (indices 2..n-3,
   * inclusive). Empty when overflow is not active.
   */
  readonly hiddenCrumbs = computed<readonly BreadcrumbCrumb[]>(() => {
    if (!this.hasOverflow()) return [];
    const all = this.crumbs();
    return all.slice(2, all.length - 2);
  });

  /**
   * The last two crumbs when overflow is active; empty otherwise.
   */
  readonly trailingCrumbs = computed<readonly BreadcrumbCrumb[]>(() => {
    if (!this.hasOverflow()) return [];
    const all = this.crumbs();
    return all.slice(all.length - 2);
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
}
