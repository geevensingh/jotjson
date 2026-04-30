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
  output,
  signal,
  untracked,
  viewChild,
  type WritableSignal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { MatTreeModule, MatTreeNestedDataSource } from '@angular/material/tree';
import { MatDividerModule } from '@angular/material/divider';
import { NestedTreeControl } from '@angular/cdk/tree';
import { ClipboardCopyService } from '../../../core/clipboard/clipboard-copy.service';
import { PreferencesService } from '../../../core/preferences/preferences.service';
import { JsonParserService } from '../../../core/json/json-parser.service';
import { RuleSetsService } from '../../../core/api/rule-sets.service';
import { LoggerService } from '../../../core/telemetry/logger.service';
import type { FormattingIcon, FormattingRuleSet } from '../../../core/api/models';
import { jsonTypeOf, JsonValueType } from '../../pipes/json-type.pipe';
import { IconComponent } from '../icon/icon.component';
import {
  JsonBreadcrumbComponent,
  type BreadcrumbClick,
  type BreadcrumbContextMenu,
  type BreadcrumbCrumb
} from '../json-breadcrumb/json-breadcrumb.component';
import {
  EMPTY_RULE_RESULT,
  RuleEngineNode,
  RuleEngineResult,
  evaluateFormattingRules
} from './formatting-rules-engine';
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
  imports: [FormsModule, MatMenuModule, MatTreeModule, MatDividerModule, IconComponent, JsonBreadcrumbComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './json-tree.component.html',
  styleUrl: './json-tree.component.scss'
})
export class JsonTreeComponent {
  private readonly prefs = inject(PreferencesService);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);
  private readonly clipboardCopy = inject(ClipboardCopyService);
  private readonly jsonParser = inject(JsonParserService);
  private readonly ruleSets = inject(RuleSetsService);
  private readonly logger = inject(LoggerService);

  readonly value = input<unknown>(undefined);

  /**
   * M6d-3 preview hook. When non-null, this list of rule sets replaces
   * `ruleSets.defaultRuleSets()` for THIS component instance only - no
   * shared service state is mutated. Used by the rule editor's live
   * preview to render the in-progress draft without saving.
   *
   * Semantics:
   *  - `null` / unset (default): fall back to `defaultRuleSets()`
   *    (existing behavior, preserved).
   *  - `[]`: no rule sets active. Tree renders plain (no highlighting).
   *  - `[set, ...]`: those exact rule sets are evaluated, in order.
   *
   * Reactive via signal-based input: assigning a new array re-evaluates
   * `evaluateNode` automatically.
   */
  readonly overrideRuleSets = input<FormattingRuleSet[] | null>(null);

  readonly embeddedMode = input<boolean>(false);

  /**
   * Search query for the tree. When `embeddedMode` is false (default,
   * home tree), the value is persisted to / hydrated from localStorage
   * under `TREE_SEARCH_STORAGE_KEY`. When `embeddedMode` is true (rule
   * editor live preview), persistence is disabled and the signal stays
   * a plain in-memory signal seeded from `''`.
   *
   * Implemented via a constructor-side effect rather than the
   * `persistedStringSignal` helper so the persistence decision can read
   * the `embeddedMode` Input, which is not bound at field-initializer
   * time.
   */
  readonly search: WritableSignal<string> = signal('');

  /**
   * Path of the currently-selected tree row, or `null` for no selection.
   * Stored as `pathString` (display form) so the value survives mat-tree
   * re-renders that recreate node objects. We never reverse-parse it - all
   * lookups go through `nodeIndex`.
   */
  readonly selectedPath = signal<string | null>(null);

  /**
   * Context-menu state (M7q). `contextNode` is the row whose menu is
   * currently open (or about to open). `ctxX` / `ctxY` carry the cursor
   * coordinates for the right-click flow; the kebab flow self-anchors
   * via its own `MatMenuTrigger` so these stay at 0 in that case.
   * Mouse-only in v1: keyboard-fired contextmenu (`clientX/Y === 0`)
   * is ignored in `onRowContextMenu`.
   */
  readonly contextNode = signal<TreeNode | null>(null);
  readonly ctxX = signal(0);
  readonly ctxY = signal(0);

  /**
   * Hidden positional anchor for the right-click context-menu flow.
   * Bound to (`ctxX`, `ctxY`) by the template; we open it
   * programmatically after setting both. Kebab buttons are their own
   * `[matMenuTriggerFor]` instances and self-anchor; they do not use
   * this trigger.
   */
  readonly ctxTrigger = viewChild<MatMenuTrigger>('ctxTrigger');

  /**
   * Emits the structural path of the currently-selected row, or `null`
   * when nothing is selected. Driven by an `effect()` over
   * `selectedPath` so user clicks AND programmatic
   * `selectByPathString` calls funnel through one emission point.
   * Used by the home component to drive editor->tree selection sync.
   *
   * Emits an initial `null` at construction (signal initial value);
   * consumers must tolerate that.
   */
  readonly selectionChange = output<readonly (string | number)[] | null>();

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

  // Context menu labels (M7q). Stored as readonly fields so $localize
  // sees the literal at extract time and the template can bind to them
  // without re-evaluating per render.
  readonly ctxCopyKeyLabel = $localize`:@@tree.contextMenu.copyKey:Copy key`;
  readonly ctxCopyValueLabel = $localize`:@@tree.contextMenu.copyValue:Copy value`;
  readonly ctxCopyPathLabel = $localize`:@@tree.contextMenu.copyPath:Copy path`;
  readonly ctxSearchByKeyLabel = $localize`:@@tree.contextMenu.searchByKey:Search by key`;
  readonly ctxSearchByValueLabel = $localize`:@@tree.contextMenu.searchByValue:Search by value`;
  readonly ctxCollapseLabel = $localize`:@@tree.contextMenu.collapse:Collapse`;
  readonly ctxExpandAllFromHereLabel = $localize`:@@tree.contextMenu.expandAllFromHere:Expand all from here`;
  readonly ctxExpandToDepth1Label = $localize`:@@tree.contextMenu.expandToDepth.1:Expand 1 level from here`;
  readonly ctxExpandToDepth2Label = $localize`:@@tree.contextMenu.expandToDepth.2:Expand 2 levels from here`;
  readonly ctxExpandToDepth3Label = $localize`:@@tree.contextMenu.expandToDepth.3:Expand 3 levels from here`;
  readonly ctxExpandToDepth4Label = $localize`:@@tree.contextMenu.expandToDepth.4:Expand 4 levels from here`;
  readonly ctxExpandToDepth5Label = $localize`:@@tree.contextMenu.expandToDepth.5:Expand 5 levels from here`;
  readonly ctxIsolateLabel = $localize`:@@tree.contextMenu.isolate:Isolate`;
  readonly ctxCollapseSiblingsLabel = $localize`:@@tree.contextMenu.collapseSiblings:Collapse siblings`;
  readonly kebabAriaLabel = $localize`:@@tree.kebab.aria:Row actions`;
  readonly kebabTitleLabel = $localize`:@@tree.kebab.title:Row actions`;

  // Breadcrumb labels (Phase 2). Stable English source strings; i18n
  // IDs feed through the standard pipeline (extract-i18n).
  readonly breadcrumbAriaLabel = $localize`:@@tree.breadcrumb.aria:Breadcrumb`;
  readonly breadcrumbEmptyLabel = $localize`:@@tree.breadcrumb.empty:No current selection`;
  readonly breadcrumbRootLabel = $localize`:@@tree.breadcrumb.root:Root`;
  readonly breadcrumbOverflowAriaLabel = $localize`:@@tree.breadcrumb.overflow.aria:Show hidden ancestors`;
  readonly breadcrumbCopyPathTitle = $localize`:@@tree.breadcrumb.copyPath.title:Copy JSON path`;
  readonly breadcrumbCopyPathAriaLabel = $localize`:@@tree.breadcrumb.copyPath.aria:Copy JSON path of selected row`;

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
    const index = this.activeHitIndex();
    const list = this.searchHitPaths();
    return index >= 0 && index < list.length ? (list[index] ?? null) : null;
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
    const index = this.searchHitPaths().indexOf(sp);
    return index >= 0 ? index + 1 : 0;
  });

  /**
   * Whether the current search query (when in regex mode) compiles
   * to a valid regular expression. Used purely for visual feedback;
   * `searchHits` already swallows regex errors and returns no hits.
   */
  readonly searchRegexInvalid = computed<boolean>(() => {
    if (!this.prefs.prefs().searchRegexMode) return false;
    const query = this.search().trim();
    if (!query) return false;
    try {
      new RegExp(query);
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
    const count = this.searchHitCount();
    if (count === 0) return $localize`:@@tree.search.count.none:No matches`;
    const pos = this.currentMatchIndex();
    if (pos > 0) {
      return $localize`:@@tree.search.count.position:${pos}:position: / ${count}:count: matches`;
    }
    if (count === 1) return $localize`:@@tree.search.count.one:1 match`;
    return $localize`:@@tree.search.count.other:${count}:count: matches`;
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
    const count = this.searchHitCount();
    if (count === 0) return '';
    return $localize`:@@tree.search.count.ghost:${count}:position: / ${count}:count: matches`;
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
    const query = this.search().trim();
    const prefs = this.prefs.prefs();
    const typeFilter = prefs.searchValueType;
    if (!query && typeFilter === 'all') return { set: new Set(), order: [] };
    const scope = prefs.searchScope;
    const caseSensitive = prefs.searchCaseSensitive;
    const regexMode = prefs.searchRegexMode;
    const needle = caseSensitive ? query : query.toLowerCase();
    let regex: RegExp | undefined;
    if (query && regexMode) {
      try {
        regex = new RegExp(query, caseSensitive ? '' : 'i');
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
        if (!query) {
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
   * Path from the root to the currently-selected row, suitable for
   * the breadcrumb above the tree. The last crumb represents the
   * selected row itself (flagged with `current: true`); earlier
   * crumbs are its ancestors (flagged with `current: false`).
   *
   *  - Null selection -> `[]` (breadcrumb renders the placeholder).
   *  - Root selected -> `[{ Root, current: true }]`.
   *  - Deeper selection -> `[Root, ancestor1, ..., selected]`.
   *
   * Reads `selectedPath` and `nodeIndex`; recomputes when either
   * changes.
   */
  readonly crumbs = computed<readonly BreadcrumbCrumb[]>(() => {
    const sp = this.selectedPath();
    if (sp === null) return [];
    const node = this.nodeIndex().get(sp);
    if (!node) return [];
    const path = node.path;
    const out: BreadcrumbCrumb[] = [
      {
        label: this.breadcrumbRootLabel,
        canonicalPath: '$',
        current: path.length === 0
      }
    ];
    // Include the selected node as the final crumb (i = path.length).
    for (let i = 1; i <= path.length; i++) {
      const partial = path.slice(0, i);
      const segment = partial[partial.length - 1];
      const label =
        typeof segment === 'number' ? `[${segment}]` : String(segment);
      out.push({
        label,
        canonicalPath: this.formatPath(partial),
        current: i === path.length
      });
    }
    return out;
  });

  /**
   * `true` when the trailing copy-path button on the breadcrumb bar
   * should be disabled. Mirrors "is anything selected?".
   */
  readonly breadcrumbCopyDisabled = computed(
    () => this.selectedPath() === null
  );

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
      const rootNode = this.root();
      this.dataSource.data = rootNode ? [rootNode] : [];
      if (!rootNode) {
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

    // M6d-3-fu2 search persistence. When NOT in embeddedMode, hydrate
    // the search signal from localStorage on first run and write
    // through on every subsequent change. The effect early-returns in
    // embeddedMode so the preview tree neither reads nor writes the
    // home tree's TREE_SEARCH_STORAGE_KEY slot.
    let searchHydrated = false;
    effect(() => {
      if (this.embeddedMode()) {
        return;
      }
      if (!searchHydrated) {
        searchHydrated = true;
        try {
          const raw = localStorage.getItem(TREE_SEARCH_STORAGE_KEY);
          if (raw !== null) {
            untracked(() => this.search.set(raw));
          }
        } catch {
          /* storage unavailable / blocked */
        }
      }
      const value = this.search();
      try {
        if (value.length === 0) {
          localStorage.removeItem(TREE_SEARCH_STORAGE_KEY);
        } else {
          localStorage.setItem(TREE_SEARCH_STORAGE_KEY, value);
        }
      } catch {
        /* storage unavailable / quota / private mode */
      }
    });

    // search() is persisted via the effect above (keyed on
    // TREE_SEARCH_STORAGE_KEY) when embeddedMode is false. Per-device,
    // never sent to the server.

    // Emit selectionChange whenever the canonical selectedPath signal
    // settles. Both user clicks (which write through onSelect) and
    // programmatic selects (selectByPathString) go through this funnel,
    // so the home component never has to wire two separate channels.
    // We swallow the transient case where selectedPath references a
    // path the current nodeIndex hasn't seen yet (e.g., a still-mid-
    // render mat-tree update) - the next effect tick will emit when
    // both signals agree. selectedPath = null always emits null.
    effect(() => {
      const selected = this.selectedPath();
      if (selected === null) {
        this.selectionChange.emit(null);
        return;
      }
      const node = this.nodeIndex().get(selected);
      if (!node) return;
      this.selectionChange.emit(node.path);
    });
  }

  hasChild = (_: number, node: TreeNode): boolean =>
    !!node.children && node.children.length > 0;

  /**
   * Click handler for `.tree-row`. Selects the row unless the click
   * target is an interactive child (twisty toggle, kebab button,
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
    const index = this.activeHitIndex();
    const next = index < 0 ? 0 : (index + 1) % paths.length;
    this.activeHitIndex.set(next);
    const path = paths[next] as string;
    this.selectedPath.set(path);
    this.revealHit(path);
  }

  goToPrevMatch(): void {
    const paths = this.searchHitPaths();
    if (paths.length === 0) return;
    const index = this.activeHitIndex();
    const prev = index <= 0 ? paths.length - 1 : index - 1;
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
   * Returns true iff the given pathString is currently in the tree's
   * `nodeIndex`. Public so the home component can pre-flight a path
   * before calling `selectByPathString` (used by the editor->tree
   * cursor sync to short-circuit "cursor is in JSON we can't surface
   * yet, e.g. mid-typing").
   */
  hasPath(pathString: string): boolean {
    return this.nodeIndex().has(pathString);
  }

  /**
   * Programmatic selection setter. Idempotent (no write when the path
   * is already selected) and silently no-ops when the path is not in
   * `nodeIndex`. `null` clears the selection. Used by the home
   * component to drive editor->tree sync.
   *
   * Expands ancestor containers and scrolls the row into view, mirroring
   * the search-jump UX.
   */
  selectByPathString(pathString: string | null): void {
    if (pathString === null) {
      if (this.selectedPath() !== null) {
        this.selectedPath.set(null);
      }
      return;
    }
    if (this.selectedPath() === pathString) return;
    if (!this.nodeIndex().has(pathString)) return;
    this.selectedPath.set(pathString);
    this.expandAndScroll(pathString);
  }

  /**
   * Breadcrumb chip activation handler. Logs telemetry (depth-only;
   * the canonical path content is potentially user-sensitive and is
   * NOT recorded) and re-selects the ancestor via the existing
   * `selectByPathString` flow, which handles expand-and-scroll.
   *
   * Telemetry includes `selectionUpDistance` so we can tell, for any
   * crumb click, both how deep the chip was from the root (`depth`)
   * and how many levels up from the prior selection it was. Clicking
   * the current chip emits `selectionUpDistance: 0`.
   */
  onBreadcrumbClick(event: BreadcrumbClick): void {
    const total = this.crumbs().length;
    const selectionUpDistance = total === 0 ? 0 : total - 1 - event.depth;
    this.logger.info('tree.breadcrumb.click', {
      depth: event.depth,
      selectionUpDistance
    });
    this.selectByPathString(event.canonicalPath);
  }

  /**
   * Copy-path handler for the trailing button on the breadcrumb bar.
   * Resolves the currently-selected node, emits its own telemetry id
   * (so we can tell breadcrumb-copy from row-context-menu copy), then
   * delegates to the shared `copyPath` writer.
   *
   * No-op when nothing is selected. The breadcrumb component should
   * disable the button in that case (`breadcrumbCopyDisabled`), but
   * we still guard here so a programmatic emit can't crash.
   */
  onBreadcrumbCopyPath(): void {
    const sp = this.selectedPath();
    if (sp === null) return;
    const node = this.nodeIndex().get(sp);
    if (!node) return;
    const total = this.crumbs().length;
    this.logger.info('tree.breadcrumb.copyPath', {
      depth: total === 0 ? 0 : total - 1,
      selectionUpDistance: 0
    });
    this.copyPath(node);
  }

  /**
   * Expand all ancestors of the given path and scroll the row into
   * view. No-op when the path is unknown to `nodeIndex`. Shared by the
   * search-jump path (`revealHit`) and programmatic selection
   * (`selectByPathString`).
   */
  private expandAndScroll(path: string): void {
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

  /**
   * Search-jump reveal. Thin wrapper around `expandAndScroll` kept for
   * backwards compatibility with existing search call sites.
   */
  private revealHit(path: string): void {
    this.expandAndScroll(path);
  }

  expandAll(): void {
    const walk = (node: TreeNode | undefined): void => {
      if (!node || !node.children) return;
      this.treeControl.expand(node);
      for (const child of node.children) walk(child);
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
        for (const child of node.children) walk(child);
      }
    };
    walk(this.root());
  }

  onSearchInput(ev: Event): void {
    this.search.set((ev.target as HTMLInputElement).value);
  }

  copyPath(node: TreeNode): void {
    const path = this.jsonParser.formatPathForClipboard(
      node.pathString,
      this.prefs.prefs().treePathRoot
    );
    void this.clipboardCopy.copyWithToast(path, {
      success: $localize`:@@tree.copyPath.success:Path copied to clipboard.`,
      failed: $localize`:@@tree.copyPath.failed:Failed to copy path.`,
      unsupported: $localize`:@@tree.copyPath.unsupported:Copy is not supported in this browser.`
    });
  }

  // ===========================================================================
  // Context menu (M7q)
  //
  // Public surface:
  //   onRowContextMenu / onRowDblClick / onKebabClick - row-level event entry
  //   points; they update `contextNode` / cursor coords and emit telemetry.
  //
  //   copyKey / copyValue / copyPathFromMenu - menu actions; each emits its
  //   own `tree.contextMenu.*` telemetry id and runs the copy.
  //
  //   searchByKey / searchByValue - menu actions; each clears the type filter
  //   to 'all', forces literal (non-regex) search, sets the search query,
  //   and elevates the clicked row to the active hit when it matches.
  //
  //   collapseFromHere / expandAllFromHere / expandToDepthFromHere - menu
  //   actions; each operates on the subtree rooted at the clicked node.
  //   `expandToDepthFromHere` is **expand-only**: it expands every collapsed
  //   container at relative depth `< N` and never collapses anything (M7q
  //   follow-up; supersedes the original Q3 snap-to-N decision because users
  //   read "Expand to depth +N" as expand-only).
  //
  // Visibility predicates (showCopyKey etc.) drive `@if` guards in the
  // template so a menu item is rendered only when its action would do
  // something meaningful for the currently-clicked row.
  // ===========================================================================

  /**
   * Right-click handler for `.tree-row`. Sets `contextNode`, updates the
   * cursor anchor, selects the row (mirrors OS context-menu UX), and
   * opens the shared `rowMenu`.
   *
   * Bails when the event arrives with `(clientX, clientY) === (0, 0)`,
   * which is the keyboard-fired contextmenu signal (Shift+F10 / context
   * menu key). Keyboard support is deferred to a follow-up - rows are
   * not currently focusable, so a keyboard menu would have no anchor.
   *
   * Bails when the click target is an interactive descendant (twisty,
   * kebab pill) so those keep their own click behavior.
   */
  onRowContextMenu(event: MouseEvent, node: TreeNode): void {
    if (event.clientX === 0 && event.clientY === 0) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest('button, [matTreeNodeToggle], a, input, [role="button"]')
    ) {
      return;
    }
    this.openContextMenuAt(event, node, 'row');
  }

  /**
   * Right-click handler for a breadcrumb chip. Resolves the chip's
   * canonical path to a TreeNode via the same `nodeIndex` the click
   * flow uses, then hands off to `openContextMenuAt`. The breadcrumb
   * already called `preventDefault()` on the original event and the
   * keyboard `(0, 0)` guard, so we just need the path-to-node lookup
   * and the same anchor-and-open dance the row flow does.
   *
   * Silent no-op when the path is unknown to `nodeIndex` - that's a
   * race where the tree changed between the chip's render and the
   * right-click. Matches the existing `selectByPathString` behaviour.
   */
  onBreadcrumbContextMenu(payload: BreadcrumbContextMenu): void {
    const node = this.nodeIndex().get(payload.canonicalPath);
    if (!node) return;
    this.openContextMenuAt(payload.event, node, 'breadcrumb');
  }

  /**
   * Shared opener for the row context menu. Used by both the row
   * right-click flow (`onRowContextMenu`) and the breadcrumb chip
   * right-click flow (`onBreadcrumbContextMenu`). Sets cursor anchor,
   * pins the contextNode, selects the row, logs telemetry with the
   * gesture source, and opens the menu on the next microtask.
   *
   * If a menu is already open (e.g. user right-clicks a different
   * row before dismissing the previous menu), it closes first and
   * reopens at the new anchor; just calling `openMenu()` again does
   * not reposition the panel.
   *
   * Note: the kebab-click flow does NOT go through this helper -
   * the kebab is its own `[matMenuTriggerFor]` button and self-
   * anchors, so it only needs to update `contextNode` and
   * `selectedPath`. Its own logger call (with `source: 'kebab'`)
   * lives in `onKebabClick`.
   */
  private openContextMenuAt(
    event: MouseEvent,
    node: TreeNode,
    source: 'row' | 'breadcrumb'
  ): void {
    event.preventDefault();
    const trigger = this.ctxTrigger();
    const apply = (): void => {
      this.ctxX.set(event.clientX);
      this.ctxY.set(event.clientY);
      this.contextNode.set(node);
      this.selectedPath.set(node.pathString);
      this.logger.info('tree.contextMenu.opened', { source });
      queueMicrotask(() => trigger?.openMenu());
    };
    if (trigger?.menuOpen) {
      // Re-right-click on a different row while the menu is still open:
      // close first, then re-anchor and reopen on the next microtask.
      // Just calling openMenu() again does not reposition the panel.
      const sub = trigger.menuClosed.subscribe(() => {
        sub.unsubscribe();
        apply();
      });
      trigger.closeMenu();
    } else {
      apply();
    }
  }

  /**
   * Double-click handler for `.tree-row`. Copies the row's value (raw
   * text for primitives, pretty-printed JSON for containers) per Q5
   * decision in plan.md. The browser also fires two `click` events
   * before the `dblclick`; the existing `onSelect` runs for each but
   * is idempotent on identical paths, so no debounce is needed.
   */
  onRowDblClick(event: MouseEvent, node: TreeNode): void {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest('button, [matTreeNodeToggle], a, input, [role="button"]')
    ) {
      return;
    }
    this.copyValue(node, 'dblclick');
  }

  /**
   * Click handler for the per-row kebab button. Updates `contextNode`
   * synchronously so the menu's bindings see the right row before the
   * MatMenuTrigger's own click listener opens the panel. The kebab is
   * its own `[matMenuTriggerFor]` button, so the menu self-anchors to
   * the kebab's location - no `ctxX`/`ctxY` work needed.
   *
   * Stops propagation so the row-level `onSelect` and `onRowDblClick`
   * handlers do not fire on the same click sequence.
   */
  onKebabClick(event: MouseEvent, node: TreeNode): void {
    event.stopPropagation();
    this.contextNode.set(node);
    this.selectedPath.set(node.pathString);
    this.logger.info('tree.contextMenu.opened', { source: 'kebab' });
  }

  /**
   * Copies the row's key (object member name or array index) to the
   * clipboard. Caller must guard with `showCopyKey(node)` (root has
   * `segment === undefined`).
   */
  copyKey(node: TreeNode): void {
    if (node.segment === undefined) return;
    this.logger.info('tree.contextMenu.copyKey');
    void this.clipboardCopy.copyWithToast(String(node.segment), {
      success: $localize`:@@tree.contextMenu.copy.success.key:Key copied to clipboard.`,
      failed: $localize`:@@tree.contextMenu.copy.failed.key:Failed to copy key.`,
      unsupported: $localize`:@@tree.contextMenu.copy.unsupported:Copy is not supported in this browser.`
    });
  }

  /**
   * Copies the row's value to the clipboard. For primitives, the raw
   * text (no enclosing quotes for strings); for objects/arrays,
   * `JSON.stringify(value, null, 2)` (pretty, per Q1 decision).
   *
   * `source` distinguishes menu-driven from double-click-driven invocations
   * for telemetry; both paths use identical copy semantics.
   */
  copyValue(node: TreeNode, source: 'menu' | 'dblclick'): void {
    this.logger.info(
      source === 'menu' ? 'tree.contextMenu.copyValue' : 'tree.row.doubleClickCopyValue'
    );
    void this.clipboardCopy.copyWithToast(this.serializeNodeValueForCopy(node), {
      success: $localize`:@@tree.contextMenu.copy.success.value:Value copied to clipboard.`,
      failed: $localize`:@@tree.contextMenu.copy.failed.value:Failed to copy value.`,
      unsupported: $localize`:@@tree.contextMenu.copy.unsupported:Copy is not supported in this browser.`
    });
  }

  /**
   * Menu wrapper around the existing `copyPath`. Adds telemetry so
   * we can keep this menu invocation distinct from any future
   * copy-path entry points.
   */
  copyPathFromMenu(node: TreeNode): void {
    this.logger.info('tree.contextMenu.copyPath');
    this.copyPath(node);
  }

  /**
   * Sets up a search whose query is the clicked row's key text and
   * whose scope is keys-only. Per plan.md decisions:
   *   - Q-typeFilter: clears `searchValueType` to `'all'` so the
   *     clicked row isn't filtered out of the result set.
   *   - Q2: turns `searchRegexMode` off (literal text match) so
   *     keys with regex metachars don't surprise users.
   *   - Q-activeHit: makes the clicked row the active hit if it
   *     ended up in the result set; falls back to first hit otherwise.
   *
   * Each pref change is a write-through to `PreferencesService`,
   * matching the pattern used by `setSearchScope`.
   */
  searchByKey(node: TreeNode): void {
    if (node.segment === undefined) return;
    this.logger.info('tree.contextMenu.searchByKey');
    this.prefs.update({
      searchScope: 'keys',
      searchRegexMode: false,
      searchValueType: 'all'
    });
    this.search.set(String(node.segment));
    this.activateClickedHitOrFirst(node.pathString);
  }

  /**
   * Like `searchByKey`, but for the row's value. Hidden in the
   * template for containers, `null`, and `undefined` (caller should
   * check `showSearchByValue` before invoking).
   */
  searchByValue(node: TreeNode): void {
    if (
      node.type === 'object' ||
      node.type === 'array' ||
      node.type === 'null' ||
      node.type === 'undefined'
    ) {
      return;
    }
    this.logger.info('tree.contextMenu.searchByValue');
    // Strings need to be unquoted: renderLeaf wraps them in JSON quotes
    // for display, but the search engine matches against the raw value,
    // so we feed it the raw string here too.
    const query =
      node.type === 'string'
        ? (node.value as string)
        : this.renderLeaf(node.value, node.type);
    this.prefs.update({
      searchScope: 'values',
      searchRegexMode: false,
      searchValueType: 'all'
    });
    this.search.set(query);
    this.activateClickedHitOrFirst(node.pathString);
  }

  /**
   * Collapses the clicked node and all expanded containers within its
   * subtree. Caller should guard with `showCollapse(node)` (we early-out
   * harmlessly when there are no children).
   */
  collapseFromHere(node: TreeNode): void {
    if (!node.children?.length) return;
    this.logger.info('tree.contextMenu.collapse');
    const walk = (c: TreeNode): void => {
      if (!c.children?.length) return;
      this.treeControl.collapse(c);
      for (const child of c.children) walk(child);
    };
    walk(node);
  }

  /**
   * Expands the clicked node and every container in its subtree.
   * Caller should guard with `showExpandAllFromHere(node)`.
   */
  expandAllFromHere(node: TreeNode): void {
    if (!node.children?.length) return;
    this.logger.info('tree.contextMenu.expandAllFromHere');
    const walk = (c: TreeNode): void => {
      if (!c.children?.length) return;
      this.treeControl.expand(c);
      for (const child of c.children) walk(child);
    };
    walk(node);
  }

  /**
   * Expands every collapsed container in the subtree rooted at `node`
   * whose relative depth from `node` is `< relativeDepth`. Never
   * collapses anything: the action is purely additive, so calling it
   * twice is idempotent.
   *
   * The clicked node itself is at relative depth 0, so any `N >= 1`
   * will expand it if it is collapsed.
   *
   * Telemetry includes the relative depth as a prop so we can analyze
   * which depths users invoke most often.
   */
  expandToDepthFromHere(node: TreeNode, relativeDepth: number): void {
    if (!node.children?.length) return;
    this.logger.info('tree.contextMenu.expandToDepth', { relativeDepth });
    const walk = (c: TreeNode, d: number): void => {
      if (!c.children?.length) return;
      if (d >= relativeDepth) return;
      if (!this.treeControl.isExpanded(c)) {
        this.treeControl.expand(c);
      }
      for (const child of c.children) walk(child, d + 1);
    };
    walk(node, 0);
  }

  // ---- Visibility predicates (template @if guards) ----

  showCopyKey(node: TreeNode): boolean {
    return node.segment !== undefined;
  }

  showCopyValue(_node: TreeNode): boolean {
    return true;
  }

  showSearchByKey(node: TreeNode): boolean {
    return !this.embeddedMode() && node.segment !== undefined;
  }

  showSearchByValue(node: TreeNode): boolean {
    if (this.embeddedMode()) return false;
    return (
      node.type !== 'object' &&
      node.type !== 'array' &&
      node.type !== 'null' &&
      node.type !== 'undefined'
    );
  }

  showCollapse(node: TreeNode): boolean {
    return !!node.children?.length && this.treeControl.isExpanded(node);
  }

  showExpandAllFromHere(node: TreeNode): boolean {
    return !!node.children?.length && !this.isFullyExpanded(node);
  }

  /**
   * Whether the "Expand to depth +N from here" item should be visible
   * for the given node. Visible iff:
   * 1. `relativeDepth <= maxDescendantDepth(node)` -- there is something
   *    in the subtree at relative depth `>= relativeDepth` that the
   *    item could ultimately reveal, AND
   * 2. there is at least one container at relative depth `< N`
   *    anywhere in the subtree (including under collapsed ancestors)
   *    that is currently collapsed -- i.e., `+N` would actually expand
   *    something.
   *
   * Both clauses together hide redundant entries (Bug 1: `+N` beyond
   * subtree depth) and entries that have nothing left to do
   * (Bug 2: subtree already expanded to `>= N` levels).
   */
  showExpandToDepth(node: TreeNode, relativeDepth: number): boolean {
    if (!node.children?.length) return false;
    if (relativeDepth > this.maxDescendantDepth(node)) return false;
    return this.hasCollapsedContainerAboveDepth(node, relativeDepth);
  }

  /**
   * Smart-visibility: shows a single "Isolate" item when the wide and
   * narrow actions would produce the same end state (one of `narrowSet`
   * or `widerSet` is empty but not both). Pair with `showIsolatePair`
   * which fires when both sets are non-empty (a real choice between
   * distinct outcomes). The two predicates are mutually exclusive; both
   * return `false` when there is nothing to collapse, when the clicked
   * row is the root, or when the path no longer resolves in the
   * current model.
   */
  showIsolateSingle(node: TreeNode): boolean {
    const result = this.resolveChainAndSets(node);
    if (!result) return false;
    const hasNarrow = result.narrowSet.length > 0;
    const hasWider = result.widerSet.length > 0;
    return hasNarrow !== hasWider;
  }

  showIsolatePair(node: TreeNode): boolean {
    const result = this.resolveChainAndSets(node);
    if (!result) return false;
    return result.narrowSet.length > 0 && result.widerSet.length > 0;
  }

  /**
   * Wide isolate: collapses every visibly-expanded container that is
   * not on the ancestor chain from the root to the clicked row. The
   * ancestor chain and the clicked row's own subtree expansion state
   * are unchanged. Hidden expanded state under newly-collapsed
   * off-chain branches is preserved (standard CDK FlatTree behavior).
   *
   * `source` distinguishes telemetry between the unified single-item
   * case (`'single'`) and the wide-of-pair case (`'wide'`) so we can
   * measure the wide-vs-narrow split when users actually have a
   * choice.
   */
  isolateRow(node: TreeNode, source: 'single' | 'wide'): void {
    const result = this.resolveChainAndSets(node);
    if (!result) return;
    for (const child of result.narrowSet) {
      this.treeControl.collapse(child);
    }
    for (const child of result.widerSet) {
      this.treeControl.collapse(child);
    }
    this.logger.info(
      source === 'wide' ? 'tree.contextMenu.isolateWide' : 'tree.contextMenu.isolate'
    );
  }

  /**
   * Narrow isolate: collapses only the visibly-expanded peers under
   * the clicked row's immediate parent. Off-chain branches at higher
   * ancestors are left alone.
   */
  collapseSiblings(node: TreeNode): void {
    const result = this.resolveChainAndSets(node);
    if (!result) return;
    for (const child of result.narrowSet) {
      this.treeControl.collapse(child);
    }
    this.logger.info('tree.contextMenu.isolateNarrow');
  }

  /**
   * Re-resolves the clicked node from the current root data model by
   * walking `node.path` segment-by-segment with strict equality (no
   * string coercion - object keys are `string` and array indices are
   * `number`, and the lookup must not conflate them). No `TreeNode`
   * identity coupling - the model may have rebuilt while the menu was
   * open. Returns `null` if lookup fails or `node` is the root.
   *
   * On success returns the ancestor `chain` (`[root, ..., resolved
   * node]`), the `narrowSet` (off-chain visibly-expanded children of
   * the parent), and the `widerSet` (off-chain visibly-expanded
   * children at every higher ancestor). Both sets contain only
   * containers whose own `treeControl.isExpanded()` is `true`.
   */
  private resolveChainAndSets(node: TreeNode): {
    chain: TreeNode[];
    narrowSet: TreeNode[];
    widerSet: TreeNode[];
  } | null {
    if (node.path.length === 0) return null;
    const root = this.root();
    if (!root) return null;

    const chain: TreeNode[] = [root];
    let cursor: TreeNode = root;
    for (const segment of node.path) {
      const child = cursor.children?.find((c) => c.segment === segment);
      if (!child) return null;
      chain.push(child);
      cursor = child;
    }

    const narrowSet: TreeNode[] = [];
    const widerSet: TreeNode[] = [];
    const parentIndex = chain.length - 2;
    for (let i = 0; i < chain.length - 1; i++) {
      const ancestor = chain[i];
      const nextChainNode = chain[i + 1];
      if (!ancestor || !nextChainNode) continue;
      const nextSegment = nextChainNode.segment;
      for (const child of ancestor.children ?? []) {
        if (child.segment === nextSegment) continue;
        if (!this.treeControl.isExpanded(child)) continue;
        if (i === parentIndex) {
          narrowSet.push(child);
        } else {
          widerSet.push(child);
        }
      }
    }
    return { chain, narrowSet, widerSet };
  }

  // ---- Helpers ----

  /**
   * Serializes a node's value for the clipboard. Primitives stringify
   * via `String(...)` (raw text - no JSON quoting for strings). Containers
   * stringify as 2-space pretty JSON via `JSON.stringify`.
   */
  private serializeNodeValueForCopy(node: TreeNode): string {
    switch (node.type) {
      case 'string':
        return node.value as string;
      case 'number':
      case 'boolean':
        return String(node.value);
      case 'null':
        return 'null';
      case 'undefined':
        return 'undefined';
      case 'array':
      case 'object':
      default:
        return JSON.stringify(node.value, null, 2);
    }
  }

  /**
   * True when every container in the subtree rooted at `node` is
   * currently expanded. Drives "Expand all from here" visibility.
   */
  private isFullyExpanded(node: TreeNode): boolean {
    let allExpanded = true;
    const walk = (c: TreeNode): void => {
      if (!allExpanded) return;
      if (!c.children?.length) return;
      if (!this.treeControl.isExpanded(c)) {
        allExpanded = false;
        return;
      }
      for (const child of c.children) walk(child);
    };
    walk(node);
    return allExpanded;
  }

  /**
   * Length of the longest path from `node` down to any descendant,
   * counting edges. Drives the cap on visible "Expand to depth +N"
   * entries so we never offer an `+N` deeper than the subtree
   * actually goes.
   *
   * Counts every descendant -- containers AND primitive leaves --
   * because the deepest revealed thing might be a primitive under
   * the deepest container, and `+(maxContainerDepth + 1)` is needed
   * to actually reveal it.
   *
   * Returns 0 when `node` has no children.
   */
  private maxDescendantDepth(node: TreeNode): number {
    let max = 0;
    const walk = (c: TreeNode, d: number): void => {
      if (d > max) max = d;
      if (!c.children?.length) return;
      for (const child of c.children) walk(child, d + 1);
    };
    walk(node, 0);
    return max;
  }

  /**
   * True when at least one container at relative depth strictly less
   * than `relativeDepth` (anywhere in the subtree, including hidden
   * under a collapsed ancestor) is currently collapsed -- i.e.,
   * `+relativeDepth` has at least one container to expand.
   *
   * Walks the entire subtree (not just the visible portion) because
   * `expandToDepthFromHere` itself walks the whole subtree -- the
   * visibility check has to match the action's reach.
   */
  private hasCollapsedContainerAboveDepth(
    node: TreeNode,
    relativeDepth: number
  ): boolean {
    let found = false;
    const walk = (c: TreeNode, d: number): void => {
      if (found) return;
      if (!c.children?.length) return;
      if (d < relativeDepth && !this.treeControl.isExpanded(c)) {
        found = true;
        return;
      }
      if (d + 1 < relativeDepth) {
        for (const child of c.children) walk(child, d + 1);
      }
    };
    walk(node, 0);
    return found;
  }

  /**
   * After a search-by-key/value completes, sets the active hit to the
   * clicked row when it landed in the result set; otherwise falls back
   * to the first hit (or `-1` when there are no hits at all).
   *
   * Deferred via `queueMicrotask` because the existing reset-to-0
   * effect (which tracks `searchHitPaths`) is itself scheduled on the
   * microtask queue when our `prefs.update` / `search.set` calls
   * mark `searchHitPaths` dirty. By queueing our update *after* that
   * signal write, our microtask runs later in FIFO order and our
   * value wins the race. Without this, the effect would clobber our
   * set back to `0` after we returned.
   */
  private activateClickedHitOrFirst(clickedPath: string): void {
    queueMicrotask(() => {
      const paths = this.searchHitPaths();
      if (paths.length === 0) {
        this.activeHitIndex.set(-1);
        return;
      }
      const idx = paths.indexOf(clickedPath);
      const next = idx >= 0 ? idx : 0;
      this.activeHitIndex.set(next);
      const target = paths[next] as string;
      this.selectedPath.set(target);
      this.revealHit(target);
    });
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
   * Memoized rule-engine evaluator for the current set of default rule
   * sets. Recomputes (and resets the cache) only when
   * `ruleSets.defaultRuleSets()` changes - i.e. when the user toggles a
   * set on/off OR when one of those sets' `version` changes after a
   * save elsewhere. Unrelated tree updates (selection, search, expand)
   * do NOT invalidate the cache.
   *
   * The cache key collapses two leaves to the same entry only when
   * their inputs to the engine are identical: same key (or both null
   * for root/array elements), same unquoted display text, same
   * container-ness. That is exactly the surface the engine reads, so
   * collisions are correctness-preserving.
   *
   * Returns `EMPTY_RULE_RESULT` (frozen sentinel) by identity when no
   * default sets are configured, which lets callers short-circuit
   * cheaply on the no-formatting path.
   */
  private readonly evaluateNode = computed<(node: TreeNode) => RuleEngineResult>(() => {
    const override = this.overrideRuleSets();
    const sets = override ?? this.ruleSets.defaultRuleSets();
    if (sets.length === 0) {
      return () => EMPTY_RULE_RESULT;
    }
    const cache = new Map<string, RuleEngineResult>();
    return (node: TreeNode): RuleEngineResult => {
      const engineNode = this.toEngineNode(node);
      // Cache key explicitly delimits the three components so two
      // distinct (key, valueText) pairs cannot collide via accidental
      // concatenation. The unit separator (\u001f) is JSON-illegal, so
      // it cannot appear inside `key` or `valueText`.
      const cacheKey = `${engineNode.key ?? '\u0000'}\u001f${engineNode.valueText ?? '\u0000'}\u001f${engineNode.isContainer ? '1' : '0'}`;
      let cached = cache.get(cacheKey);
      if (!cached) {
        cached = evaluateFormattingRules(sets, engineNode);
        cache.set(cacheKey, cached);
      }
      return cached;
    };
  });

  /**
   * Tree node -> engine node, enforcing the F8 contract: `valueText` is
   * the **unquoted, normalized display text** for leaf values. Strings
   * are passed through raw (no JSON.stringify quoting), numbers /
   * booleans are stringified, null becomes `'null'`. Container nodes
   * carry `valueText: null` and `isContainer: true` so the engine can
   * skip value-target rules without having to re-detect them.
   *
   * The root and array elements have `key: null`. Object-member keys
   * arrive as the literal string segment.
   */
  private toEngineNode(node: TreeNode): RuleEngineNode {
    const isContainer = node.type === 'object' || node.type === 'array';
    let valueText: string | null = null;
    if (!isContainer) {
      switch (node.type) {
        case 'string':
          valueText = node.value as string;
          break;
        case 'number':
        case 'boolean':
          valueText = String(node.value);
          break;
        case 'null':
          valueText = 'null';
          break;
        default:
          valueText = null;
          break;
      }
    }
    const key = typeof node.segment === 'string' ? node.segment : null;
    return { key, valueText, isContainer };
  }

  /**
   * Public engine result for a node. Used by the template to project
   * inline styles and to render matched-rule tooltips.
   */
  ruleResultFor(node: TreeNode): RuleEngineResult {
    return this.evaluateNode()(node);
  }

  /**
   * Build the inline `style` object for a tree row from the engine
   * result. Returns `null` for the no-format case so Angular's `[style]`
   * binding clears any previous values (Angular treats `null` as "no
   * style applied"). Only properties the engine actually set are
   * emitted - leaving e.g. `--tree-key-weight` undefined falls back to
   * the legacy `600` default in the SCSS.
   */
  ruleStyleVars(node: TreeNode): Record<string, string> | null {
    const result = this.ruleResultFor(node);
    if (result === EMPTY_RULE_RESULT) return null;
    const out: Record<string, string> = {};
    if (result.rowStyle.backgroundColor) {
      out['--tree-row-format-bg'] = result.rowStyle.backgroundColor;
    }
    if (result.rowStyle.borderColor) {
      out['--tree-row-format-border'] = result.rowStyle.borderColor;
    }
    const k = result.keyStyle;
    if (k.color) out['--tree-key-color'] = k.color;
    if (k.bold !== undefined) out['--tree-key-weight'] = k.bold ? '700' : '400';
    if (k.italic !== undefined) out['--tree-key-style'] = k.italic ? 'italic' : 'normal';
    if (k.underline !== undefined) {
      out['--tree-key-decoration'] = k.underline ? 'underline' : 'none';
    }
    const v = result.valueStyle;
    if (v.color) out['--tree-value-color'] = v.color;
    if (v.bold !== undefined) out['--tree-value-weight'] = v.bold ? '700' : '400';
    if (v.italic !== undefined) out['--tree-value-style'] = v.italic ? 'italic' : 'normal';
    if (v.underline !== undefined) {
      out['--tree-value-decoration'] = v.underline ? 'underline' : 'none';
    }
    return Object.keys(out).length === 0 ? null : out;
  }

  /** Engine-supplied icon for the matched key side, or null. */
  keyIcon(node: TreeNode): FormattingIcon | null {
    return this.ruleResultFor(node).keyStyle.icon ?? null;
  }

  /** Engine-supplied icon for the matched value side, or null. */
  valueIcon(node: TreeNode): FormattingIcon | null {
    return this.ruleResultFor(node).valueStyle.icon ?? null;
  }

  /**
   * Tooltip text listing the rule-set + rule labels that styled this
   * row, joined by newlines. Returns `null` when nothing matched so
   * the binding does not emit an empty `title=""` attribute.
   */
  matchedRuleTitle(node: TreeNode): string | null {
    const result = this.ruleResultFor(node);
    if (result.matchedRules.length === 0) return null;
    return result.matchedRules.map((r) => r.label).join('\n');
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
      const count = (node.value as unknown[]).length;
      return `[ ${count === 0 ? '' : '...'} ]`;
    }
    if (node.type === 'object') {
      const keys = Object.keys(node.value as Record<string, unknown>);
      return `{ ${keys.length === 0 ? '' : '...'} }`;
    }
    return '';
  }

  containerCountText(node: TreeNode): string {
    if (node.type === 'array') {
      const count = (node.value as unknown[]).length;
      return count === 1 ? '1 item' : `${count} items`;
    }
    if (node.type === 'object') {
      const count = Object.keys(node.value as Record<string, unknown>).length;
      return count === 1 ? '1 key' : `${count} keys`;
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
      return value.map((child, index) => this.buildNode(index, child, [...parentPath, index]));
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      return Object.keys(obj).map((key) => this.buildNode(key, obj[key], [...parentPath, key]));
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
