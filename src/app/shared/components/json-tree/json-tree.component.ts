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
  viewChildren,
  type WritableSignal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatMenuTrigger } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatTreeModule, MatTreeNestedDataSource } from '@angular/material/tree';
import { MatDividerModule } from '@angular/material/divider';
import { NestedTreeControl } from '@angular/cdk/tree';
import { ClipboardCopyService } from '../../../core/clipboard/clipboard-copy.service';
import { PreferencesService } from '../../../core/preferences/preferences.service';
import { bucketColorHex } from '../../../core/preferences/pref-summarize';
import { CommentBundle, JsonParserService } from '../../../core/json/json-parser.service';
import type { ExtractedJson } from '../../../core/json/json-extractor.service';
import { RuleSetsService } from '../../../core/api/rule-sets.service';
import { LoggerService } from '../../../core/telemetry/logger.service';
import { bucketCount, bucketLineCount } from '../../../core/telemetry/buckets';
import { isColdAndMark } from '../../../core/telemetry/cold-flag';
import type { BlobHighlight, FormattingIcon, FormattingRuleSet } from '../../../core/api/models';
import { jsonTypeOf, JsonValueType } from '../../pipes/json-type.pipe';
import { IconComponent, type JjIconName } from '../icon/icon.component';
import { JJ_MENU_IMPORTS } from '../../material/jj-menu-imports';
import {
  JsonBreadcrumbComponent,
  type BreadcrumbClick,
  type BreadcrumbContextMenu,
  type BreadcrumbCrumb,
} from '../json-breadcrumb/json-breadcrumb.component';
import {
  EMPTY_RULE_RESULT,
  RuleEngineNode,
  RuleEngineResult,
  evaluateFormattingRules,
} from './formatting-rules-engine';
import { ParsedDate, formatDateAnnotation, parseAsDate } from '../../utils/date-detect';
import { classifyJsonValue, isJsonValueEmpty } from '../../utils/formatting-value-kind';
import { classifyValue, ValueClassification } from '../../utils/value-classifier';
import { computeAutoFitDepth } from './auto-fit-depth';
import { findNearestCascade, indexHighlights, resolveManualHighlight } from './highlight-resolver';
import type { ResolvedHighlight } from './highlight-resolver';
import {
  HIGHLIGHT_PALETTE_DARK,
  HIGHLIGHT_PALETTE_LIGHT,
  contrastText,
  type PaletteSwatch,
} from './highlight-palette';
import { findScrollableAncestor } from './scroll-container';
import { EMPTY_BEACON_INDEX, buildBeaconIndex, type BeaconIndex } from './formatting-beacons-index';
import { BeaconNavigationService } from '../../../core/beacons/beacon-navigation.service';

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
  'object',
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
  undefined: $localize`:@@tree.type.undefined:undefined`,
};

export interface TreeNode {
  segment: string | number | undefined;
  path: (string | number)[];
  pathString: string;
  value: unknown;
  type: JsonValueType;
  depth: number;
  children?: TreeNode[];
}

export interface TreeExtractRequest {
  path: (string | number)[];
  sourceVersion: number;
  replacement: ExtractedJson;
  source: 'rowButton' | 'contextMenu';
}

interface TreeBuildCounter {
  nodeCount: number;
}

interface ManualHighlightRows {
  resolvedHighlightsByPath: ReadonlyMap<string, ResolvedHighlight>;
  cascadeHighlightsByPath: ReadonlyMap<string, { path: string; color: string }>;
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
const TREE_BUILD_SLOW_THRESHOLD_MS = 100;
const TREE_RENDER_SLOW_THRESHOLD_MS = 200;
const TREE_EXPAND_SLOW_THRESHOLD_MS = 50;

/**
 * Frozen empty-array sentinel returned by `keyIcons` / `valueIcons`
 * when the engine projects no icons. Identity-shared so `OnPush`
 * change detection treats unchanged rows as equal.
 */
const EMPTY_ICONS: readonly FormattingIcon[] = Object.freeze([]);

/**
 * Interactive tree viewer for parsed JSON, built on Angular Material's
 * mat-tree (nested variant). JsonParserService is the source of the value.
 */
@Component({
  selector: 'jj-json-tree',
  standalone: true,
  imports: [
    FormsModule,
    ...JJ_MENU_IMPORTS,
    MatTooltipModule,
    MatTreeModule,
    MatDividerModule,
    IconComponent,
    JsonBreadcrumbComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './json-tree.component.html',
  styleUrls: ['./json-tree.component.scss', './json-tree-highlights.scss'],
})
export class JsonTreeComponent {
  private readonly prefs = inject(PreferencesService);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);
  private readonly clipboardCopy = inject(ClipboardCopyService);
  private readonly jsonParser = inject(JsonParserService);
  private readonly ruleSets = inject(RuleSetsService);
  private readonly logger = inject(LoggerService);
  private readonly beaconNav = inject(BeaconNavigationService);

  readonly value = input<unknown>(undefined);
  readonly viewResetToken = input<number>(0);
  readonly highlights = input<readonly BlobHighlight[]>([]);
  readonly canEditHighlights = input<boolean>(false);

  /**
   * M6d-3 preview hook. When non-null, this list of rule sets replaces
   * `ruleSets.activeRuleSets()` for THIS component instance only - no
   * shared service state is mutated. Used by the rule editor's live
   * preview to render the in-progress draft without saving.
   *
   * Semantics:
   *  - `null` / unset (default): fall back to `activeRuleSets()`
   *    (existing behavior, preserved).
   *  - `[]`: no rule sets active. Tree renders plain (no highlighting).
   *  - `[set, ...]`: those exact rule sets are evaluated, in order.
   *
   * Reactive via signal-based input: assigning a new array re-evaluates
   * `evaluateNode` automatically.
   */
  readonly overrideRuleSets = input<FormattingRuleSet[] | null>(null);

  /**
   * JSONC comments harvested from the source text, grouped by the
   * canonical path string of the node they attach to (e.g. `$.foo[0]`).
   * Threaded through from the parser so the tree never has to look at
   * the raw text.
   *
   * `null` (default) means no comment data is available - the tree
   * renders without comment slots. The rule-editor live preview
   * intentionally omits this input so formatting-rule effects are not
   * obscured by editorial annotations.
   *
   * For container nodes, `bundle.trailing` is rendered on the
   * container's open row (mirroring the leaf-row trailing slot) and
   * `bundle.closeTrailing` is rendered on the close row. Empty
   * containers, which render as a single inline row, fall back to
   * `closeTrailing` when `trailing` is absent so a `// tail`
   * comment after `"foo": {}` still surfaces. See `CommentBundle`
   * and DESIGN_SPEC.md M7k.
   */
  readonly commentsByPath = input<ReadonlyMap<string, CommentBundle> | null>(null);

  readonly extractCandidates = input<ReadonlyMap<string, ExtractedJson> | null>(null);
  readonly extractSourceVersion = input<number | null>(null);

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
   * M7g-3b. Path of the row that currently owns the keyboard cursor
   * (roving `tabindex=0`), or `null` when no row is focusable yet
   * (empty tree or pre-initial-focus). Decoupled from `selectedPath`
   * because the WAI-ARIA Tree pattern distinguishes the two: the
   * focused row is the keyboard cursor target; the selected row is
   * the user's chosen value. Pointer click sets BOTH (so a click +
   * ArrowDown moves from the just-clicked row); keyboard Enter / Space
   * sets `selectedPath` from `focusedPath`. Search-Enter updates
   * `focusedPath` silently without calling DOM `focus()` (the search
   * input keeps focus so repeated Enter / Shift+Enter cycle hits).
   */
  readonly focusedPath = signal<string | null>(null);

  /**
   * M7g-3b. Bumped on every `treeControl.expansionModel.changed`
   * emission so `computed()` signals can register a dependency on
   * "any expand/collapse occurred" without subscribing themselves.
   * Catches every expansion path (direct `treeControl.toggle`,
   * `matTreeNodeToggle` clicks, `expandAll` / `collapseAll` /
   * `expandToLevel` / `expandAndScroll`, and the initial auto-fit
   * expansion) because they all flow through `expansionModel`.
   */
  private readonly expansionVersion = signal(0);

  /**
   * Context-menu state (M7q). `contextNode` is the row whose menu is
   * currently open (or about to open). `ctxX` / `ctxY` carry the cursor
   * coordinates for the right-click flow; the kebab flow self-anchors
   * via its own `MatMenuTrigger` so these stay at 0 in that case.
   * Mouse-only in v1: keyboard-fired contextmenu (`clientX/Y === 0`)
   * is ignored in `onRowContextMenu`.
   */
  readonly contextNode = signal<TreeNode | null>(null);
  private readonly contextIsCloseRow = signal(false);
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
   * All `MatMenuTrigger` directives in the component view: the right-click
   * anchor (`ctxTrigger`), every per-row kebab button, the parent
   * "Highlight" / "Highlight tree" submenu triggers, and the toolbar
   * scope/type/expand triggers. Used by `closeHighlightMenuChain` to
   * dismiss the entire chain after a highlight is applied without
   * needing to know exactly which trigger opened the row menu.
   *
   * The toolbar triggers are inert during a highlight context-menu
   * interaction (their `.menuOpen` is false), so iterating them is
   * harmless; we only call `closeMenu()` on triggers whose `.menuOpen`
   * is currently true.
   */
  readonly allMatMenuTriggers = viewChildren(MatMenuTrigger);

  /**
   * Hidden offscreen probe row used to measure the rendered row
   * height for the auto-fit-to-window initial expansion. Sits inside
   * `.tree-body` so it inherits the same `--tree-font-size` and base
   * row CSS as real rows. Required only when
   * `treeAutoFitToWindow` is on; harmless otherwise.
   */
  private readonly autoFitProbe = viewChild<ElementRef<HTMLElement>>('autoFitProbe');

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
  readonly extractRequest = output<TreeExtractRequest>();
  readonly highlightsChange = output<BlobHighlight[]>();

  readonly expandLabel = $localize`:@@tree.node.expand:Expand`;
  readonly collapseLabel = $localize`:@@tree.node.collapse:Collapse`;

  readonly treeAriaLabel = $localize`:@@tree.aria:JSON tree`;

  readonly expandMenuButtonLabel = $localize`:@@tree.expand.menu.button:Expand to...`;
  readonly matchingValueAriaLabel = $localize`:@@tree.matchValue.aria:Matches the selected value`;

  readonly searchCaseSensitiveLabel = $localize`:@@tree.search.caseSensitive.label:Aa`;
  readonly searchCaseSensitiveTooltip = $localize`:@@tree.search.caseSensitive.tooltip:Match case`;
  readonly searchRegexLabel = $localize`:@@tree.search.regex.label:.*`;
  readonly searchRegexTooltip = $localize`:@@tree.search.regex.tooltip:Regular expression`;
  readonly searchScopeTooltip = $localize`:@@tree.search.scope.tooltip:Find in`;
  readonly searchScopeKeysLabel = $localize`:@@tree.search.scope.keys:Keys`;
  readonly searchScopeValuesLabel = $localize`:@@tree.search.scope.values:Values`;
  readonly searchScopeBothLabel = $localize`:@@tree.search.scope.both:Keys and values`;
  readonly searchValueTypeTooltip = $localize`:@@tree.search.type.tooltip:Filter by value type`;
  readonly searchValueTypeAllLabel = $localize`:@@tree.search.type.all:All types`;
  readonly searchPrevTooltip = $localize`:@@tree.search.prev.tooltip:Previous match`;
  readonly searchNextTooltip = $localize`:@@tree.search.next.tooltip:Next match`;

  // Context menu labels (M7q + tree-menu-overhaul). Stored as readonly
  // fields so $localize sees the literal at extract time and the
  // template can bind to them without re-evaluating per render.
  readonly ctxCopyKeyLabel = $localize`:@@tree.contextMenu.copyKey:Copy key`;
  readonly ctxCopyValueLabel = $localize`:@@tree.contextMenu.copyValue:Copy value`;
  readonly ctxCopyPathLabel = $localize`:@@tree.contextMenu.copyPath:Copy path`;
  // i18n IDs stable per AGENTS.md §4: source text changed from
  // "Search by key" / "Search by value" to "Find by key" / "Find by
  // value" but the message IDs continue to read `searchByKey` /
  // `searchByValue`. TS method names also changed (Phase 2) but
  // telemetry IDs stay stable to preserve KQL continuity.
  readonly ctxFindByKeyLabel = $localize`:@@tree.contextMenu.searchByKey:Find by key`;
  readonly ctxFindByValueLabel = $localize`:@@tree.contextMenu.searchByValue:Find by value`;
  // Surfaced default-shortcut row (top-level): label depends on row
  // state (see `surfacedShortcutLabel` below). The "Collapse from
  // here" reading carries the spec's §513 wording at top level; the
  // in-Subtree variant drops "from here" because the submenu name
  // already carries the scope.
  readonly ctxCollapseFromHereLabel = $localize`:@@tree.contextMenu.collapse:Collapse from here`;
  readonly ctxExpand1LevelLabel = $localize`:@@tree.contextMenu.expand1Level:Expand 1 level`;
  // Surfaced row tooltip removed in v0.19.1 polish: the matTooltip
  // overlay was rendering below the bolded item and obscuring the
  // next menu row, making clicks on adjacent items difficult. Bold
  // styling alone is the signal for the dblclick-equivalent action.
  // Subtree submenu (Path Y). Trigger label and items inside drop the
  // "from here" / "subtree" suffix because the submenu name carries
  // the scope.
  readonly ctxSubtreeMenuLabel = $localize`:@@tree.contextMenu.subtreeMenu:Subtree`;
  readonly ctxSubtreeCollapseLabel = $localize`:@@tree.contextMenu.subtreeCollapse:Collapse`;
  readonly ctxSubtreeExpandMenuLabel = $localize`:@@tree.contextMenu.subtreeExpandMenu:Expand`;
  readonly ctxSubtreeExpandAllLabel = $localize`:@@tree.contextMenu.expandAllFromHere:All`;
  // Per-depth labels inside the Subtree -> Expand submenu. Source text
  // uses the "+N level(s)" form per DESIGN_SPEC.md §516 (relative,
  // expand-only) -- distinct from the toolbar's snap-to-exact dropdown.
  readonly ctxExpandToDepth1Label = $localize`:@@tree.contextMenu.expandToDepth.1:+1 level`;
  readonly ctxExpandToDepth2Label = $localize`:@@tree.contextMenu.expandToDepth.2:+2 levels`;
  readonly ctxExpandToDepth3Label = $localize`:@@tree.contextMenu.expandToDepth.3:+3 levels`;
  readonly ctxExpandToDepth4Label = $localize`:@@tree.contextMenu.expandToDepth.4:+4 levels`;
  readonly ctxExpandToDepth5Label = $localize`:@@tree.contextMenu.expandToDepth.5:+5 levels`;
  // Spec terms preserved per DESIGN_SPEC.md §514. Renaming would lose
  // the precise `narrowSet` / `widerSet` semantics.
  readonly ctxIsolateLabel = $localize`:@@tree.contextMenu.isolate:Isolate`;
  readonly ctxCollapseSiblingsLabel = $localize`:@@tree.contextMenu.collapseSiblings:Collapse siblings`;
  // Single-row "Highlight" stays at top level. Subtree-scope
  // "Highlight" lives inside the Subtree submenu. Source text changed
  // from "Highlight tree" to "Highlight" since the submenu name
  // already conveys the subtree scope; i18n IDs stay stable.
  readonly ctxHighlightLabel = $localize`:@@tree.contextMenu.highlight:Highlight`;
  readonly ctxHighlightTreeLabel = $localize`:@@tree.contextMenu.highlightTree:Highlight`;
  readonly ctxRemoveHighlightLabel = $localize`:@@tree.contextMenu.removeHighlight:Remove highlight`;
  readonly ctxRemoveTreeHighlightLabel = $localize`:@@tree.contextMenu.removeTreeHighlight:Remove highlight`;
  readonly preferredHighlightLabel = $localize`:@@tree.highlight.swatch.preferred:Preferred`;
  readonly kebabAriaLabel = $localize`:@@tree.kebab.aria:Row actions`;
  readonly kebabTitleLabel = $localize`:@@tree.kebab.title:Row actions`;

  // Decoded toggle (per-row): mirrors the Extract pill but is purely
  // display-only - it does not mutate the underlying value, copy
  // semantics, or search behavior.
  readonly decodedShowTitleLabel = $localize`:@@tree.decoded.button.title.show:Show as decoded text`;
  readonly decodedHideTitleLabel = $localize`:@@tree.decoded.button.title.hide:Show as JSON-escaped string`;
  readonly decodedShowAriaLabel = $localize`:@@tree.decoded.button.aria.show:Show this string as decoded multi-line text`;
  readonly decodedHideAriaLabel = $localize`:@@tree.decoded.button.aria.hide:Show this string as a JSON-escaped single-line string`;
  readonly decodedShowMenuLabel = $localize`:@@tree.decoded.menu.label.show:Show as decoded text`;
  readonly decodedHideMenuLabel = $localize`:@@tree.decoded.menu.label.hide:Show as JSON-escaped string`;

  // Breadcrumb labels (Phase 2). Stable English source strings; i18n
  // IDs feed through the standard pipeline (extract-i18n).
  readonly breadcrumbAriaLabel = $localize`:@@tree.breadcrumb.aria:Breadcrumb`;
  readonly breadcrumbEmptyLabel = $localize`:@@tree.breadcrumb.empty:No current selection`;
  readonly breadcrumbRootLabel = $localize`:@@tree.breadcrumb.root:Root`;
  readonly breadcrumbOverflowAriaLabel = $localize`:@@tree.breadcrumb.overflow.aria:Show hidden ancestors`;
  readonly breadcrumbCopyPathTitle = $localize`:@@tree.breadcrumb.copyPath.title:Copy JSON path`;
  readonly breadcrumbCopyPathAriaLabel = $localize`:@@tree.breadcrumb.copyPath.aria:Copy JSON path of selected row`;

  // M7k. Tooltip prefixes for inline JSONC comment slots. Rendered as
  // `Leading comment: <full text>` / `Trailing comment: <full text>` on
  // hover so screen readers and the visible tooltip body distinguish
  // them from the value's own tooltip.
  readonly leadingCommentTooltipPrefix = $localize`:@@tree.comment.leading.tooltipPrefix:Leading comment: `;
  readonly trailingCommentTooltipPrefix = $localize`:@@tree.comment.trailing.tooltipPrefix:Trailing comment: `;
  readonly closeLeadingCommentTooltipPrefix = $localize`:@@tree.comment.closeLeading.tooltipPrefix:Internal comment: `;
  readonly closeTrailingCommentTooltipPrefix = $localize`:@@tree.comment.closeTrailing.tooltipPrefix:End-of-block comment: `;

  readonly treeControl = new NestedTreeControl<TreeNode, string>((n) => n.children ?? [], {
    trackBy: (n) => n.pathString,
  });
  readonly dataSource = new MatTreeNestedDataSource<TreeNode>();

  /**
   * Last build's node count feeds render-slow telemetry after the
   * double-rAF paint window; it is set only when the memoized root build
   * actually runs.
   */
  private latestBuildNodeCount = 0;

  readonly root = computed<TreeNode | undefined>(() => {
    const raw = this.value();
    if (raw === undefined) {
      this.latestBuildNodeCount = 0;
      return undefined;
    }
    return this.buildRoot(raw);
  });

  private readonly highlightIndex = computed(() => indexHighlights(this.highlights()));

  private readonly manualHighlightRows = computed<ManualHighlightRows>(() => {
    const highlightIndex = this.highlightIndex();
    const resolvedHighlightsByPath = new Map<string, ResolvedHighlight>();
    const cascadeHighlightsByPath = new Map<string, { path: string; color: string }>();
    const walk = (node: TreeNode | undefined): void => {
      if (!node) return;
      const resolvedHighlight = resolveManualHighlight(node.pathString, highlightIndex);
      if (resolvedHighlight) {
        resolvedHighlightsByPath.set(node.pathString, resolvedHighlight);
      }
      if ((node.children?.length ?? 0) > 0) {
        const cascadeHighlight = findNearestCascade(node.pathString, highlightIndex);
        if (cascadeHighlight) {
          cascadeHighlightsByPath.set(node.pathString, cascadeHighlight);
        }
      }
      node.children?.forEach(walk);
    };
    walk(this.root());
    return { resolvedHighlightsByPath, cascadeHighlightsByPath };
  });

  readonly resolvedHighlightsByPath = computed(
    () => this.manualHighlightRows().resolvedHighlightsByPath,
  );

  readonly cascadeHighlightsByPath = computed(
    () => this.manualHighlightRows().cascadeHighlightsByPath,
  );

  readonly activePalette = computed<readonly PaletteSwatch[]>(() =>
    this.prefs.effectiveTheme() === 'dark' ? HIGHLIGHT_PALETTE_DARK : HIGHLIGHT_PALETTE_LIGHT,
  );
  readonly preferredHighlightColor = computed(
    () => this.prefs.prefs().treeHighlightColors[this.prefs.effectiveTheme()].manualHighlightColor,
  );
  readonly preferredHighlightTextColor = computed(() =>
    contrastText(this.preferredHighlightColor()),
  );
  readonly preferredHighlightAriaLabel = computed(() => {
    const hex = this.preferredHighlightColor();
    return $localize`:@@tree.highlight.swatch.preferred.aria:Apply preferred highlight color (${hex}:hex:)`;
  });

  readonly showTypeBadges = computed(() => this.prefs.prefs().treeShowTypeLabels);
  readonly showDateAnnotations = computed(() => this.prefs.prefs().treeShowDateAnnotations);
  /**
   * Master toggle for rendering JSONC comment slots in the tree. Bound
   * to the `treeShowComments` user preference; default true. The
   * `commentsByPath` map is computed regardless - hiding comments is a
   * cheap render-side toggle that doesn't re-trigger the parser.
   */
  readonly showComments = computed(() => this.prefs.prefs().treeShowComments);
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
    () => !!this.search().trim() || this.prefs.prefs().searchValueType !== 'all',
  );

  /**
   * What the row's double-click would do, given the currently-active
   * `contextNode`. Drives the bolded "default action" affordance in
   * the right-click menu (Path Y in the tree-menu overhaul plan):
   *
   *   - `'copyValue'`: dblclick copies (primitives and empty
   *     containers). The bolded item is the always-present "Copy
   *     value" row at the top of the menu -- no separate surfaced
   *     shortcut row.
   *   - `'collapseRow'`: dblclick collapses this row. A surfaced
   *     "Collapse from here" shortcut row appears just above the
   *     `Subtree >` trigger and gets the bold treatment.
   *   - `'expandRow'`: dblclick expands this row. A surfaced
   *     "Expand 1 level" shortcut row appears just above the
   *     `Subtree >` trigger and gets the bold treatment.
   *   - `'none'`: no `contextNode` set yet (menu is closed).
   *
   * The computed reads `expansionVersion()` so any
   * `treeControl.toggle/expand/collapse/expandAll/collapseAll` flow
   * re-evaluates the bolding without requiring components to track
   * the expansionModel directly.
   */
  readonly defaultActionKind = computed<'copyValue' | 'collapseRow' | 'expandRow' | 'none'>(() => {
    const cn = this.contextNode();
    if (!cn) return 'none';
    // Subscribe to expand/collapse changes so the bolded item flips
    // when the row's expansion state changes while the menu is open
    // (rare but possible if user keyboards through).
    this.expansionVersion();
    if ((cn.type === 'object' || cn.type === 'array') && cn.children?.length) {
      return this.treeControl.isExpanded(cn) ? 'collapseRow' : 'expandRow';
    }
    return 'copyValue';
  });

  /**
   * Localized label for the surfaced default-action shortcut row.
   * `null` when no shortcut should be surfaced (primitives / empty
   * containers -- `Copy value` is already at the top of the menu and
   * gets the bold class directly there).
   */
  readonly surfacedShortcutLabel = computed<string | null>(() => {
    switch (this.defaultActionKind()) {
      case 'collapseRow':
        return this.ctxCollapseFromHereLabel;
      case 'expandRow':
        return this.ctxExpand1LevelLabel;
      default:
        return null;
    }
  });

  /**
   * Leading-icon name for the surfaced default-action shortcut row.
   * Mirrors `surfacedShortcutLabel`'s state machine. `null` when no
   * shortcut row is rendered.
   */
  readonly surfacedShortcutIconName = computed<JjIconName | null>(() => {
    switch (this.defaultActionKind()) {
      case 'collapseRow':
        return 'collapse-subtree';
      case 'expandRow':
        return 'expand-subtree';
      default:
        return null;
    }
  });

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
        assumeUtcForIsoDateOnly: prefs.treeAssumeUtcForIsoDateOnly,
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
   * M7g-3b. Visible rows in document order (depth-first walk skipping
   * collapsed subtrees). Drives ArrowUp / ArrowDown / Home / End
   * navigation and the focus-recovery lifecycle effect. Re-evaluates
   * whenever `root()` rebuilds OR `expansionVersion` increments
   * (i.e., any expand/collapse).
   */
  private readonly visibleRowsInOrder = computed<readonly TreeNode[]>(() => {
    this.expansionVersion();
    const rootNode = this.root();
    if (!rootNode) return [];
    const out: TreeNode[] = [];
    const walk = (node: TreeNode): void => {
      out.push(node);
      if (node.children?.length && this.treeControl.isExpanded(node)) {
        for (const child of node.children) walk(child);
      }
    };
    walk(rootNode);
    return out;
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
        current: path.length === 0,
      },
    ];
    // Include the selected node as the final crumb (i = path.length).
    for (let i = 1; i <= path.length; i++) {
      const partial = path.slice(0, i);
      const segment = partial[partial.length - 1];
      const label = typeof segment === 'number' ? `[${segment}]` : String(segment);
      out.push({
        label,
        canonicalPath: this.formatPath(partial),
        current: i === path.length,
      });
    }
    return out;
  });

  /**
   * `true` when the trailing copy-path button on the breadcrumb bar
   * should be disabled. Mirrors "is anything selected?".
   */
  readonly breadcrumbCopyDisabled = computed(() => this.selectedPath() === null);

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
      if (node.pathString !== sp && node.type === targetType && node.value === targetValue) {
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
  private lastObservedResetToken = 0;
  private renderGeneration = 0;
  private cancelledRender = false;

  /**
   * Per-row "show as decoded text" toggle state. A path is in this set
   * iff the user has explicitly opted that row into decoded display.
   * Membership alone is not authoritative: {@link isDecoded} also
   * requires {@link decodedCandidate} to return true, so stale entries
   * for rows whose value has since changed render harmlessly as the
   * normal JSON-escaped form.
   *
   * Cleared on every {@link viewResetToken} bump (blob change). NOT
   * cleared on format-driven reparse so toggling Format/Minify keeps
   * the user's per-row toggle state stable.
   */
  private readonly decodedExpandedPaths = signal<ReadonlySet<string>>(new Set<string>());

  /**
   * Cached probe row height keyed by `treeFontSize`. Invalidated
   * when the user changes the font size. Cheap microreflow once
   * per font size; repeated calls re-use the cached value.
   */
  private probeRowHeightCache: { fontSize: number; heightPx: number } | null = null;

  /**
   * Per-auto-fit-run generation counter used to drop stale post-
   * expand telemetry rAFs when the value changes again before the
   * frame fires. Separate from `renderGeneration` because the two
   * effects (auto-fit and `tree.render.slow`) advance independently.
   */
  private autoFitGeneration = 0;

  /**
   * Test-only override for auto-fit measurement. When set, bypasses
   * DOM probing and viewport resolution so specs can drive the
   * algorithm with deterministic inputs. Production code paths
   * never read or write this. Cleared by destroy.
   */
  private autoFitMeasurementOverrideForTesting: {
    probeHeightPx: number;
    viewportPx: number;
    scrollContainer: HTMLElement | null;
  } | null = null;

  /**
   * Test-only seam for stubbing auto-fit measurement. Production
   * callers must never reference this.
   */
  __setAutoFitMeasurementsForTesting(
    probeHeightPx: number,
    viewportPx: number,
    scrollContainer: HTMLElement | null = null,
  ): void {
    this.autoFitMeasurementOverrideForTesting = {
      probeHeightPx,
      viewportPx,
      scrollContainer,
    };
  }

  constructor() {
    const NOW_TICK_MS = 60_000;
    const handle = setInterval(() => this.nowSignal.set(Date.now()), NOW_TICK_MS);
    this.destroyRef.onDestroy(() => {
      clearInterval(handle);
      this.cancelledRender = true;
    });

    effect(() => {
      const token = this.viewResetToken();
      const rootNode = this.root();
      if (token > 0 && token !== this.lastObservedResetToken) {
        this.lastObservedResetToken = token;
        this.hasInitializedExpansion = false;
        // Blob-change reset: drop any per-row decoded toggle state so
        // a fresh blob never inherits the prior blob's UI mode.
        // Format/Minify reparse does NOT bump viewResetToken, so the
        // user's toggle state is preserved across formatting changes.
        untracked(() => this.decodedExpandedPaths.set(new Set<string>()));
      }
      // Fires for every root or token change; invalidates any in-flight
      // prior-run auto-fit rAF before it can emit stale telemetry.
      this.autoFitGeneration += 1;
      this.dataSource.data = rootNode ? [rootNode] : [];
      if (!rootNode) {
        this.hasInitializedExpansion = false;
        // Use untracked to avoid creating a dependency on selectedPath
        // here - we only want to react to value or token changes.
        untracked(() => this.selectedPath.set(null));
        return;
      }
      if (!this.hasInitializedExpansion) {
        this.hasInitializedExpansion = true;
        if (this.prefs.prefs().treeAutoFitToWindow) {
          this.runAutoFitInitialExpansion();
        } else {
          this.expandToLevel(this.prefs.prefs().defaultTreeExpansionDepth, true);
        }
      }
      // Whenever the underlying value or reset token changes (and the
      // resulting tree root re-renders), drop any stale selection.
      // Predictable, no zombie state.
      untracked(() => this.selectedPath.set(null));
    });

    // Double-rAF waits until the browser has had a chance to commit
    // layout/paint for the value-driven tree update before measuring.
    effect(() => {
      const raw = this.value();
      const generation = ++this.renderGeneration;
      if (raw === undefined) {
        return;
      }
      const start = performance.now();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (this.cancelledRender || generation !== this.renderGeneration) {
            return;
          }
          const timeMs = performance.now() - start;
          if (timeMs > TREE_RENDER_SLOW_THRESHOLD_MS) {
            const nodeCount = this.latestBuildNodeCount;
            this.logger.event(
              'tree.render.slow',
              {
                cold: isColdAndMark('tree.render.slow'),
                nodeCountBucket: bucketCount(nodeCount),
              },
              { timeMs, nodeCount },
            );
          }
        });
      });
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

    // Beacon evaluation telemetry: emit one event per recompute that
    // produced a non-empty index. Skipped when identity-equal to the
    // shared empty sentinel (so trees with no beacons do not log
    // anything on every rule-set toggle).
    effect(() => {
      const index = this.beaconIndex();
      if (index === EMPTY_BEACON_INDEX) return;
      let totalMatches = 0;
      for (const bucket of index.matchesByIcon.values()) {
        totalMatches += bucket.length;
      }
      this.logger.info('beacons.evaluated', {
        iconCount: index.matchesByIcon.size,
        totalMatches,
      });
    });

    // M7g-3b. Track CDK expansion-model changes via a counter signal so
    // computed() (notably visibleRowsInOrder) can register a clean
    // dependency on "any expand/collapse occurred". The subscription
    // lives for the component's lifetime; expansionModel is owned by
    // treeControl (which is owned by this component), so we don't need
    // takeUntilDestroyed - the model is GC'd with the component.
    const expansionSub = this.treeControl.expansionModel.changed.subscribe(() => {
      this.expansionVersion.update((v) => v + 1);
    });
    this.destroyRef.onDestroy(() => expansionSub.unsubscribe());

    // M7g-3b. Lifecycle effect for `focusedPath` recovery. Handles five
    // cases in one place:
    //   1. Empty tree -> clear focus.
    //   2. Initial mount / no focus yet -> pick first visible row.
    //   3. Still visible -> no-op.
    //   4. Hidden by ancestor collapse -> walk up to nearest visible
    //      ancestor.
    //   5. Path no longer exists (JSON re-parse) -> reset to first
    //      visible row.
    // `untracked` writes prevent recursive effect runs.
    effect(() => {
      const visible = this.visibleRowsInOrder();
      const path = this.focusedPath();

      if (visible.length === 0) {
        if (path !== null) untracked(() => this.focusedPath.set(null));
        return;
      }

      if (path === null) {
        const first = visible[0]!;
        untracked(() => this.focusedPath.set(first.pathString));
        return;
      }

      const visibleSet = new Set(visible.map((n) => n.pathString));
      if (visibleSet.has(path)) return;

      // Walk up the path of the (possibly hidden) node to find the
      // nearest currently-visible ancestor.
      const node = this.nodeIndex().get(path);
      if (node) {
        const parts: (string | number)[] = [];
        let recovered: string | null = null;
        for (let i = 0; i < node.path.length; i++) {
          parts.push(node.path[i]!);
          const ancestorPath = this.formatPath(parts);
          if (visibleSet.has(ancestorPath)) recovered = ancestorPath;
        }
        // Root may also be the recovery target (path === '$').
        if (recovered === null && visibleSet.has('$')) recovered = '$';
        if (recovered !== null) {
          const finalRecovered = recovered;
          untracked(() => this.focusedPath.set(finalRecovered));
          return;
        }
      }

      // Path no longer exists in the index at all -- reset to first.
      untracked(() => this.focusedPath.set(visible[0]!.pathString));
    });
  }

  hasChild = (_: number, node: TreeNode): boolean => !!node.children && node.children.length > 0;

  /**
   * Click handler for `.tree-row`. Selects the row unless the click
   * target is an interactive child (twisty toggle, kebab button,
   * etc.) in which case the child's own handler takes precedence.
   *
   * M7g-3b: also moves the keyboard cursor (`focusedPath`) to the
   * clicked row so a subsequent ArrowDown moves from the row the user
   * just clicked, not from a stale "previously focused" row. DOM
   * focus follows automatically because the click already landed on
   * the row element.
   */
  onSelect(node: TreeNode, event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('button, [matTreeNodeToggle], a, input, [role="button"]')) {
      return;
    }
    this.selectedPath.set(node.pathString);
    this.focusedPath.set(node.pathString);
    event.stopPropagation();
  }

  /**
   * M7g-3b. Returns the roving tabindex for a tree node: `0` for the
   * one node that owns the keyboard cursor, `-1` for everyone else.
   * Exactly one tree node has `tabindex=0` at any time (or none if
   * the tree is empty and `focusedPath` is `null`).
   */
  rowTabIndex(node: TreeNode): 0 | -1 {
    return this.focusedPath() === node.pathString ? 0 : -1;
  }

  /**
   * M7g-3b. Returns the 1-based depth used as `aria-level`. A root
   * node sits at level 1 per WAI-ARIA Tree convention.
   */
  nodeAriaLevel(node: TreeNode): number {
    return node.depth + 1;
  }

  /**
   * M7g-3b. Returns 1-based position of `node` among its siblings,
   * suitable for `aria-posinset`. Root is treated as a single-item
   * set ("1 of 1").
   */
  nodePosInSet(node: TreeNode): number {
    if (node.path.length === 0) return 1;
    const parent = this.parentOf(node);
    const siblings = parent?.children ?? [];
    const idx = siblings.indexOf(node);
    return idx >= 0 ? idx + 1 : 1;
  }

  /**
   * M7g-3b. Returns the size of the sibling set this node belongs to,
   * suitable for `aria-setsize`. Root is `1`.
   */
  nodeSetSize(node: TreeNode): number {
    if (node.path.length === 0) return 1;
    const parent = this.parentOf(node);
    return parent?.children?.length ?? 1;
  }

  private parentOf(node: TreeNode): TreeNode | undefined {
    if (node.path.length === 0) return undefined;
    const parentPath = node.path.slice(0, -1);
    return this.nodeIndex().get(this.formatPath(parentPath));
  }

  /**
   * M7g-3b. Updates `focusedPath` and DOM-focuses the matching row
   * after Angular renders the new `tabindex=0`. Defers to
   * `requestAnimationFrame` so the tabindex flip is committed before
   * we call `focus()`.
   */
  private moveFocusTo(path: string | null): void {
    if (path === null) return;
    this.focusedPath.set(path);
    requestAnimationFrame(() => {
      const el = this.host.nativeElement.querySelector(
        `mat-nested-tree-node[data-tree-node-path="${cssEscape(path)}"]`,
      ) as HTMLElement | null;
      el?.focus({ preventScroll: false });
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  /**
   * M7g-3b. Keyboard handler bound on `<mat-nested-tree-node>` (both
   * leaf and container variants). Implements the WAI-ARIA Tree
   * pattern minus type-ahead (deferred to issue #108):
   *
   *  - Arrow Up / Down / Home / End: roving focus through visible
   *    rows.
   *  - Arrow Right on a collapsed container: expands; focus stays.
   *  - Arrow Right on an expanded container: focus -> first child.
   *  - Arrow Right on a leaf: no-op.
   *  - Arrow Left on an expanded container: collapses; focus stays.
   *  - Arrow Left on a collapsed container or a leaf: focus -> parent.
   *  - Enter / Space: select the focused row (mirrors click).
   *  - Shift+F10 / ContextMenu: open the row context menu via the
   *    existing `openContextMenuAt` path, anchored at the row's
   *    bounding rect.
   *  - Ctrl+C / Cmd+C: copy the focused row's value via
   *    `copyValue(node, 'keyboard')`. Works on leaves, containers,
   *    and empty containers ({} / []) alike; never alters expansion
   *    state. Strict modifier match -- Ctrl+Shift+C, Ctrl+Alt+C, and
   *    plain 'c' are intentionally no-ops so we don't fight devtools
   *    or AltGr layouts.
   *
   * Printable characters are intentionally NOT handled; type-ahead
   * (D9 in plan.md / issue #108) is deferred to a follow-up wave so
   * Wave 3b lands only the SERIOUS-bar fixes.
   */
  onTreeKeydown(event: KeyboardEvent, node: TreeNode): void {
    // Only act when the event originated at THIS treeitem. Without
    // this guard, a keydown that bubbles up from a descendant
    // treeitem (or from an interactive descendant like the twisty,
    // kebab, beacon, extract pill, or decoded pill) would run the
    // ancestor's handler too and overwrite the descendant's writes.
    // We compare against `currentTarget` rather than calling
    // `stopPropagation()` so document-level handlers (e.g., Escape)
    // still see the events we don't handle ourselves.
    if (event.currentTarget !== event.target) {
      return;
    }

    const visible = this.visibleRowsInOrder();
    const currentIndex = visible.findIndex((n) => n.pathString === node.pathString);
    const isContainer = !!node.children && node.children.length > 0;
    const isExpanded = isContainer && this.treeControl.isExpanded(node);

    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        if (currentIndex >= 0 && currentIndex < visible.length - 1) {
          this.moveFocusTo(visible[currentIndex + 1]!.pathString);
        }
        return;
      }
      case 'ArrowUp': {
        event.preventDefault();
        if (currentIndex > 0) {
          this.moveFocusTo(visible[currentIndex - 1]!.pathString);
        }
        return;
      }
      case 'Home': {
        event.preventDefault();
        if (visible.length > 0) {
          this.moveFocusTo(visible[0]!.pathString);
        }
        return;
      }
      case 'End': {
        event.preventDefault();
        if (visible.length > 0) {
          this.moveFocusTo(visible[visible.length - 1]!.pathString);
        }
        return;
      }
      case 'ArrowRight': {
        event.preventDefault();
        if (isContainer && !isExpanded) {
          this.treeControl.expand(node);
        } else if (isContainer && isExpanded && node.children && node.children.length > 0) {
          this.moveFocusTo(node.children[0]!.pathString);
        }
        // Leaf: no-op.
        return;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        if (isContainer && isExpanded) {
          this.treeControl.collapse(node);
        } else {
          const parent = this.parentOf(node);
          if (parent) this.moveFocusTo(parent.pathString);
        }
        return;
      }
      case 'Enter':
      case ' ':
      case 'Spacebar': {
        event.preventDefault();
        this.selectedPath.set(node.pathString);
        return;
      }
      case 'F10': {
        if (event.shiftKey) {
          event.preventDefault();
          this.openRowContextMenuFromKeyboard(node);
        }
        return;
      }
      case 'ContextMenu': {
        event.preventDefault();
        this.openRowContextMenuFromKeyboard(node);
        return;
      }
      case 'c':
      case 'C': {
        // Ctrl+C / Cmd+C copies the focused row's value. Strict
        // modifier match: Ctrl+Shift+C (devtools) and Ctrl+Alt+C
        // (AltGr on international layouts) are intentionally NOT
        // honored. The currentTarget !== target guard at the top of
        // this handler already ensures `node` is the focused row,
        // and that the search input / interactive descendants
        // (twisty, kebab, beacon, extract pill) do not route here.
        if (!(event.ctrlKey || event.metaKey)) return;
        if (event.altKey || event.shiftKey) return;
        event.preventDefault();
        this.copyValue(node, 'keyboard');
        return;
      }
      default:
        return;
    }
  }

  /**
   * M7g-3b. Open the row context menu from a keyboard gesture
   * (Shift+F10 or ContextMenu key) by reusing the proven
   * `openContextMenuAt` path with a synthesized `MouseEvent`. The
   * anchor coordinates are the centre of the focused row's bounding
   * rect so the menu lands visibly attached to the row.
   *
   * Silently no-ops when the row element is not in the DOM (race with
   * a re-render).
   */
  private openRowContextMenuFromKeyboard(node: TreeNode): void {
    const el = this.host.nativeElement.querySelector(
      `mat-nested-tree-node[data-tree-node-path="${cssEscape(node.pathString)}"] > .tree-row`,
    ) as HTMLElement | null;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ev = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2),
    });
    this.openContextMenuAt(ev, node, 'row', false);
  }

  clearSelection(): void {
    this.selectedPath.set(null);
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
      searchCaseSensitive: !this.prefs.prefs().searchCaseSensitive,
    });
  }

  toggleSearchRegexMode(): void {
    this.prefs.update({
      searchRegexMode: !this.prefs.prefs().searchRegexMode,
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
    // M7g-3b. Also update `focusedPath` silently so a subsequent Tab
    // into the tree lands on the active hit. Do NOT call DOM focus()
    // on the row -- the search input keeps focus so repeated Enter /
    // Shift+Enter keep cycling matches.
    this.focusedPath.set(path);
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
    // See goToNextMatch: focused-but-not-DOM-focused so the search
    // input keeps focus.
    this.focusedPath.set(path);
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
   * Expand exactly the node at `path` by one level (the node itself;
   * not its descendants). No-op when the path is not in `nodeIndex`.
   * Used by the home component after a tree-extract patch to reveal
   * the immediate children of the just-mutated node (e.g. show
   * `prefix`/`json`/`suffix` after wrapping a string).
   *
   * Accepts the canonical `(string | number)[]` form (as carried by
   * `TreeExtractRequest.path`); converts to the tree's internal
   * pathString via `formatPath` for the `nodeIndex` lookup.
   *
   * Safe to call before the post-mutation re-parse has propagated:
   * the underlying CDK `NestedTreeControl` is constructed with
   * `trackBy: (n) => n.pathString`, so expansion is keyed on the
   * stable path string. Adding the path to the expansion model via
   * the pre-mutation `TreeNode` reference means the post-mutation
   * node will render expanded as soon as it appears in the data
   * source.
   */
  expandNodeAtPath(path: (string | number)[]): void {
    const node = this.nodeIndex().get(this.formatPath(path));
    if (!node) return;
    this.treeControl.expand(node);
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
      selectionUpDistance,
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
      selectionUpDistance: 0,
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
        `[data-path="${cssEscape(path)}"]`,
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
    const start = performance.now();
    let nodeCount = 0;
    let maxDepth = 0;
    const walk = (node: TreeNode | undefined, relativeDepth: number): void => {
      if (!node || !node.children) return;
      nodeCount += 1;
      maxDepth = Math.max(maxDepth, relativeDepth);
      this.treeControl.expand(node);
      for (const child of node.children) walk(child, relativeDepth + 1);
    };
    walk(this.root(), 0);
    this.emitSlowExpandIfNeeded(performance.now() - start, maxDepth, nodeCount);
  }

  collapseAll(): void {
    this.treeControl.collapseAll();
  }

  expandToLevel(depth: number, internal = false): void {
    const start = performance.now();
    let nodeCount = 0;
    this.treeControl.collapseAll();
    const walk = (node: TreeNode | undefined): void => {
      if (!node || !node.children) return;
      nodeCount += 1;
      if (node.depth < depth) {
        this.treeControl.expand(node);
        for (const child of node.children) walk(child);
      }
    };
    walk(this.root());
    const timeMs = performance.now() - start;
    if (!internal) {
      this.emitSlowExpandIfNeeded(timeMs, depth, nodeCount);
    }
  }

  /**
   * Initial-expansion auto-fit branch. Picks the largest expansion
   * depth K such that `sum(nodesAt[0..K]) <= 1.5 * capacity`, where
   * `capacity = floor(viewportPx / probeRowPx)`. Falls back to the
   * fixed-depth path (`defaultTreeExpansionDepth`) when the probe or
   * viewport cannot be measured. Schedules a one-rAF post-expand
   * pass to read the actual rendered scroll height into telemetry.
   *
   * Called from the root-change effect when `treeAutoFitToWindow` is
   * on and `hasInitializedExpansion` was false. Synchronous up to
   * `expandToLevel(K)`; only the telemetry emit is deferred.
   */
  private runAutoFitInitialExpansion(): void {
    const measured = this.resolveAutoFitMeasurements();
    const fallbackDepth = this.prefs.prefs().defaultTreeExpansionDepth;
    if (measured === null) {
      this.expandToLevel(fallbackDepth, true);
      return;
    }
    const { probeHeightPx, viewportPx, scrollContainer } = measured;
    const estimatedRows = Math.floor(viewportPx / probeHeightPx);
    if (estimatedRows < 1) {
      this.expandToLevel(fallbackDepth, true);
      return;
    }
    const result = computeAutoFitDepth(this.root() ?? null, estimatedRows, 1.5);
    this.expandToLevel(result.chosenDepth, true);
    const fillRatioPct =
      estimatedRows > 0 ? Math.round((result.chosenRows / estimatedRows) * 100) : 0;
    const generation = ++this.autoFitGeneration;
    requestAnimationFrame(() => {
      if (this.cancelledRender || generation !== this.autoFitGeneration) {
        return;
      }
      const actualHeightPx = scrollContainer ? scrollContainer.scrollHeight : 0;
      const actualFillRatioPct =
        viewportPx > 0 ? Math.round((actualHeightPx / viewportPx) * 100) : 0;
      this.logger.event(
        'tree.expand.autoFit',
        {},
        {
          chosenDepth: result.chosenDepth,
          totalNodes: result.totalNodes,
          viewportPx,
          probeRowPx: probeHeightPx,
          estimatedRows,
          chosenRows: result.chosenRows,
          fillRatioPct,
          actualHeightPx,
          actualFillRatioPct,
        },
      );
    });
  }

  /**
   * Returns probe height + viewport height for the auto-fit
   * algorithm, or `null` when either cannot be measured. The probe
   * height is cached by `treeFontSize`; the viewport is re-resolved
   * on each call (cheap DOM walk).
   *
   * Honors the test-only override when set so specs can drive the
   * algorithm without a real DOM.
   */
  private resolveAutoFitMeasurements(): {
    probeHeightPx: number;
    viewportPx: number;
    scrollContainer: HTMLElement | null;
  } | null {
    const override = this.autoFitMeasurementOverrideForTesting;
    if (override !== null) {
      if (override.probeHeightPx < 8 || override.viewportPx <= 0) {
        return null;
      }
      return {
        probeHeightPx: override.probeHeightPx,
        viewportPx: override.viewportPx,
        scrollContainer: override.scrollContainer,
      };
    }
    const probeHeightPx = this.measureProbeRowHeight();
    if (probeHeightPx < 8) {
      return null;
    }
    const scrollContainer = findScrollableAncestor(this.host.nativeElement);
    const viewportPx = scrollContainer ? scrollContainer.clientHeight : window.innerHeight;
    if (viewportPx <= 0) {
      return null;
    }
    return { probeHeightPx, viewportPx, scrollContainer };
  }

  /**
   * Reads (and caches) the rendered height of the offscreen probe
   * row. Returns 0 when the probe ref is not yet attached or has
   * collapsed to 0 height (e.g., before first layout). Cache key is
   * the current `treeFontSize`.
   */
  private measureProbeRowHeight(): number {
    const fontSize = this.treeFontSize();
    if (this.probeRowHeightCache !== null && this.probeRowHeightCache.fontSize === fontSize) {
      return this.probeRowHeightCache.heightPx;
    }
    const probeRef = this.autoFitProbe();
    if (!probeRef) {
      return 0;
    }
    const heightPx = probeRef.nativeElement.getBoundingClientRect().height;
    if (heightPx <= 0) {
      return 0;
    }
    this.probeRowHeightCache = { fontSize, heightPx };
    return heightPx;
  }

  onSearchInput(ev: Event): void {
    this.search.set((ev.target as HTMLInputElement).value);
  }

  copyPath(node: TreeNode): void {
    const path = this.jsonParser.formatPathForClipboard(
      node.pathString,
      this.prefs.prefs().treePathRoot,
    );
    void this.clipboardCopy.copyWithToast(path, {
      success: $localize`:@@tree.copyPath.success:Path copied to clipboard.`,
      failed: $localize`:@@tree.copyPath.failed:Failed to copy path.`,
      unsupported: $localize`:@@tree.copyPath.unsupported:Copy is not supported in this browser.`,
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
  //   findByKey / findByValue - menu actions; each clears the type filter
  //   to 'all', forces literal (non-regex) search, sets the search query,
  //   and elevates the clicked row to the active hit when it matches.
  //   Telemetry message IDs (`tree.contextMenu.searchByKey` /
  //   `searchByValue`) and the i18n IDs are preserved verbatim per the
  //   stability pledge in the tree-menu overhaul plan; only the visible
  //   labels and TS method names rename to "Find".
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
    this.openContextMenuAt(event, node, 'row', false);
  }

  onCloseRowContextMenu(event: MouseEvent, node: TreeNode): void {
    if (event.clientX === 0 && event.clientY === 0) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest('button, [matTreeNodeToggle], a, input, [role="button"]')
    ) {
      return;
    }
    this.openContextMenuAt(event, node, 'row', true);
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
    this.openContextMenuAt(payload.event, node, 'breadcrumb', false);
  }

  /**
   * Shared opener for the row context menu. Used by both the row
   * right-click flow (`onRowContextMenu`) and the breadcrumb chip
   * right-click flow (`onBreadcrumbContextMenu`). Sets cursor anchor,
   * pins the contextNode, logs telemetry with the gesture source,
   * and opens the menu on the next microtask.
   *
   * Right-click does NOT mutate `selectedPath`. Menu actions read
   * `contextNode` (= the right-clicked target), so dropping the
   * selection mutation is behaviour-preserving for every action
   * while avoiding the breadcrumb-reflow bug that otherwise shifts
   * chips out from under the cursor before the menu opens.
   *
   * If a menu is already open (e.g. user right-clicks a different
   * row before dismissing the previous menu), it closes first and
   * reopens at the new anchor; just calling `openMenu()` again does
   * not reposition the panel.
   *
   * Note: the kebab-click flow does NOT go through this helper -
   * the kebab is its own `[matMenuTriggerFor]` button and self-
   * anchors, so it only needs to update `contextNode` and
   * `selectedPath`. Kebab is a left-click gesture and DOES select
   * the row by design. Its own logger call (with `source: 'kebab'`)
   * lives in `onKebabClick`.
   */
  private openContextMenuAt(
    event: MouseEvent,
    node: TreeNode,
    source: 'row' | 'breadcrumb',
    isCloseRow: boolean,
  ): void {
    event.preventDefault();
    const trigger = this.ctxTrigger();
    const apply = (): void => {
      this.ctxX.set(event.clientX);
      this.ctxY.set(event.clientY);
      this.contextNode.set(node);
      this.contextIsCloseRow.set(isCloseRow);
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
   * Double-click handler for `.tree-row`. Behavior splits by node
   * type (issue #109; empty-container case relaxed during the
   * tree-menu overhaul, see plan.md decision Q4b):
   *
   *   - **Containers with children** (`type === 'object' | 'array'`
   *     and `children.length > 0`): toggle the row's expansion state
   *     and emit `tree.row.doubleClickToggle` with the post-toggle
   *     `action`. Alt is intentionally ignored on containers; the
   *     right-click context menu still offers "Copy value" for users
   *     who want the pretty-printed JSON.
   *   - **Empty containers** (`{}` / `[]`): copy the literal `{}` or
   *     `[]` to the clipboard. They have no expansion to toggle, so
   *     the dblclick falls through to the same `copyValue` branch as
   *     primitives. Issue #109's original "expand/collapse instead
   *     of copying" wording is relaxed here for the edge case where
   *     there is no expand/collapse to do; the surfaced default-
   *     shortcut row in the right-click menu also bolds "Copy value"
   *     for empty containers to match. Telemetry: `tree.row.
   *     doubleClickCopyValue` with `escaped: false` (Alt-modified
   *     copies route the escape flag through `copyValue`).
   *   - **Primitive leaves**: copy the row's value to the clipboard
   *     (raw text for primitives; Alt wraps as a JSON string literal
   *     per DESIGN_SPEC.md §443).
   *
   * The browser also fires two `click` events before the `dblclick`;
   * the existing `onSelect` runs for each but is idempotent on
   * identical paths, so no debounce is needed. The interactive
   * descendant guard (kebab pill, chevron, etc.) short-circuits the
   * handler entirely so a dblclick on those buttons never falls into
   * the type-based branching here.
   */
  onRowDblClick(event: MouseEvent, node: TreeNode): void {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest('button, [matTreeNodeToggle], a, input, [role="button"]')
    ) {
      return;
    }
    if ((node.type === 'object' || node.type === 'array') && node.children?.length) {
      const wasExpanded = this.treeControl.isExpanded(node);
      this.treeControl.toggle(node);
      this.logger.info('tree.row.doubleClickToggle', {
        action: wasExpanded ? 'collapse' : 'expand',
      });
      return;
    }
    this.copyValue(node, 'dblclick', event.altKey);
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
    this.contextIsCloseRow.set(false);
    this.selectedPath.set(node.pathString);
    this.logger.info('tree.contextMenu.opened', { source: 'kebab' });
  }

  extractCandidate(node: TreeNode): ExtractedJson | null {
    if (node.type !== 'string' || typeof node.value !== 'string') return null;
    const map = this.extractCandidates();
    if (!map) return null;
    return map.get(node.value) ?? null;
  }

  onExtractButtonClick(node: TreeNode, event: MouseEvent): void {
    event.stopPropagation();
    this.emitExtract(node, 'rowButton');
  }

  onExtractMenuClick(node: TreeNode): void {
    // Phase 4 (tree-menu overhaul): counts-only marker for the
    // menu-driven Extract entry point. The inline pill button uses
    // `tree.extract.click` with `source: 'rowButton'` separately.
    this.logger.info('tree.contextMenu.extract');
    this.emitExtract(node, 'contextMenu');
  }

  private emitExtract(node: TreeNode, source: 'rowButton' | 'contextMenu'): void {
    const candidate = this.extractCandidate(node);
    if (!candidate) return;
    const sourceVersion = this.extractSourceVersion() ?? -1;
    this.extractRequest.emit({ path: node.path, sourceVersion, replacement: candidate, source });
  }

  /**
   * Returns true when this node is a string leaf whose parsed value
   * benefits from a "show as decoded text" pill. The predicate is
   * intentionally broad: any control character that JSON would have
   * escaped (\n, \r, \t), plus embedded quotes (") or backslashes (\),
   * makes the JSON-escaped single-line rendering harder to read than
   * the raw string. A string with only printable ASCII and no embedded
   * quotes/backslashes shows fine as-is and gets no pill.
   */
  decodedCandidate(node: TreeNode): boolean {
    if (node.type !== 'string' || typeof node.value !== 'string') return false;
    return /[\n\r\t"\\]/.test(node.value);
  }

  /**
   * True iff the user has explicitly toggled this row into the decoded
   * view AND the node is still a decoded candidate. Gating on the
   * predicate makes stale entries (e.g. value type changed under the
   * same path) render as the normal JSON-escaped form.
   */
  isDecoded(node: TreeNode): boolean {
    if (!this.decodedCandidate(node)) return false;
    return this.decodedExpandedPaths().has(node.pathString);
  }

  /**
   * Template-only renderer for value text. For string leaves in the
   * decoded view, returns the raw string wrapped in JSON quotes so the
   * row still reads as a string (just with real newlines and a
   * `pre-wrap` whitespace style). For everything else delegates to
   * {@link renderLeaf} so search (which calls renderLeaf directly)
   * remains the canonical "what does this row show" source of truth.
   */
  displayLeaf(node: TreeNode): string {
    if (node.type === 'string' && typeof node.value === 'string' && this.isDecoded(node)) {
      return `"${node.value}"`;
    }
    return this.renderLeaf(node.value, node.type);
  }

  onDecodedButtonClick(node: TreeNode, event: MouseEvent): void {
    event.stopPropagation();
    this.toggleDecoded(node, 'rowButton');
  }

  onDecodedMenuClick(node: TreeNode): void {
    if (this.decodedCandidate(node)) {
      // Phase 4 (tree-menu overhaul): split show vs hide into
      // separate counts-only events so analytics can answer "is
      // Decode used as a one-shot inspection or as a sticky
      // setting?". Fire BEFORE `toggleDecoded` so we read the
      // pre-toggle state directly from `isDecoded`.
      this.logger.info(
        this.isDecoded(node) ? 'tree.contextMenu.decodeHide' : 'tree.contextMenu.decodeShow',
      );
    }
    this.toggleDecoded(node, 'contextMenu');
  }

  private toggleDecoded(node: TreeNode, source: 'rowButton' | 'contextMenu'): void {
    if (!this.decodedCandidate(node)) return;
    const value = node.value as string;
    const current = this.decodedExpandedPaths();
    const next = new Set(current);
    const wasOn = next.has(node.pathString);
    if (wasOn) {
      next.delete(node.pathString);
    } else {
      next.add(node.pathString);
    }
    this.decodedExpandedPaths.set(next);
    this.logger.event('tree.decoded.click', {
      source,
      direction: wasOn ? 'off' : 'on',
      lineCountBucket: bucketLineCount(value),
    });
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
      unsupported: $localize`:@@tree.contextMenu.copy.unsupported:Copy is not supported in this browser.`,
    });
  }

  /**
   * Copies the row's value to the clipboard. For primitives, the raw
   * text (no enclosing quotes for strings); for objects/arrays,
   * `JSON.stringify(value, null, 2)` (pretty, per Q1 decision).
   *
   * `source` distinguishes menu-driven, double-click-driven, and
   * keyboard-driven invocations for telemetry; all paths use identical
   * copy semantics.
   *
   * When `escaped` is true, the serialized text is wrapped with
   * `JSON.stringify(...)` -- the JSON-string-literal variant matching the
   * toolbar Copy button's Alt+click affordance (DESIGN_SPEC.md §443). This
   * lets users embed the row's value as a string in another JSON document.
   * The Ctrl+C / Cmd+C keyboard shortcut intentionally does not honor Alt
   * (Alt+Ctrl+C is a no-op at the keydown level), so `source === 'keyboard'`
   * always pairs with `escaped === false`.
   */
  copyValue(node: TreeNode, source: 'menu' | 'dblclick' | 'keyboard', escaped = false): void {
    const messageId =
      source === 'menu'
        ? 'tree.contextMenu.copyValue'
        : source === 'dblclick'
          ? 'tree.row.doubleClickCopyValue'
          : 'tree.keyboard.copyValue';
    this.logger.info(messageId, { escaped });
    const raw = this.serializeNodeValueForCopy(node);
    const text = escaped ? this.jsonParser.escapeAsJsonString(raw) : raw;
    void this.clipboardCopy.copyWithToast(text, {
      success: $localize`:@@tree.contextMenu.copy.success.value:Value copied to clipboard.`,
      failed: $localize`:@@tree.contextMenu.copy.failed.value:Failed to copy value.`,
      unsupported: $localize`:@@tree.contextMenu.copy.unsupported:Copy is not supported in this browser.`,
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
  findByKey(node: TreeNode): void {
    if (node.segment === undefined) return;
    this.logger.info('tree.contextMenu.searchByKey');
    this.prefs.update({
      searchScope: 'keys',
      searchRegexMode: false,
      searchValueType: 'all',
    });
    this.search.set(String(node.segment));
    this.activateClickedHitOrFirst(node.pathString);
  }

  /**
   * Like `findByKey`, but for the row's value. Hidden in the
   * template for containers, `null`, and `undefined` (caller should
   * check `showFindByValue` before invoking).
   */
  findByValue(node: TreeNode): void {
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
      node.type === 'string' ? (node.value as string) : this.renderLeaf(node.value, node.type);
    this.prefs.update({
      searchScope: 'values',
      searchRegexMode: false,
      searchValueType: 'all',
    });
    this.search.set(query);
    this.activateClickedHitOrFirst(node.pathString);
  }

  applyManualHighlight(node: TreeNode, cascade: boolean, color: string): void {
    if (!this.canEditHighlights()) return;
    if (cascade) {
      if (!this.showHighlightTree(node)) return;
    } else if (!this.showHighlight(node)) {
      return;
    }

    const path = this.effectiveHighlightPath(node);
    const existingHighlight = this.highlightIndex().get(path);
    if (existingHighlight?.color === color && existingHighlight.cascade === cascade) {
      this.closeHighlightMenuChain();
      return;
    }

    const nextHighlights = this.highlights().filter((highlight) => highlight.path !== path);
    nextHighlights.push({ path, color, cascade });
    this.logger.info('tree.highlight.apply', {
      kind: cascade ? 'cascade' : 'single',
      bucket: bucketColorHex(color),
      replacedExisting: existingHighlight ? 'true' : 'false',
    });
    // Phase 4 (tree-menu overhaul): counts-only context-menu marker
    // distinguishing single-row scope from subtree scope. The
    // existing `tree.highlight.apply` event carries color / replace
    // metadata; this pair answers "which scope is more common".
    this.logger.info(cascade ? 'tree.contextMenu.highlightSubtree' : 'tree.contextMenu.highlight');
    this.highlightsChange.emit(nextHighlights);
    this.closeHighlightMenuChain();
  }

  /**
   * Click handler for the parent "Highlight" / "Highlight tree"
   * mat-menu items. The swatch flyout still opens on hover via
   * `[matMenuTriggerFor]`, but a click on the parent item itself
   * applies the preferred color (matching the visual affordance:
   * the row label is unmistakably button-like). We use
   * `stopImmediatePropagation` to block `MatMenuTrigger`'s own
   * host click listener, which would otherwise open the flyout
   * panel under our just-dismissed row menu. `applyManualHighlight`
   * dismisses the row menu via `closeHighlightMenuChain` once the
   * change is emitted (or on idempotent skip).
   *
   * Keyboard parity: pressing Enter on a focused mat-menu-item
   * fires a synthetic click in browsers, so this same path covers
   * the keyboard case without a separate `(keydown.enter)` handler.
   */
  onHighlightItemClick(event: MouseEvent, node: TreeNode, cascade: boolean): void {
    event.stopImmediatePropagation();
    this.applyManualHighlight(node, cascade, this.preferredHighlightColor());
  }

  /**
   * Dismiss every open `MatMenuTrigger` in the component view.
   * Called after a successful (or idempotent) highlight apply so the
   * row menu plus any swatch flyout get out of the user's way and
   * provide selection-confirmation feedback. The toolbar's other
   * triggers (scope/type/expand) are not open during a highlight
   * context-menu interaction, so this is effectively scoped to the
   * highlight chain.
   *
   * We use `closeMenu()` per-trigger instead of relying on Material's
   * `'click'`-reason cascade because viewChild references to the
   * MatMenu directives inside an `<mat-menu>` portal do not always
   * resolve, and even when they do, only the active opener trigger
   * destroys the overlay - other open triggers remain. Iterating
   * triggers and closing each is robust to any chain configuration.
   */
  private closeHighlightMenuChain(): void {
    for (const trigger of this.allMatMenuTriggers()) {
      if (trigger.menuOpen) {
        trigger.closeMenu();
      }
    }
  }

  removeManualHighlight(node: TreeNode): void {
    if (!this.canEditHighlights() || this.contextIsCloseRow()) return;
    const path = this.effectiveHighlightPath(node);
    const existingHighlight = this.highlightIndex().get(path);
    if (!existingHighlight || existingHighlight.cascade) return;
    this.logger.info('tree.highlight.remove', {
      kind: 'single',
      removedFromAncestor: 'false',
    });
    this.emitHighlightsWithoutPath(path);
  }

  removeManualTreeHighlight(node: TreeNode): void {
    if (!this.canEditHighlights()) return;
    const cascadeHighlight = this.nearestCascadeForNode(node);
    if (!cascadeHighlight) return;
    const removedFromAncestor = cascadeHighlight.path !== node.pathString;
    this.logger.info('tree.highlight.remove', {
      kind: 'cascade',
      removedFromAncestor: removedFromAncestor ? 'true' : 'false',
    });
    this.emitHighlightsWithoutPath(cascadeHighlight.path);
  }

  onSwatchMenuOpened(kind: 'single' | 'cascade'): void {
    this.logger.info('tree.highlight.swatchOpened', { kind });
  }

  highlightSwatchLabel(swatch: PaletteSwatch): string {
    return $localize`:@@tree.highlight.swatch.aria:${swatch.name}:name: ${swatch.hex}:hex:`;
  }

  removeTreeHighlightAriaLabel(node: TreeNode): string {
    const cascadeHighlight = this.nearestCascadeForNode(node);
    if (!cascadeHighlight || cascadeHighlight.path === this.effectiveHighlightPath(node)) {
      return this.ctxRemoveTreeHighlightLabel;
    }
    const ancestorPath = cascadeHighlight.path;
    return $localize`:@@tree.contextMenu.removeTreeHighlight.rooted:Remove tree highlight rooted at ${ancestorPath}:ancestorPath:`;
  }

  showAnyHighlightAction(node: TreeNode): boolean {
    return (
      this.showHighlight(node) ||
      this.showHighlightTree(node) ||
      this.showRemoveHighlight(node) ||
      this.showRemoveTreeHighlight(node)
    );
  }

  showHighlight(node: TreeNode): boolean {
    return this.canEditHighlights() && !this.contextIsCloseRow() && this.hasOwnHighlightPath(node);
  }

  showHighlightTree(node: TreeNode): boolean {
    return this.canEditHighlights() && (this.contextIsCloseRow() || this.isContainerNode(node));
  }

  showRemoveHighlight(node: TreeNode): boolean {
    if (!this.canEditHighlights() || this.contextIsCloseRow()) return false;
    const existingHighlight = this.highlightIndex().get(this.effectiveHighlightPath(node));
    return existingHighlight?.cascade === false;
  }

  showRemoveTreeHighlight(node: TreeNode): boolean {
    return this.canEditHighlights() && this.nearestCascadeForNode(node) !== undefined;
  }

  /**
   * True iff the `Subtree >` submenu should render in the row menu.
   * Path Y groups all subtree-affecting actions (highlight subtree,
   * collapse from here, isolate variants, expand from here >) under
   * one named submenu. The trigger renders when at least one child
   * predicate is true.
   */
  showSubtreeMenu(node: TreeNode): boolean {
    return (
      this.showHighlightTree(node) ||
      this.showRemoveTreeHighlight(node) ||
      this.showCollapse(node) ||
      this.showIsolateSingle(node) ||
      this.showIsolatePair(node) ||
      this.showExpandFromHereMenu(node)
    );
  }

  /**
   * True iff the `Expand from here >` sub-submenu (inside Subtree >)
   * should render. Rolls up the existing per-depth predicates plus
   * `Expand all from here`.
   */
  showExpandFromHereMenu(node: TreeNode): boolean {
    return (
      this.showExpandAllFromHere(node) ||
      this.showExpandToDepth(node, 1) ||
      this.showExpandToDepth(node, 2) ||
      this.showExpandToDepth(node, 3) ||
      this.showExpandToDepth(node, 4) ||
      this.showExpandToDepth(node, 5)
    );
  }

  /**
   * Click handler for the surfaced default-shortcut row (the bolded
   * item between the Find section and the Subtree > trigger). Dispatches
   * to the same action that double-click would fire on the contextNode.
   * `'copyValue'` and `'none'` cases are unreachable here because the
   * surfaced row only renders when `defaultActionKind()` is
   * `'collapseRow'` or `'expandRow'` (see `surfacedShortcutLabel`).
   */
  onSurfacedShortcutClick(node: TreeNode): void {
    switch (this.defaultActionKind()) {
      case 'collapseRow':
        this.collapseFromHere(node, 'top');
        return;
      case 'expandRow':
        // expandToDepthFromHere(node, 1) walks the subtree up to relative
        // depth < 1, which expands only the clicked node -- equivalent to
        // `treeControl.toggle(node)` when the node is collapsed.
        // Routing through the shared depth method keeps existing
        // `tree.contextMenu.expandToDepth` telemetry intact.
        this.expandToDepthFromHere(node, 1, 'top');
        return;
    }
  }

  /**
   * Phase 4 telemetry hook for the `Subtree >` submenu trigger.
   * Wired via `(menuOpened)` in the row context menu template.
   * Counts-only marker for the new submenu's discoverability.
   */
  onSubtreeMenuOpened(): void {
    this.logger.info('tree.contextMenu.subtreeOpened');
  }

  /**
   * Collapses the clicked node (single-row, non-recursive). CDK's
   * FlatTree preserves descendants' expansion state across collapse /
   * re-expand cycles, so re-expanding `node` restores the previous
   * tree shape exactly. Caller should guard with `showCollapse(node)`
   * (we early-out harmlessly when there are no children).
   *
   * The earlier recursive `collapseFromHere` walked the subtree and
   * cleared every descendant's expansion state. That implementation
   * was deleted during the tree-menu overhaul (plan.md decision):
   * the visible outcome of single-row vs recursive collapse is
   * identical (children are hidden either way because their parent is
   * collapsed); the only difference was the internal preserve-vs-clear
   * state. Single-row matches double-click semantics exactly and is
   * the single action wired to both the surfaced top-level shortcut
   * and the in-Subtree submenu item.
   *
   * `source` distinguishes the two menu entry points for telemetry
   * (Phase 4 of the tree-menu overhaul): `'top'` for the surfaced
   * default-shortcut row, `'submenu'` for the in-Subtree submenu
   * item. Defaults to `'submenu'` so existing call sites continue
   * to emit a stable shape.
   */
  collapseFromHere(node: TreeNode, source: 'top' | 'submenu' = 'submenu'): void {
    if (!node.children?.length) return;
    this.logger.info('tree.contextMenu.collapse', { source });
    this.treeControl.collapse(node);
  }

  /**
   * Expands the clicked node and every container in its subtree.
   * Caller should guard with `showExpandAllFromHere(node)`.
   *
   * `source` is reserved for symmetry with `collapseFromHere` /
   * `expandToDepthFromHere`. After Path Y the only menu entry point
   * for "Expand all" is inside the in-Subtree `Expand >` sub-submenu
   * (`'submenu'`); the surfaced top-level shortcut routes through
   * `expandToDepthFromHere` with `relativeDepth: 1` instead.
   */
  expandAllFromHere(node: TreeNode, source: 'top' | 'submenu' = 'submenu'): void {
    const start = performance.now();
    if (!node.children?.length) return;
    this.logger.info('tree.contextMenu.expandAllFromHere', { source });
    let nodeCount = 0;
    let maxDepth = 0;
    const walk = (currentNode: TreeNode, relativeDepth: number): void => {
      if (!currentNode.children?.length) return;
      nodeCount += 1;
      maxDepth = Math.max(maxDepth, relativeDepth);
      this.treeControl.expand(currentNode);
      for (const child of currentNode.children) walk(child, relativeDepth + 1);
    };
    walk(node, 0);
    this.emitSlowExpandIfNeeded(performance.now() - start, maxDepth, nodeCount);
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
   * which depths users invoke most often. `source` distinguishes the
   * surfaced top-level shortcut row (`'top'`, always `relativeDepth: 1`
   * since the surfaced row mirrors a single-level dblclick expand)
   * from the in-Subtree submenu's per-depth items (`'submenu'`).
   * Defaults to `'submenu'` for backward compatibility with existing
   * call sites.
   */
  expandToDepthFromHere(
    node: TreeNode,
    relativeDepth: number,
    source: 'top' | 'submenu' = 'submenu',
  ): void {
    const start = performance.now();
    if (!node.children?.length) return;
    this.logger.info('tree.contextMenu.expandToDepth', { relativeDepth, source });
    let nodeCount = 0;
    const walk = (currentNode: TreeNode, currentDepth: number): void => {
      if (!currentNode.children?.length) return;
      if (currentDepth >= relativeDepth) return;
      nodeCount += 1;
      if (!this.treeControl.isExpanded(currentNode)) {
        this.treeControl.expand(currentNode);
      }
      for (const child of currentNode.children) walk(child, currentDepth + 1);
    };
    walk(node, 0);
    this.emitSlowExpandIfNeeded(performance.now() - start, relativeDepth, nodeCount);
  }

  // ---- Visibility predicates (template @if guards) ----

  showCopyKey(node: TreeNode): boolean {
    return node.segment !== undefined;
  }

  showCopyValue(_node: TreeNode): boolean {
    return true;
  }

  showFindByKey(node: TreeNode): boolean {
    return !this.embeddedMode() && node.segment !== undefined;
  }

  showFindByValue(node: TreeNode): boolean {
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
      source === 'wide' ? 'tree.contextMenu.isolateWide' : 'tree.contextMenu.isolate',
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

  private effectiveHighlightPath(node: TreeNode): string {
    return node.pathString;
  }

  private hasOwnHighlightPath(node: TreeNode): boolean {
    return node.pathString.length > 0;
  }

  private isContainerNode(node: TreeNode): boolean {
    return node.type === 'object' || node.type === 'array';
  }

  private nearestCascadeForNode(node: TreeNode): { path: string; color: string } | undefined {
    return findNearestCascade(this.effectiveHighlightPath(node), this.highlightIndex());
  }

  private emitHighlightsWithoutPath(path: string): void {
    const nextHighlights = this.highlights().filter((highlight) => highlight.path !== path);
    if (nextHighlights.length === this.highlights().length) return;
    this.highlightsChange.emit(nextHighlights);
  }

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
  private hasCollapsedContainerAboveDepth(node: TreeNode, relativeDepth: number): boolean {
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
   * Memoized rule-engine evaluator for the current set of active rule
   * sets. Recomputes (and resets the cache) only when
   * `ruleSets.activeRuleSets()` changes - i.e. when the user toggles a
   * set on/off OR when one of those sets' `version` changes after a
   * save elsewhere. Unrelated tree updates (selection, search, expand)
   * do NOT invalidate the cache.
   *
   * The cache key collapses two leaves to the same entry only when
   * their inputs to the engine are identical: same key (or both null
   * for root/array elements), same unquoted display text, same
   * container-ness, same deterministic value kind, and same emptiness
   * flag. That is exactly the surface the engine reads, so collisions
   * are correctness-preserving.
   *
   * Returns `EMPTY_RULE_RESULT` (frozen sentinel) by identity when no
   * active sets are configured, which lets callers short-circuit
   * cheaply on the no-formatting path.
   */
  private readonly evaluateNode = computed<(node: TreeNode) => RuleEngineResult>(() => {
    const override = this.overrideRuleSets();
    const sets = override ?? this.ruleSets.activeRuleSets();
    if (sets.length === 0) {
      return () => EMPTY_RULE_RESULT;
    }
    const cache = new Map<string, RuleEngineResult>();
    return (node: TreeNode): RuleEngineResult => {
      const engineNode = this.toEngineNode(node);
      // Cache key explicitly delimits the five components so two
      // distinct (key, valueText) pairs cannot collide via accidental
      // concatenation. The unit separator (\u001f) is JSON-illegal, so
      // it cannot appear inside `key` or `valueText`.
      const cacheKey = [
        engineNode.key ?? '\u0000',
        engineNode.valueText ?? '\u0000',
        engineNode.isContainer ? '1' : '0',
        engineNode.valueKind ?? '\u0000',
        engineNode.isEmpty ? '1' : '0',
      ].join('\u001f');
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
   * skip value-target text rules without having to re-detect them.
   * Pair-rule predicates also receive deterministic `valueKind` and
   * `isEmpty` values from the preference-free formatting classifier.
   *
   * The root and array elements have `key: null`. Object-member keys
   * arrive as the literal string segment.
   */
  private toEngineNode(node: TreeNode): RuleEngineNode {
    const isContainer = node.type === 'object' || node.type === 'array';
    const isClassifiable = node.type !== 'undefined';
    let valueText: string | null = null;
    if (!isContainer) {
      switch (node.type) {
        case 'string':
          valueText = typeof node.value === 'string' ? node.value : String(node.value);
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
    const valueKind = isClassifiable ? classifyJsonValue(node.value) : null;
    const isEmpty = isClassifiable ? isJsonValueEmpty(node.value) : false;
    return { key, valueText, isContainer, valueKind, isEmpty };
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

  /**
   * Engine-supplied icons for the matched key side. Returns an empty
   * array when no rules with icons match. Multiple rules contributing
   * the same icon are deduped (engine guarantees this).
   */
  keyIcons(node: TreeNode): readonly FormattingIcon[] {
    return this.ruleResultFor(node).keyStyle.icons ?? EMPTY_ICONS;
  }

  /**
   * Engine-supplied icons for the matched value side. Same shape as
   * `keyIcons`.
   */
  valueIcons(node: TreeNode): readonly FormattingIcon[] {
    return this.ruleResultFor(node).valueStyle.icons ?? EMPTY_ICONS;
  }

  /**
   * Pre-computed beacon index over the current tree. Drives toolbar
   * pills (one per matched icon-bucket) and ancestor badges on
   * collapsed rows. Returns `EMPTY_BEACON_INDEX` (identity-shared)
   * when nothing matched, so OnPush short-circuits via `===`.
   *
   * Reactive on the tree `root()` and on `evaluateNode()` (which
   * itself reactively tracks rule-set changes), so this recomputes
   * exactly when matches could have changed.
   */
  readonly beaconIndex = computed<BeaconIndex>(() => {
    const root = this.root();
    if (!root) return EMPTY_BEACON_INDEX;
    const evaluate = this.evaluateNode();
    return buildBeaconIndex(root, (node) => {
      const result = evaluate(node);
      const keyIconList = result.keyStyle.icons;
      const valueIconList = result.valueStyle.icons;
      if (keyIconList === undefined && valueIconList === undefined) {
        return EMPTY_ICONS;
      }
      if (keyIconList === undefined) return valueIconList ?? EMPTY_ICONS;
      if (valueIconList === undefined) return keyIconList;
      // Pair rules project the same icon onto both keyStyle and
      // valueStyle, so concat may contain duplicates. The helper
      // (`buildBeaconIndex`) dedupes per-node before populating
      // `matchesByIcon`, so passing duplicates here is safe.
      return [...keyIconList, ...valueIconList];
    });
  });

  /**
   * Icons present *strictly under* a collapsed node (subtree icons
   * minus the icons on this row itself). Used for ancestor-badge
   * rendering: when a container row is collapsed and there are
   * beacons hidden below, we surface their icon types here.
   * Returns `EMPTY_ICONS` (identity-shared) when there is nothing
   * to badge.
   *
   * - Always empty for leaf nodes (no `children`).
   * - Always empty for an expanded container (its children render
   *   their own icons / their own badges; no need to duplicate).
   * - Drops icons that are also on this row itself (already shown
   *   inline next to the key/value).
   */
  ancestorBeaconIcons(node: TreeNode): readonly FormattingIcon[] {
    if (!node.children?.length) return EMPTY_ICONS;
    if (this.treeControl.isExpanded(node)) return EMPTY_ICONS;
    const subtreeIcons = this.beaconIndex().descendantIconsByPath.get(node.pathString);
    if (!subtreeIcons || subtreeIcons.size === 0) return EMPTY_ICONS;
    const selfIcons = new Set<FormattingIcon>([...this.keyIcons(node), ...this.valueIcons(node)]);
    const out: FormattingIcon[] = [];
    for (const icon of subtreeIcons) {
      if (!selfIcons.has(icon)) out.push(icon);
    }
    return out.length === 0 ? EMPTY_ICONS : out;
  }

  /**
   * Click handler for an ancestor badge. Expands the path to (and
   * selects) the first beacon match for `icon` under `node`. Stops
   * propagation so the row's own click handler does not also run
   * (which would re-select the ancestor instead). Always emits
   * `beacons.badge.clicked`; emits `beacons.crossPane.dispatched`
   * via the navigation service for parity with pill clicks (so
   * dashboards can compare the two surfaces side by side).
   */
  onAncestorBadgeClick(node: TreeNode, icon: FormattingIcon, event: MouseEvent): void {
    event.stopPropagation();
    const matches = this.beaconIndex().matchesByIcon.get(icon);
    if (!matches || matches.length === 0) return;
    const ancestorPathString = node.pathString;
    let descendantCount = 0;
    let firstMatch: readonly (string | number)[] | undefined;
    for (const candidate of matches) {
      const candidatePathString = this.formatPath([...candidate]);
      if (candidatePathString === ancestorPathString) continue;
      if (!candidatePathString.startsWith(ancestorPathString)) continue;
      // Ensure it's a strict descendant boundary (not just a prefix
      // collision like `$.foo` vs `$.foobar`). The next char after
      // the ancestor pathString must be `.` or `[` -- both are
      // path-separator tokens in the canonical form.
      const next = candidatePathString.charAt(ancestorPathString.length);
      if (next !== '.' && next !== '[') continue;
      if (firstMatch === undefined) firstMatch = candidate;
      descendantCount += 1;
    }
    if (firstMatch === undefined) return;
    this.logger.info('beacons.badge.clicked', {
      icon,
      descendantCount,
    });
    this.beaconNav.markTreeActive();
    this.beaconNav.requestJump({
      path: firstMatch,
      icon,
      source: 'badge',
    });
  }

  /**
   * Tooltip / aria text for an ancestor badge. Same wording shape as
   * the toolbar pill tooltip (single-vs-many).
   */
  ancestorBadgeTooltip(node: TreeNode, icon: FormattingIcon): string {
    const matches = this.beaconIndex().matchesByIcon.get(icon) ?? [];
    const ancestorPathString = node.pathString;
    let descendantCount = 0;
    for (const candidate of matches) {
      const candidatePathString = this.formatPath([...candidate]);
      if (candidatePathString === ancestorPathString) continue;
      if (!candidatePathString.startsWith(ancestorPathString)) continue;
      const next = candidatePathString.charAt(ancestorPathString.length);
      if (next !== '.' && next !== '[') continue;
      descendantCount += 1;
    }
    return descendantCount === 1
      ? $localize`:@@tree.beacon.badge.tooltip.single:Jump to hidden beacon (${icon}:icon:)`
      : $localize`:@@tree.beacon.badge.tooltip.many:Jump to first of ${descendantCount}:count: hidden ${icon}:icon: beacons`;
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
      assumeUtcForIsoDateOnly: prefs.treeAssumeUtcForIsoDateOnly,
    });
    if (!parsed) return null;
    return formatDateAnnotation(
      parsed,
      new Date(this.nowSignal()),
      undefined,
      prefs.treeDateAnnotationUnits,
      prefs.treeDateAnnotationFriendlyForms,
    );
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
      assumeUtcForIsoDateOnly: prefs.treeAssumeUtcForIsoDateOnly,
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

  /**
   * Returns the leading-comment text attached to `node`'s path, or
   * `null` when there is no comment data or no leading comment for
   * this node. The renderer uses this for the inline slot before the
   * key on value rows and on container open rows.
   */
  leadingComment(node: TreeNode): string | null {
    const map = this.commentsByPath();
    if (!map) return null;
    return map.get(node.pathString)?.leading ?? null;
  }

  /**
   * Returns the trailing-comment text attached to `node`'s primary
   * row, or `null` when there is no comment data or no trailing
   * comment for this row.
   *
   * For primitives and empty containers (rendered as a single row
   * that serves as both open and close), this MERGES every
   * applicable bundle field in source order so that no comment is
   * hidden: `trailing` (open-row), then `closeLeading` (between
   * brace and close, drained at container end), then `closeTrailing`
   * (after the close brace). Only the first line shows in the row
   * preview; the tooltip surfaces the full text.
   *
   * For non-empty containers (which render an open row + children +
   * a separate close row), this returns only `bundle.trailing`
   * (the open-row trailing slot). The close row uses
   * `closeLeadingComment(node)` and `closeTrailingComment(node)`.
   */
  trailingComment(node: TreeNode): string | null {
    const map = this.commentsByPath();
    if (!map) return null;
    const bundle = map.get(node.pathString);
    if (!bundle) return null;
    const isInlineRow = !node.children || node.children.length === 0;
    if (isInlineRow) {
      const parts = [bundle.trailing, bundle.closeLeading, bundle.closeTrailing].filter(
        (part): part is string => part !== undefined,
      );
      return parts.length > 0 ? parts.join('\n') : null;
    }
    return bundle.trailing ?? null;
  }

  /**
   * Returns the close-row leading-comment text attached to a
   * non-empty container node's close row, or `null` when absent.
   * Rendered before the close brace, so a row reads as
   * `[closeLeading]  }  [closeTrailing]`. Only meaningful for
   * object / array nodes that have children (i.e. are rendered as
   * open + children + close); empty containers fold into
   * `trailingComment` via the merge fallback.
   */
  closeLeadingComment(node: TreeNode): string | null {
    const map = this.commentsByPath();
    if (!map) return null;
    return map.get(node.pathString)?.closeLeading ?? null;
  }

  /**
   * Returns the close-row trailing-comment text attached to a
   * non-empty container node's close row, or `null` when absent.
   * Only meaningful for object / array nodes that have children
   * (i.e. are rendered as open + children + close).
   */
  closeTrailingComment(node: TreeNode): string | null {
    const map = this.commentsByPath();
    if (!map) return null;
    return map.get(node.pathString)?.closeTrailing ?? null;
  }

  /**
   * First-line preview of a comment for the inline slot. Multi-line
   * or stacked comments collapse to their first line in the row;
   * the full text is surfaced via `matTooltip` on hover.
   */
  commentFirstLine(text: string): string {
    const newlineIndex = text.indexOf('\n');
    return newlineIndex === -1 ? text : text.slice(0, newlineIndex);
  }

  private emitSlowExpandIfNeeded(timeMs: number, depth: number, nodeCount: number): void {
    if (timeMs <= TREE_EXPAND_SLOW_THRESHOLD_MS) {
      return;
    }
    this.logger.event(
      'tree.expand.slow',
      { cold: isColdAndMark('tree.expand.slow') },
      { timeMs, depth, nodeCount },
    );
  }

  private buildRoot(raw: unknown): TreeNode {
    const start = performance.now();
    const counter: TreeBuildCounter = { nodeCount: 1 };
    const root: TreeNode = {
      segment: undefined,
      path: [],
      pathString: '$',
      value: raw,
      type: jsonTypeOf(raw),
      depth: 0,
    };
    if (root.type === 'object' || root.type === 'array') {
      root.children = this.buildChildren(raw, [], counter);
    }
    const nodeCount = counter.nodeCount;
    this.latestBuildNodeCount = nodeCount;
    const timeMs = performance.now() - start;
    if (timeMs > TREE_BUILD_SLOW_THRESHOLD_MS) {
      this.logger.event(
        'tree.build.slow',
        {
          cold: isColdAndMark('tree.build.slow'),
          nodeCountBucket: bucketCount(nodeCount),
        },
        { timeMs, nodeCount },
      );
    }
    return root;
  }

  private buildChildren(
    value: unknown,
    parentPath: (string | number)[],
    counter: TreeBuildCounter,
  ): TreeNode[] {
    if (Array.isArray(value)) {
      return value.map((child, index) =>
        this.buildNode(index, child, [...parentPath, index], counter),
      );
    }
    if (value && typeof value === 'object') {
      const objectValue = value as Record<string, unknown>;
      return Object.keys(objectValue).map((key) =>
        this.buildNode(key, objectValue[key], [...parentPath, key], counter),
      );
    }
    return [];
  }

  private buildNode(
    segment: string | number,
    value: unknown,
    path: (string | number)[],
    counter: TreeBuildCounter,
  ): TreeNode {
    counter.nodeCount += 1;
    const type = jsonTypeOf(value);
    const node: TreeNode = {
      segment,
      path,
      pathString: this.formatPath(path),
      value,
      type,
      depth: path.length,
    };
    if (type === 'object' || type === 'array') {
      node.children = this.buildChildren(value, path, counter);
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
