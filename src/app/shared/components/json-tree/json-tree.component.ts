import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatMenuModule } from '@angular/material/menu';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTreeModule, MatTreeNestedDataSource } from '@angular/material/tree';
import { NestedTreeControl } from '@angular/cdk/tree';
import { PreferencesService } from '../../../core/preferences/preferences.service';
import { persistedStringSignal } from '../../../core/preferences/persisted-signal';
import { jsonTypeOf, JsonValueType } from '../../pipes/json-type.pipe';
import { IconComponent } from '../icon/icon.component';
import {
  ParsedDate,
  formatDateAnnotation,
  parseAsDate
} from '../../utils/date-detect';
import { classifyValue, ValueClassification } from '../../utils/value-classifier';

/**
 * Search-by-type filter values. `'all'` is the no-filter sentinel.
 * Everything else mirrors `ValueClassification` minus `'undefined'`
 * (no JSON `undefined`).
 */
export type SearchValueType = Exclude<ValueClassification, 'undefined'> | 'all';

const SEARCH_VALUE_TYPES: readonly SearchValueType[] = [
  'all',
  'date',
  'date/time',
  'uuid',
  'url',
  'email',
  'path',
  'ipv4',
  'ipv6',
  'integer',
  'number',
  'string',
  'boolean',
  'null',
  'array',
  'object'
];

const TYPE_LABELS: Record<ValueClassification, string> = {
  date: $localize`:@@tree.type.date:date`,
  'date/time': $localize`:@@tree.type.dateTime:date/time`,
  uuid: $localize`:@@tree.type.uuid:uuid`,
  url: $localize`:@@tree.type.url:url`,
  email: $localize`:@@tree.type.email:email`,
  path: $localize`:@@tree.type.path:path`,
  ipv4: $localize`:@@tree.type.ipv4:ipv4`,
  ipv6: $localize`:@@tree.type.ipv6:ipv6`,
  integer: $localize`:@@tree.type.integer:integer`,
  number: $localize`:@@tree.type.number:number`,
  string: $localize`:@@tree.type.string:string`,
  boolean: $localize`:@@tree.type.boolean:boolean`,
  null: $localize`:@@tree.type.null:null`,
  array: $localize`:@@tree.type.array:array`,
  object: $localize`:@@tree.type.object:object`,
  undefined: $localize`:@@tree.type.undefined:undefined`
};

interface TreeNode {
  segment: string | number | undefined;
  path: (string | number)[];
  pathString: string;
  value: unknown;
  type: JsonValueType;
  depth: number;
  children?: TreeNode[];
}

/**
 * Escapes a value for use in a CSS attribute selector. Falls back to
 * a manual escape when the platform `CSS.escape` is unavailable
 * (older browsers / SSR).
 */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
}

/**
 * localStorage key for the persisted tree-search term. Per-device,
 * never synced to the server. Mirrors the splitRatio / draft pattern.
 */
const TREE_SEARCH_STORAGE_KEY = 'jotjson.treeSearch.v1';

/**
 * Interactive tree viewer for parsed JSON, built on Angular Material's
 * mat-tree (nested variant). JsonParserService is the source of the value.
 */
@Component({
  selector: 'jj-json-tree',
  standalone: true,
  imports: [FormsModule, MatMenuModule, MatTreeModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './json-tree.component.html',
  styleUrl: './json-tree.component.scss'
})
export class JsonTreeComponent {
  private readonly prefs = inject(PreferencesService);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);
  private readonly snack = inject(MatSnackBar);

  readonly value = input<unknown>(undefined);

  readonly search = persistedStringSignal(TREE_SEARCH_STORAGE_KEY);

  /**
   * Path of the currently-selected tree row, or `null` for no selection.
   * Stored as `pathString` (display form) so the value survives mat-tree
   * re-renders that recreate node objects. We never reverse-parse it - all
   * lookups go through `nodeIndex`.
   */
  readonly selectedPath = signal<string | null>(null);

  readonly expandLabel = $localize`:@@tree.node.expand:Expand`;
  readonly collapseLabel = $localize`:@@tree.node.collapse:Collapse`;

  readonly expandMenuButtonLabel = $localize`:@@tree.expand.menu.button:Expand to...`;
  readonly matchingValueAriaLabel = $localize`:@@tree.matchValue.aria:Matches the selected value`;

  readonly searchCaseSensitiveLabel = $localize`:@@tree.search.caseSensitive.label:Aa`;
  readonly searchCaseSensitiveTooltip = $localize`:@@tree.search.caseSensitive.tooltip:Match case`;
  readonly searchRegexLabel = $localize`:@@tree.search.regex.label:.*`;
  readonly searchRegexTooltip = $localize`:@@tree.search.regex.tooltip:Regular expression`;
  readonly searchScopeTooltip = $localize`:@@tree.search.scope.tooltip:Search in`;
  readonly searchScopeKeysLabel = $localize`:@@tree.search.scope.keys:Keys`;
  readonly searchScopeValuesLabel = $localize`:@@tree.search.scope.values:Values`;
  readonly searchScopeBothLabel = $localize`:@@tree.search.scope.both:Keys and values`;
  readonly searchValueTypeTooltip = $localize`:@@tree.search.type.tooltip:Filter by value type`;
  readonly searchValueTypeAllLabel = $localize`:@@tree.search.type.all:All types`;
  readonly searchPrevTooltip = $localize`:@@tree.search.prev.tooltip:Previous match`;
  readonly searchNextTooltip = $localize`:@@tree.search.next.tooltip:Next match`;

  readonly treeControl = new NestedTreeControl<TreeNode, string>(
    (n) => n.children ?? [],
    { trackBy: (n) => n.pathString }
  );
  readonly dataSource = new MatTreeNestedDataSource<TreeNode>();

  readonly root = computed<TreeNode | undefined>(() => {
    const raw = this.value();
    if (raw === undefined) return undefined;
    const root: TreeNode = {
      segment: undefined,
      path: [],
      pathString: '$',
      value: raw,
      type: jsonTypeOf(raw),
      depth: 0
    };
    if (root.type === 'object' || root.type === 'array') {
      root.children = this.buildChildren(raw, []);
    }
    return root;
  });

  readonly showTypeBadges = computed(() => this.prefs.prefs().treeShowTypeLabels);
  readonly showDateAnnotations = computed(
    () => this.prefs.prefs().treeShowDateAnnotations
  );
  readonly treeFontSize = computed(() => this.prefs.prefs().treeFontSize);
  readonly treeFontSizePx = computed(() => `${this.treeFontSize()}px`);

  /**
   * Tick signal used to refresh relative-time annotations. Updated every
   * 60s while the component is alive. Fine-grained enough for "5 minutes
   * ago" -> "6 minutes ago"; cheap enough that it does not show up on a
   * profile.
   */
  private readonly nowSignal = signal(Date.now());

  readonly searchHits = computed<ReadonlySet<string>>(() => {
    return this.searchHitData().set;
  });

  /**
   * Ordered list of paths matching the current query in document
   * order. Backs prev/next navigation and the displayed match count.
   */
  readonly searchHitPaths = computed<readonly string[]>(() => {
    return this.searchHitData().order;
  });

  /**
   * Whether the current search query (when in regex mode) compiles
   * to a valid regular expression. Used purely for visual feedback;
   * `searchHits` already swallows regex errors and returns no hits.
   */
  /**
   * Index into `searchHitPaths()` of the "active" match - the one
   * Next/Prev navigation centers on. `-1` when there are no hits.
   * Resets to `0` whenever the hit list changes (different query,
   * scope, or value).
   */
  readonly activeHitIndex = signal<number>(-1);

  /**
   * Path of the currently-active match, or `null` when there is no
   * active match. Used by the template to apply a stronger highlight
   * to the active row.
   */
  readonly activeHitPath = computed<string | null>(() => {
    const i = this.activeHitIndex();
    const list = this.searchHitPaths();
    return i >= 0 && i < list.length ? (list[i] ?? null) : null;
  });

  readonly searchHitCount = computed<number>(() => this.searchHitPaths().length);

  /**
   * 1-indexed position of `selectedPath()` within `searchHitPaths()`,
   * or `0` when the current selection is not one of the hits (or
   * nothing is selected). Used by `searchCountLabel` to render
   * "N / Total matches" while the user is positioned on a hit.
   */
  readonly currentMatchIndex = computed<number>(() => {
    const sp = this.selectedPath();
    if (sp === null) return 0;
    if (!this.searchHits().has(sp)) return 0;
    const idx = this.searchHitPaths().indexOf(sp);
    return idx >= 0 ? idx + 1 : 0;
  });

  /**
   * Whether the current search query (when in regex mode) compiles
   * to a valid regular expression. Used purely for visual feedback;
   * `searchHits` already swallows regex errors and returns no hits.
   */
  readonly searchRegexInvalid = computed<boolean>(() => {
    if (!this.prefs.prefs().searchRegexMode) return false;
    const q = this.search().trim();
    if (!q) return false;
    try {
      new RegExp(q);
      return false;
    } catch {
      return true;
    }
  });

  /**
   * True when the search has either non-empty query text OR an active
   * type filter. Drives whether the match counter and prev/next nav
   * are shown - both work in "navigator mode" (empty query + active
   * type filter) the same way they do for a query.
   */
  readonly searchActive = computed<boolean>(
    () => !!this.search().trim() || this.prefs.prefs().searchValueType !== 'all'
  );

  /**
   * Localized "12 matches" / "1 match" / "No matches" string for the
   * counter beside the search input. Returns the empty string when
   * neither a query nor a type filter is active so the counter can be
   * hidden.
   */
  readonly searchCountLabel = computed<string>(() => {
    if (!this.searchActive()) return '';
    const n = this.searchHitCount();
    if (n === 0) return $localize`:@@tree.search.count.none:No matches`;
    const pos = this.currentMatchIndex();
    if (pos > 0) {
      return $localize`:@@tree.search.count.position:${pos}:position: / ${n}:count: matches`;
    }
    if (n === 1) return $localize`:@@tree.search.count.one:1 match`;
    return $localize`:@@tree.search.count.other:${n}:count: matches`;
  });

  /**
   * Worst-case label used as a hidden width-reservation "ghost" beside
   * the live count, so toolbar controls don't shift as the position
   * digits change. Always renders "N / N matches" - the widest label
   * any state can produce for the current hit count - when there are
   * hits; otherwise the empty string so no ghost is rendered.
   */
  readonly searchCountGhost = computed<string>(() => {
    if (!this.searchActive()) return '';
    const n = this.searchHitCount();
    if (n === 0) return '';
    return $localize`:@@tree.search.count.ghost:${n}:position: / ${n}:count: matches`;
  });

  scopeLabel(scope: 'keys' | 'values' | 'both'): string {
    switch (scope) {
      case 'keys':
        return this.searchScopeKeysLabel;
      case 'values':
        return this.searchScopeValuesLabel;
      default:
        return this.searchScopeBothLabel;
    }
  }

  /**
   * Localized label for the search-by-type dropdown trigger and menu
   * items. `'all'` is the explicit no-filter sentinel; everything else
   * reuses the same `@@tree.type.*` IDs as the type badges so the two
   * surfaces stay in lockstep.
   */
  valueTypeLabel(type: SearchValueType): string {
    if (type === 'all') return this.searchValueTypeAllLabel;
    return TYPE_LABELS[type];
  }

  /**
   * Ordered list driving the type-filter dropdown. `'all'` is first
   * (the no-filter sentinel) followed by every `ValueClassification`
   * value except `'undefined'` (no JSON `undefined`).
   */
  readonly searchValueTypes: readonly SearchValueType[] = SEARCH_VALUE_TYPES;

  readonly searchScope = computed(() => this.prefs.prefs().searchScope);
  readonly searchCaseSensitive = computed(() => this.prefs.prefs().searchCaseSensitive);
  readonly searchRegexMode = computed(() => this.prefs.prefs().searchRegexMode);
  readonly searchValueType = computed(() => this.prefs.prefs().searchValueType);

  readonly searchScopeButtonLabel = computed(() => this.scopeLabel(this.searchScope()));
  readonly searchValueTypeButtonLabel = computed(() => this.valueTypeLabel(this.searchValueType()));

  readonly searchPrevDisabled = computed(() => this.searchHitCount() === 0);
  readonly searchNextDisabled = computed(() => this.searchHitCount() === 0);

  private readonly searchHitData = computed<{
    set: ReadonlySet<string>;
    order: readonly string[];
  }>(() => {
    const q = this.search().trim();
    const prefs = this.prefs.prefs();
    const typeFilter = prefs.searchValueType;
    if (!q && typeFilter === 'all') return { set: new Set(), order: [] };
    const scope = prefs.searchScope;
    const caseSensitive = prefs.searchCaseSensitive;
    const regexMode = prefs.searchRegexMode;
    const needle = caseSensitive ? q : q.toLowerCase();
    let regex: RegExp | undefined;
    if (q && regexMode) {
      try {
        regex = new RegExp(q, caseSensitive ? '' : 'i');
      } catch {
        return { set: new Set(), order: [] };
      }
    }
    const matchSet = new Set<string>();
    const matchOrder: string[] = [];
    const test = (hay: string): boolean =>
      regex ? regex.test(hay) : (caseSensitive ? hay : hay.toLowerCase()).includes(needle);
    const record = (path: string): void => {
      if (matchSet.has(path)) return;
      matchSet.add(path);
      matchOrder.push(path);
    };
    // When a type filter is active, only nodes whose classified value
    // type matches are candidates. The existing scope rules then decide
    // whether key text and/or value text are eligible for the text
    // match. Empty query + active type yields every candidate node.
    const matchesTypeFilter = (node: TreeNode): boolean => {
      if (typeFilter === 'all') return true;
      const classification = classifyValue(node.type, node.value, {
        detectDates: true,
        assumeUtcForIsoDateTime: prefs.treeAssumeUtcForIsoDateTime,
        assumeUtcForIsoDateOnly: prefs.treeAssumeUtcForIsoDateOnly
      });
      return classification === typeFilter;
    };
    const walk = (node: TreeNode | undefined): void => {
      if (!node) return;
      if (matchesTypeFilter(node)) {
        if (!q) {
          // Navigator mode: list every candidate node. Skip the root
          // sentinel (segment === undefined) so users don't navigate
          // to the document root itself.
          if (node.segment !== undefined) record(node.pathString);
        } else {
          if (node.segment !== undefined && (scope === 'keys' || scope === 'both')) {
            if (test(String(node.segment))) record(node.pathString);
          }
          if (scope === 'values' || scope === 'both') {
            if (node.type !== 'object' && node.type !== 'array') {
              if (test(this.renderLeaf(node.value, node.type))) record(node.pathString);
            }
          }
        }
      }
      node.children?.forEach(walk);
    };
    walk(this.root());
    return { set: matchSet, order: matchOrder };
  });

  /**
   * `pathString -> TreeNode` map rebuilt whenever the tree root changes.
   * Used as the only safe way to resolve `selectedPath()` back to a node;
   * `pathString` is a display form (`$.foo["a.b"]`) and ambiguous to
   * reverse-parse, so we lookup instead.
   */
  private readonly nodeIndex = computed<ReadonlyMap<string, TreeNode>>(() => {
    const map = new Map<string, TreeNode>();
    const walk = (node: TreeNode | undefined): void => {
      if (!node) return;
      map.set(node.pathString, node);
      node.children?.forEach(walk);
    };
    walk(this.root());
    return map;
  });

  /**
   * Paths of all rows that share the selected row's primitive value
   * (type-aware: `1 !== "1"`). Empty when nothing is selected, when the
   * selected node is missing from the index, or when it's a container or
   * `undefined`. Excludes the selected node itself.
   *
   * Per spec: container selections (object/array) do not compute matches.
   */
  readonly matchingPaths = computed<ReadonlySet<string>>(() => {
    const sp = this.selectedPath();
    if (sp === null) return new Set();
    const selected = this.nodeIndex().get(sp);
    if (!selected) return new Set();
    if (selected.type === 'object' || selected.type === 'array' || selected.type === 'undefined') {
      return new Set();
    }
    const targetType = selected.type;
    const targetValue = selected.value;
    const matches = new Set<string>();
    const walk = (node: TreeNode | undefined): void => {
      if (!node) return;
      if (
        node.pathString !== sp &&
        node.type === targetType &&
        node.value === targetValue
      ) {
        matches.add(node.pathString);
      }
      node.children?.forEach(walk);
    };
    walk(this.root());
    return matches;
  });

  /**
   * Paths of every ancestor of the selected row, root inclusive. Empty
   * when the root itself is selected (root never self-highlights as its
   * own ancestor).
   */
  readonly ancestorPaths = computed<ReadonlySet<string>>(() => {
    const sp = this.selectedPath();
    if (sp === null) return new Set();
    const selected = this.nodeIndex().get(sp);
    if (!selected) return new Set();
    const ancestors = new Set<string>();
    const partial: (string | number)[] = [];
    // Always include the synthetic root path '$' as an ancestor of any
    // non-root selection. Root has empty `path[]` so the loop below adds
    // nothing in that case, leaving the set empty.
    if (selected.path.length > 0) {
      ancestors.add('$');
    }
    for (let i = 0; i < selected.path.length - 1; i++) {
      partial.push(selected.path[i] as string | number);
      ancestors.add(this.formatPath(partial));
    }
    return ancestors;
  });

  private hasInitializedExpansion = false;

  constructor() {
    const NOW_TICK_MS = 60_000;
    const handle = setInterval(() => this.nowSignal.set(Date.now()), NOW_TICK_MS);
    this.destroyRef.onDestroy(() => clearInterval(handle));

    effect(() => {
      const r = this.root();
      this.dataSource.data = r ? [r] : [];
      if (!r) {
        this.hasInitializedExpansion = false;
        // Use untracked to avoid creating a dependency on selectedPath
        // here - we only want to react to value changes.
        untracked(() => this.selectedPath.set(null));
        return;
      }
      if (!this.hasInitializedExpansion) {
        this.hasInitializedExpansion = true;
        this.expandToLevel(this.prefs.prefs().defaultTreeExpansionDepth);
      }
      // Whenever the underlying value changes (and the resulting tree
      // root re-renders), drop any stale selection. Predictable, no
      // zombie state.
      untracked(() => this.selectedPath.set(null));
    });

    // Reset the active-match index whenever the hit list changes
    // (different query, scope, or value). Empty -> -1; non-empty -> 0.
    effect(() => {
      const paths = this.searchHitPaths();
      untracked(() => {
        this.activeHitIndex.set(paths.length > 0 ? 0 : -1);
      });
    });

    // search() is persisted via persistedStringSignal at the field
    // declaration above (key: TREE_SEARCH_STORAGE_KEY). Per-device,
    // never sent to the server.
  }

  hasChild = (_: number, node: TreeNode): boolean =>
    !!node.children && node.children.length > 0;

  /**
   * Click handler for `.tree-row`. Selects the row unless the click
   * target is an interactive child (twisty toggle, copy-path button,
   * etc.) in which case the child's own handler takes precedence.
   */
  onSelect(node: TreeNode, event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('button, [matTreeNodeToggle], a, input, [role="button"]')) {
      return;
    }
    this.selectedPath.set(node.pathString);
    event.stopPropagation();
  }

  clearSelection(): void {
    this.selectedPath.set(null);
  }

  /**
   * Outside-click clear. Fires on every document click; ignores clicks
   * that landed inside this component or inside any open CDK overlay
   * (mat-menu, future popovers) - those interactions should preserve
   * the user's selection.
   */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.selectedPath() === null) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (this.host.nativeElement.contains(target)) return;
    if (target.closest('.cdk-overlay-container')) return;
    this.clearSelection();
  }

  /**
   * Escape clears the active selection. We do not call preventDefault()
   * so the search input's own Esc binding can also clear the search
   * query when it has focus - one Esc press exits both at once.
   */
  @HostListener('document:keydown.escape')
  onDocumentEscape(): void {
    if (this.selectedPath() !== null) {
      this.clearSelection();
    }
  }

  /**
   * Escape inside the search input clears the search. We
   * `preventDefault` to swallow browser-level Esc handling (e.g.,
   * cancelling a surrounding form), but deliberately do not call
   * `stopPropagation` so the component-level document Escape
   * handler can still clear the active selection in the same press.
   */
  onSearchEsc(ev?: Event): void {
    ev?.preventDefault();
    this.search.set('');
  }

  setSearchScope(scope: 'keys' | 'values' | 'both'): void {
    this.prefs.update({ searchScope: scope });
  }

  setSearchValueType(type: SearchValueType): void {
    this.prefs.update({ searchValueType: type });
  }

  toggleSearchCaseSensitive(): void {
    this.prefs.update({
      searchCaseSensitive: !this.prefs.prefs().searchCaseSensitive
    });
  }

  toggleSearchRegexMode(): void {
    this.prefs.update({
      searchRegexMode: !this.prefs.prefs().searchRegexMode
    });
  }

  goToNextMatch(): void {
    const paths = this.searchHitPaths();
    if (paths.length === 0) return;
    const i = this.activeHitIndex();
    const next = i < 0 ? 0 : (i + 1) % paths.length;
    this.activeHitIndex.set(next);
    const path = paths[next] as string;
    this.selectedPath.set(path);
    this.revealHit(path);
  }

  goToPrevMatch(): void {
    const paths = this.searchHitPaths();
    if (paths.length === 0) return;
    const i = this.activeHitIndex();
    const prev = i <= 0 ? paths.length - 1 : i - 1;
    this.activeHitIndex.set(prev);
    const path = paths[prev] as string;
    this.selectedPath.set(path);
    this.revealHit(path);
  }

  /**
   * Search-input Enter / Shift+Enter shortcut. Enter advances to the
   * next match; Shift+Enter to the previous. preventDefault so the
   * surrounding form (if any) does not submit.
   */
  onSearchEnter(ev: Event): void {
    if (this.searchHitCount() === 0) return;
    ev.preventDefault();
    const keyEvent = ev as KeyboardEvent;
    if (keyEvent.shiftKey) {
      this.goToPrevMatch();
    } else {
      this.goToNextMatch();
    }
  }

  /**
   * Expand all ancestors of the given path and scroll the row into
   * view. No-op when the path is unknown to `nodeIndex`.
   */
  private revealHit(path: string): void {
    const node = this.nodeIndex().get(path);
    if (!node) return;
    // Walk up the path to expand each ancestor container.
    const partial: (string | number)[] = [];
    for (let i = 0; i < node.path.length - 1; i++) {
      partial.push(node.path[i] as string | number);
      const ancestor = this.nodeIndex().get(this.formatPath(partial));
      if (ancestor) this.treeControl.expand(ancestor);
    }
    // Defer scroll until after Angular renders the expansion.
    queueMicrotask(() => {
      const el = this.host.nativeElement.querySelector(
        `[data-path="${cssEscape(path)}"]`
      ) as HTMLElement | null;
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  expandAll(): void {
    const walk = (node: TreeNode | undefined): void => {
      if (!node || !node.children) return;
      this.treeControl.expand(node);
      for (const c of node.children) walk(c);
    };
    walk(this.root());
  }

  collapseAll(): void {
    this.treeControl.collapseAll();
  }

  expandToLevel(depth: number): void {
    this.treeControl.collapseAll();
    const walk = (node: TreeNode | undefined): void => {
      if (!node || !node.children) return;
      if (node.depth < depth) {
        this.treeControl.expand(node);
        for (const c of node.children) walk(c);
      }
    };
    walk(this.root());
  }

  onSearchInput(ev: Event): void {
    this.search.set((ev.target as HTMLInputElement).value);
  }

  copyPath(node: TreeNode): void {
    const dismiss = $localize`:@@common.dismiss:Dismiss`;
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      this.snack.open(
        $localize`:@@tree.copyPath.unsupported:Copy is not supported in this browser.`,
        dismiss,
        { duration: 4000 }
      );
      return;
    }
    clipboard.writeText(node.pathString).then(
      () => {
        this.snack.open(
          $localize`:@@tree.copyPath.success:Path copied to clipboard.`,
          dismiss,
          { duration: 2000 }
        );
      },
      () => {
        this.snack.open(
          $localize`:@@tree.copyPath.failed:Failed to copy path.`,
          dismiss,
          { duration: 4000 }
        );
      }
    );
  }

  renderLeaf(value: unknown, type: JsonValueType): string {
    switch (type) {
      case 'null':
        return 'null';
      case 'undefined':
        return 'undefined';
      case 'string':
        return JSON.stringify(value as string);
      case 'number':
      case 'boolean':
        return String(value);
      default:
        return '';
    }
  }

  /**
   * Returns the parenthetical body for the date annotation, or null if
   * the node's value is not a recognized date string. Reads `nowSignal`
   * so the relative-time portion refreshes on each 60s tick.
   *
   * Intentionally does NOT participate in `renderLeaf`: search must match
   * the raw value, not the localized annotation.
   */
  dateAnnotation(node: TreeNode): string | null {
    if (node.type !== 'string') return null;
    const prefs = this.prefs.prefs();
    const parsed: ParsedDate | null = parseAsDate(node.value, undefined, {
      assumeUtcForIsoDateTime: prefs.treeAssumeUtcForIsoDateTime,
      assumeUtcForIsoDateOnly: prefs.treeAssumeUtcForIsoDateOnly
    });
    if (!parsed) return null;
    return formatDateAnnotation(parsed, new Date(this.nowSignal()));
  }

  /**
   * Localized label for the type-badge. Returns a richer descriptor
   * than the raw JSON type when we can detect one (uuid, url, email,
   * ipv4, ipv6, integer, date, date/time). Date detection is gated by
   * the `treeShowDateAnnotations` master toggle so the badge text stays
   * in sync with the annotation visibility.
   */
  typeLabel(node: TreeNode): string {
    const prefs = this.prefs.prefs();
    const classification = classifyValue(node.type, node.value, {
      detectDates: prefs.treeShowDateAnnotations,
      assumeUtcForIsoDateTime: prefs.treeAssumeUtcForIsoDateTime,
      assumeUtcForIsoDateOnly: prefs.treeAssumeUtcForIsoDateOnly
    });
    return TYPE_LABELS[classification];
  }

  containerSummary(node: TreeNode): string {
    if (node.type === 'array') {
      const n = (node.value as unknown[]).length;
      return `[ ${n === 0 ? '' : '...'} ]`;
    }
    if (node.type === 'object') {
      const keys = Object.keys(node.value as Record<string, unknown>);
      return `{ ${keys.length === 0 ? '' : '...'} }`;
    }
    return '';
  }

  containerCountText(node: TreeNode): string {
    if (node.type === 'array') {
      const n = (node.value as unknown[]).length;
      return n === 1 ? '1 item' : `${n} items`;
    }
    if (node.type === 'object') {
      const n = Object.keys(node.value as Record<string, unknown>).length;
      return n === 1 ? '1 key' : `${n} keys`;
    }
    return '';
  }

  segmentIsIndex(node: TreeNode): boolean {
    return typeof node.segment === 'number';
  }

  private buildChildren(
    value: unknown,
    parentPath: (string | number)[]
  ): TreeNode[] {
    if (Array.isArray(value)) {
      return value.map((child, i) => this.buildNode(i, child, [...parentPath, i]));
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      return Object.keys(obj).map((k) => this.buildNode(k, obj[k], [...parentPath, k]));
    }
    return [];
  }

  private buildNode(
    segment: string | number,
    value: unknown,
    path: (string | number)[]
  ): TreeNode {
    const type = jsonTypeOf(value);
    const node: TreeNode = {
      segment,
      path,
      pathString: this.formatPath(path),
      value,
      type,
      depth: path.length
    };
    if (type === 'object' || type === 'array') {
      node.children = this.buildChildren(value, path);
    }
    return node;
  }

  private formatPath(path: (string | number)[]): string {
    let out = '$';
    for (const seg of path) {
      if (typeof seg === 'number') {
        out += `[${seg}]`;
      } else if (/^[A-Za-z_$][\w$]*$/.test(seg)) {
        out += `.${seg}`;
      } else {
        out += `[${JSON.stringify(seg)}]`;
      }
    }
    return out;
  }
}
