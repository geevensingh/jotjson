import { ScrollingModule, type CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  Injector,
  afterNextRender,
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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatDialog } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatMenuTrigger } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { filter, finalize, take, timeout } from 'rxjs';
import type {
  BlobHighlight,
  FormattingIcon,
  FormattingRuleSet,
  SearchMatchMode,
} from '../../../core/api/models';
import { RuleSetsService } from '../../../core/api/rule-sets.service';
import { BeaconNavigationService } from '../../../core/beacons/beacon-navigation.service';
import { ClipboardCopyService } from '../../../core/clipboard/clipboard-copy.service';
import type { ExtractedJson } from '../../../core/json/json-extractor.service';
import { CommentBundle, JsonParserService } from '../../../core/json/json-parser.service';
import { displayKey as displayKeyHelper } from '../../../core/json/key-display';
import { bucketColorHex } from '../../../core/preferences/pref-summarize';
import { PreferencesService } from '../../../core/preferences/preferences.service';
import { bucketCount, bucketLineCount } from '../../../core/telemetry/buckets';
import { isColdAndMark } from '../../../core/telemetry/cold-flag';
import { LoggerService } from '../../../core/telemetry/logger.service';
import { OverflowDetectorDirective } from '../../directives/overflow-detector.directive';
import { JJ_MENU_IMPORTS } from '../../material/jj-menu-imports';
import { JsonValueType } from '../../pipes/json-type.pipe';
import { ParsedDate, formatDateAnnotation, parseAsDate } from '../../utils/date-detect';
import { classifyJsonValue, isJsonValueEmpty } from '../../utils/formatting-value-kind';
import { ValueClassification, classifyValue } from '../../utils/value-classifier';
import { IconComponent, type JjIconName } from '../icon/icon.component';
import {
  JsonBreadcrumbComponent,
  type BreadcrumbClick,
  type BreadcrumbContextMenu,
  type BreadcrumbCrumb,
} from '../json-breadcrumb/json-breadcrumb.component';
import { computeAutoFitDepth } from './auto-fit-depth';
import { buildTree, formatPath, type TreeNode } from './build-tree';
import {
  DecodedValueDialogComponent,
  type DecodedValueDialogData,
  type DecodedValueDialogResult,
} from './decoded-value-dialog/decoded-value-dialog.component';
import { buildVisibleIndexMap, flatten, type FlatItem } from './flatten';
import { EMPTY_BEACON_INDEX, buildBeaconIndex, type BeaconIndex } from './formatting-beacons-index';
import {
  EMPTY_RULE_RESULT,
  RuleEngineNode,
  RuleEngineResult,
  evaluateFormattingRules,
} from './formatting-rules-engine';
import {
  HIGHLIGHT_PALETTE_DARK,
  HIGHLIGHT_PALETTE_LIGHT,
  contrastText,
  type PaletteSwatch,
} from './highlight-palette';
import type { ResolvedHighlight } from './highlight-resolver';
import { findNearestCascade, indexHighlights, resolveManualHighlight } from './highlight-resolver';
import { findScrollableAncestor } from './scroll-container';
export type { TreeNode };

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

export interface TreeExtractRequest {
  path: (string | number)[];
  sourceVersion: number;
  replacement: ExtractedJson;
  source: 'rowPillPrimitiveArray' | 'contextMenu' | 'decodedDialog';
}

/**
 * Build a haystack-predicate for the current match mode. Extracted to
 * a module-level helper so `searchHitData` stays a thin orchestrator
 * and the per-mode matcher is independently testable.
 *
 * For `'regex'`, returns a predicate that calls `RegExp.test`; if the
 * pattern is invalid, returns `null` so the caller can short-circuit
 * the tree walk entirely instead of doing O(N) wasted work calling a
 * `() => false` predicate on every node. The red-border
 * `searchRegexInvalid` computed signals the error to the user
 * separately.
 *
 * For the four anchored modes (`'contains'`, `'starts_with'`,
 * `'ends_with'`, `'exact'`), returns a predicate using plain string
 * operations with case-normalization computed once. These modes
 * cannot fail to compile, so the return type's `null` arm only fires
 * for invalid regex.
 */
function buildMatcher(
  mode: SearchMatchMode,
  query: string,
  caseSensitive: boolean,
): ((hay: string) => boolean) | null {
  if (mode === 'regex') {
    try {
      const re = new RegExp(query, (caseSensitive ? '' : 'i') + 'm');
      return (hay) => re.test(hay);
    } catch {
      return null;
    }
  }
  const needle = caseSensitive ? query : query.toLowerCase();
  const norm = (hay: string): string => (caseSensitive ? hay : hay.toLowerCase());
  switch (mode) {
    case 'contains':
      return (hay) => norm(hay).includes(needle);
    case 'starts_with':
      return (hay) => norm(hay).startsWith(needle);
    case 'ends_with':
      return (hay) => norm(hay).endsWith(needle);
    case 'exact':
      return (hay) => norm(hay) === needle;
  }
}

/**
 * Haystack-policy rule for the value side of `searchHitData`. Named
 * helper so the asymmetry between `'contains'` (JSON-escaped form so
 * typing `"hello"` with quotes works) and the other four modes (raw
 * string value) is explicit and pinning-testable. Pre-rename this
 * was a `rawForStrings: regexMode` ternary inline at the call site.
 *
 * See `DESIGN_SPEC.md` §Search highlight mode table.
 */
function valueHaystackOpts(mode: SearchMatchMode): { rawForStrings: boolean } {
  return { rawForStrings: mode !== 'contains' };
}

interface ManualHighlightRows {
  resolvedHighlightsByPath: ReadonlyMap<string, ResolvedHighlight>;
  cascadeHighlightsByPath: ReadonlyMap<string, { path: string; color: string }>;
}

/**
 * Discriminated metadata for the single-item elevation logic on the
 * Subtree submenu (v0.19.4). When the Subtree submenu would only
 * contain one visible item, the row context menu elevates that item
 * to the row level instead of nesting it behind a `Subtree >` flyout.
 *
 * - `'highlightTree'`: only Highlight subtree visible. Elevated as
 *   `Highlight subtree >` (label restored to carry the scope outside
 *   of the Subtree submenu's name context).
 * - `'removeTreeHighlight'`: only Remove subtree highlight.
 * - `'collapse'`: only Collapse from here (and the surfaced row is
 *   not already showing the same action).
 * - `'collapseSame'`: would-be Collapse, but the surfaced shortcut
 *   row already shows it. Suppress everything; no Subtree contribution.
 * - `'isolate'`: only single-mode Isolate. Pair mode (showIsolatePair)
 *   contributes 2 items so it never elevates singly.
 * - `'expandSingle'`: the only Subtree contribution is the Expand
 *   section, AND that section has exactly one visible item, AND that
 *   item is not already on the surfaced shortcut. The single Expand
 *   action also elevates past the (would-be) Expand flyout. The
 *   `expandRow`-default + `maxDescendantDepth === 1` case (lone +1
 *   redundant with the bolded surfaced shortcut) is suppressed
 *   upstream by `isLoneDepth1RedundantWithSurfaced`, so that
 *   condition never reaches this elevation arm in v0.23.0+.
 * - `'expandSubmenu'`: the only Subtree contribution is the Expand
 *   section with 2+ items. The Expand flyout itself is elevated
 *   (renders directly off the row menu instead of nested inside
 *   Subtree).
 */
type SubtreeElevatedAction =
  | { kind: 'highlightTree' }
  | { kind: 'removeTreeHighlight' }
  | { kind: 'collapse' }
  | { kind: 'collapseSame' }
  | { kind: 'isolate'; mode: 'single' }
  | { kind: 'expandSingle'; single: ExpandSingleAction }
  | { kind: 'expandSubmenu' };

/**
 * Discriminated metadata for the single-item elevation logic on the
 * Expand sub-submenu (v0.19.4). When the Expand sub-submenu would
 * only contain one visible item, that item elevates one level up
 * (into the Subtree submenu, or further if Subtree itself elevates).
 *
 * In v0.23.0 the deep `Expand > All` leaf was retired in favour of a
 * dedicated top-level `Expand all from here` row, so the
 * `{ kind: 'expandAll' }` variant was removed: the Expand sub-submenu
 * (and its single-item elevation) is now purely depth-based.
 */
export type ExpandSingleAction = { kind: 'expandToDepth'; depth: number };

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
// Phase 2 (issue #95) tightened the render-slow ceiling once virtualization
// dropped the render-time floor from ~5,000 ms (mat-tree, wide-aoo @ 10k) to
// the new O(viewport-size) regime. The placeholder lives here until Phase 3
// re-anchors it on 2 * P95 of a fresh post-Phase-2 baseline.
const TREE_RENDER_SLOW_THRESHOLD_MS = 30;
const TREE_EXPAND_SLOW_THRESHOLD_MS = 10;

/**
 * String length above which a string leaf is considered a "decoded
 * candidate" even when it carries no JSON-escape-worthy characters.
 * Roughly two desktop screen widths at default tree font size, so
 * any value beyond this is hard to read in a single ellipsised row
 * and is reachable through the dialog viewer pill.
 */
const DECODED_LONG_THRESHOLD_CHARS = 256;

/**
 * Maximum number of source characters embedded in a `matTooltip`
 * popup. Long string values (URLs, base64 IDs, multi-line decoded
 * payloads) are clamped before being shown so the tooltip remains
 * a glance affordance, not a wall of text. Values exceeding this
 * cap are always reachable in full through the decoded value
 * viewer dialog because `decodedCandidate()` widens to include
 * `length > DECODED_LONG_THRESHOLD_CHARS`.
 */
const MAX_TOOLTIP_LEN_CHARS = 1024;

/**
 * Frozen empty-array sentinel returned by `keyIcons` / `valueIcons`
 * when the engine projects no icons. Identity-shared so `OnPush`
 * change detection treats unchanged rows as equal.
 */
const EMPTY_ICONS: readonly FormattingIcon[] = Object.freeze([]);

/**
 * Interactive tree viewer for parsed JSON, built on
 * `@angular/cdk/scrolling`'s `<cdk-virtual-scroll-viewport>` with
 * fixed-size items. The component flattens the parsed `TreeNode`
 * graph (DFS, honoring `expandedPaths`) into a `FlatItem[]` and
 * renders only the rows visible in the viewport, so a multi-MB
 * blob renders without freezing the UI (issue #95 Phase 2).
 * JsonParserService is the source of the value.
 */
@Component({
  selector: 'jj-json-tree',
  standalone: true,
  imports: [
    FormsModule,
    ...JJ_MENU_IMPORTS,
    MatTooltipModule,
    ScrollingModule,
    MatDividerModule,
    IconComponent,
    JsonBreadcrumbComponent,
    OverflowDetectorDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './json-tree.component.html',
  styleUrls: ['./json-tree.component.scss', './json-tree-highlights.scss'],
})
export class JsonTreeComponent {
  private readonly prefs = inject(PreferencesService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly clipboardCopy = inject(ClipboardCopyService);
  private readonly jsonParser = inject(JsonParserService);
  private readonly ruleSets = inject(RuleSetsService);
  private readonly logger = inject(LoggerService);
  private readonly beaconNav = inject(BeaconNavigationService);
  private readonly dialog = inject(MatDialog);

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
   * Selection-state ownership (issue #266 invariant doc block;
   * tightened by issue #274).
   *
   * `selectedPath` is read/written by three coordinated effects
   * and a set of intentional writers. Intentional writers route
   * through `setUserSelection()` (issue #274) so the "clear
   * pending then set" idiom lives in exactly one place; the
   * `check-prod-patterns.mjs` `selected-path-set` rule rejects
   * raw `selectedPath.set(...)` writes outside that helper
   * (system-clear writes carry the trailing pragma
   * `// allow:selected-path-set <category>`).
   *
   * Effects (run in declaration order within a CD flush):
   * 1. preserve-or-clear effect: reacts to nodeIndex / root /
   *    viewResetToken changes. Reads selectedPath via untracked()
   *    (load-bearing -- removing untracked breaks the invariant).
   *    Writes selectedPath when prior path vanished or view reset
   *    (system-clear; raw write, pragma-tagged).
   * 2. retry-pending effect (issue #266): reacts to nodeIndex
   *    changes when pending != null. Applies pending via
   *    `setUserSelection()` (issue #274) if discriminator says
   *    "passive preserve" (selected === priorSelected) or
   *    "system cleared" (selected === null). Otherwise discards
   *    pending via `clearPendingSelectPath()`.
   * 3. dedup-emit effect (PR #261 / grep `lastEmittedSelectedPath`):
   *    reacts to selectedPath changes; emits selectionChange exactly
   *    once per net change.
   *
   * Intentional writers (each routes through `setUserSelection()`):
   *  - `onSelect` (mouse click on row)
   *  - keyboard Enter / Space handler
   *  - `clearSelection` (Escape via `onDocumentEscape` HostListener)
   *  - `goToNextMatch` / `goToPrevMatch` (search nav)
   *  - `onKebabClick` (context menu)
   *  - `activateClickedHitOrFirst` (search-result-click cycling;
   *    microtask-deferred but the originating gesture is user click)
   *  - `selectByPathString` immediate-apply branch (programmatic,
   *    path already in nodeIndex)
   *  - `selectByPathString` null-clear branch (programmatic clear)
   *  - retry-pending effect apply branch (issue #266; same idiom)
   *
   * System-clear writers (raw `selectedPath.set(null)` with
   * `// allow:selected-path-set system-clear` pragma; do NOT
   * clear pending because the retry-pending discriminator needs
   * to distinguish system-clear-because-prior-path-vanished
   * (apply pending) from intentional-clear (discard pending)):
   *  - preserve-or-clear effect (the three sites in the
   *    nodeIndex / viewResetToken reaction).
   *
   * The retry-pending effect's discriminator is now a defensive
   * backstop: every intentional writer clears pending
   * synchronously via the helper, so the discriminator only
   * fires when a writer bypasses the helper (which the lint
   * guard rejects in production code). Tests at
   * `'defensive backstop: discriminator discards stale pending
   * if a writer bypasses setUserSelection'` cover this path.
   *
   * Exception to AGENTS.md s4 ("effect() only for syncing to
   * external systems"): effects #1 and #2 do signal-to-signal
   * state derivation. This is consistent with the established
   * pattern in this file (PR #261 set the precedent with the
   * dedup-emit effect) because tree-state reconciliation across
   * async `nodeIndex` rebuilds genuinely doesn't fit a
   * `computed()`.
   *
   * Path of the currently-selected tree row, or `null` for no selection.
   * Stored as `pathString` (display form) so the value survives mat-tree
   * re-renders that recreate node objects. We never reverse-parse it - all
   * lookups go through `nodeIndex`.
   */
  readonly selectedPath = signal<string | null>(null);

  /**
   * Issue #266 defer/retry state for `selectByPathString`. When the
   * caller asks for a path the current `nodeIndex` does not yet
   * contain (typical mid-typing case from the home component's
   * editor-cursor sync), the path is stored here and the retry-
   * pending effect applies it once `nodeIndex` catches up.
   *
   * Plain fields (not signals) because they are mutated from many
   * sites including effect bodies, and the retry effect reads them
   * via plain access inside `untracked` -- signal tracking would
   * cause spurious re-runs.
   */
  private pendingSelectPathString: string | null = null;

  /**
   * Companion to `pendingSelectPathString` (#266). Captured at
   * defer time so the retry effect can discriminate "system
   * cleared because prior path vanished" (apply pending) from
   * "user clicked a different row" (discard pending) by comparing
   * the current `selectedPath()` against this snapshot.
   */
  private pendingPriorSelectedPath: string | null = null;

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
   * Phase 2 (issue #95) -- mirror of the CDK virtual scroll viewport's
   * `renderedRangeStream` so the focus-snap effect can react. Half-open
   * range `[start, end)` over `flatList()` indices. Written from a
   * subscribe in the constructor once `viewport()` mounts; read by
   * the snap effect that keeps `tabindex="0"` inside the rendered
   * window after user scroll.
   */
  private readonly renderedRange = signal<{ start: number; end: number }>({ start: 0, end: 0 });

  /**
   * Phase 2 (issue #95), round 2 PR-feedback follow-up -- guard
   * against the snap effect chasing a programmatic scroll. `moveFocusTo`
   * sets this to `true` when it starts a `viewport.scrollToIndex` for
   * an unmounted target row; the snap effect short-circuits while
   * the flag is `true` so it doesn't clobber `focusedPath` to a
   * mid-flight intermediate row before the target lands in the
   * rendered range. Cleared via `finalize()` on the renderedRangeStream
   * subscription so success, error/timeout, and viewport-destroy all
   * converge on the same clear; gated on `moveFocusToken` so stale
   * subscriptions from prior calls cannot clear the flag during a
   * later in-flight move.
   */
  private readonly focusingProgrammatically = signal(false);

  /**
   * Phase 2 (issue #95), round 2 PR-feedback follow-up -- monotonic
   * token for coalescing back-to-back `moveFocusTo` calls (key-repeat
   * scenario). Each call increments the token; subsequent rAF /
   * subscription callbacks check `myToken === this.moveFocusToken`
   * before acting so only the most-recent call commits focus.
   */
  private moveFocusToken = 0;

  /**
   * Phase 2 (issue #95) -- authoritative expansion state, replacing
   * the previous `treeControl.expansionModel` mirror. Path-keyed
   * over `TreeNode.pathString`. Not reset on `root()` change
   * (Locked decision 7) so user expansions survive editor edits.
   *
   * Mutation rules:
   *  - User toggles (chevron click, keyboard, dblclick) go through
   *    `setExpanded(node, on)` which clones the Set once per click.
   *  - Bulk ops (`expandAll`, `expandToLevel`, `collapseAll`, etc.)
   *    go through `setExpandedBulk(next)` so one bulk op writes the
   *    signal exactly once.
   */
  private readonly expandedPaths = signal<ReadonlySet<string>>(new Set());

  /**
   * Phase 2 (issue #95) -- the row pixel height measured from the
   * offscreen probe row. `0` until the first probe measurement
   * lands. Consumers should read `effectiveRowHeightPx()` instead
   * (which falls back to a font-size-derived default before the
   * probe has measured), since `CdkFixedSizeVirtualScroll` treats
   * `[itemSize]="0"` as undefined behavior. Updated reactively
   * whenever `treeFontSize` / `showTypeLabels` /
   * `showDateAnnotations` change.
   */
  readonly measuredRowHeightPx = signal(0);

  /**
   * Phase 2 (issue #95) -- the row pixel height the
   * `<cdk-virtual-scroll-viewport>` actually binds to via
   * `[itemSize]`. Falls back to a font-size-derived default
   * (`ceil(fontSize * 1.6)`) before the probe row has rendered so
   * the viewport can paint from frame 1 without flashing. Once the
   * real measurement lands the signal switches to it. Tests that
   * never attach the fixture to `document.body` still get a
   * non-zero `[itemSize]` via this path.
   */
  readonly effectiveRowHeightPx = computed(
    () => this.measuredRowHeightPx() || Math.ceil(this.treeFontSize() * 1.6),
  );

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
   * height. Carries every height-driving element (twisty, key,
   * value, date-annotation, comment, kebab pill, extract pill,
   * decoded pill) so the measured height is an upper bound across
   * any row that may render. Consumed by BOTH
   * `runAutoFitInitialExpansion` (capacity calc) and the virtual
   * scroll viewport's `[itemSize]` binding via
   * `measuredRowHeightPx()`.
   */
  private readonly rowHeightProbe = viewChild<ElementRef<HTMLElement>>('rowHeightProbe');

  /**
   * Reference to the `<cdk-virtual-scroll-viewport>` element, used
   * by `expandAndScroll` to scroll the minimum amount needed to
   * reveal a path (true `'nearest'`-equivalent semantics) and by
   * `measureAndUpdate` to preserve the user's logical scroll
   * position across font-size changes.
   */
  private readonly viewport = viewChild<CdkVirtualScrollViewport>('viewport');

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
  readonly searchMatchModeTooltip = $localize`:@@tree.search.matchMode.tooltip:Match mode`;
  readonly searchMatchModeContainsLabel = $localize`:@@tree.search.matchMode.contains:Contains`;
  readonly searchMatchModeStartsWithLabel = $localize`:@@tree.search.matchMode.startsWith:Starts with`;
  readonly searchMatchModeEndsWithLabel = $localize`:@@tree.search.matchMode.endsWith:Ends with`;
  readonly searchMatchModeExactLabel = $localize`:@@tree.search.matchMode.exact:Exact match`;
  readonly searchMatchModeRegexLabel = $localize`:@@tree.search.matchMode.regex:Regex (.*)`;
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
  // styling alone is the visible signal for the dblclick-equivalent
  // action; the a11y equivalent is the `.sr-only` hint span below.
  readonly defaultActionA11yHint = $localize`:@@tree.contextMenu.defaultActionA11yHint:; same as double-clicking the row`;
  // Subtree submenu (Path Y). Trigger label and items inside drop the
  // "from here" / "subtree" suffix because the submenu name carries
  // the scope.
  readonly ctxSubtreeMenuLabel = $localize`:@@tree.contextMenu.subtreeMenu:Subtree`;
  readonly ctxSubtreeCollapseLabel = $localize`:@@tree.contextMenu.subtreeCollapse:Collapse`;
  readonly ctxSubtreeExpandMenuLabel = $localize`:@@tree.contextMenu.subtreeExpandMenu:Expand`;
  // Per-depth labels inside the Subtree -> Expand submenu. Source text
  // uses the "+N level(s)" form per DESIGN_SPEC.md §516 (relative,
  // expand-only) -- distinct from the toolbar's snap-to-exact dropdown.
  // Depths 1-9 mirror the toolbar's `Expand to Level` dropdown range
  // (v0.23.0). `showExpandToDepth` hides entries that exceed the
  // subtree's reachable container depth, so depths 6-9 only render
  // for subtrees deep enough to need them.
  readonly ctxExpandToDepth1Label = $localize`:@@tree.contextMenu.expandToDepth.1:+1 level`;
  readonly ctxExpandToDepth2Label = $localize`:@@tree.contextMenu.expandToDepth.2:+2 levels`;
  readonly ctxExpandToDepth3Label = $localize`:@@tree.contextMenu.expandToDepth.3:+3 levels`;
  readonly ctxExpandToDepth4Label = $localize`:@@tree.contextMenu.expandToDepth.4:+4 levels`;
  readonly ctxExpandToDepth5Label = $localize`:@@tree.contextMenu.expandToDepth.5:+5 levels`;
  readonly ctxExpandToDepth6Label = $localize`:@@tree.contextMenu.expandToDepth.6:+6 levels`;
  readonly ctxExpandToDepth7Label = $localize`:@@tree.contextMenu.expandToDepth.7:+7 levels`;
  readonly ctxExpandToDepth8Label = $localize`:@@tree.contextMenu.expandToDepth.8:+8 levels`;
  readonly ctxExpandToDepth9Label = $localize`:@@tree.contextMenu.expandToDepth.9:+9 levels`;
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
  // Elevated labels (v0.19.4): when a Subtree-scoped item is the
  // sole Subtree child, it elevates to row level. The submenu's
  // scope is no longer carried by the menu name, so the label
  // restores the "subtree" / "from here" qualifier explicitly.
  // Each i18n ID is new (these strings did not exist pre-v0.19.4).
  readonly ctxHighlightTreeElevatedLabel = $localize`:@@tree.contextMenu.highlightTree.elevated:Highlight subtree`;
  readonly ctxRemoveTreeHighlightElevatedLabel = $localize`:@@tree.contextMenu.removeTreeHighlight.elevated:Remove subtree highlight`;
  readonly ctxExpandFromHereElevatedMenuLabel = $localize`:@@tree.contextMenu.expandFromHere.elevatedMenu:Expand from here`;
  readonly ctxExpandAllFromHereElevatedLabel = $localize`:@@tree.contextMenu.expandAllFromHere.elevated:Expand all from here`;
  readonly ctxExpandToDepth1ElevatedLabel = $localize`:@@tree.contextMenu.expandToDepth.1.elevated:Expand 1 level from here`;
  readonly ctxExpandToDepth2ElevatedLabel = $localize`:@@tree.contextMenu.expandToDepth.2.elevated:Expand 2 levels from here`;
  readonly ctxExpandToDepth3ElevatedLabel = $localize`:@@tree.contextMenu.expandToDepth.3.elevated:Expand 3 levels from here`;
  readonly ctxExpandToDepth4ElevatedLabel = $localize`:@@tree.contextMenu.expandToDepth.4.elevated:Expand 4 levels from here`;
  readonly ctxExpandToDepth5ElevatedLabel = $localize`:@@tree.contextMenu.expandToDepth.5.elevated:Expand 5 levels from here`;
  readonly ctxExpandToDepth6ElevatedLabel = $localize`:@@tree.contextMenu.expandToDepth.6.elevated:Expand 6 levels from here`;
  readonly ctxExpandToDepth7ElevatedLabel = $localize`:@@tree.contextMenu.expandToDepth.7.elevated:Expand 7 levels from here`;
  readonly ctxExpandToDepth8ElevatedLabel = $localize`:@@tree.contextMenu.expandToDepth.8.elevated:Expand 8 levels from here`;
  readonly ctxExpandToDepth9ElevatedLabel = $localize`:@@tree.contextMenu.expandToDepth.9.elevated:Expand 9 levels from here`;
  readonly preferredHighlightLabel = $localize`:@@tree.highlight.swatch.preferred:Preferred`;
  readonly kebabAriaLabel = $localize`:@@tree.kebab.aria:Row actions`;
  readonly kebabTitleLabel = $localize`:@@tree.kebab.title:Row actions`;

  // Decoded viewer (per-row): mirrors the Extract pill but is purely
  // a display affordance - clicking it opens the dedicated decoded
  // value dialog rather than mutating any per-row state. Inline
  // string rendering stays in the JSON-escaped form so every tree
  // row is uniform-height (issue #95 Phase 0). The single label
  // covers both the row-pill and kebab-menu entry points; the prior
  // show/hide pair was retired alongside the inline toggle.
  readonly decodedOpenDialogTitleLabel = $localize`:@@tree.decoded.pill.openDialog.title:Open decoded value`;
  readonly decodedOpenDialogAriaLabel = $localize`:@@tree.decoded.pill.openDialog.aria:Open decoded value in a viewer`;
  readonly decodedOpenDialogWithExtractTitleLabel = $localize`:@@tree.decoded.pill.openDialogWithExtract.title:Inspect value (Extract available)`;
  readonly decodedOpenDialogWithExtractAriaLabel = $localize`:@@tree.decoded.pill.openDialogWithExtract.aria:Inspect value; an Extract option is available inside`;
  readonly decodedOpenDialogMenuLabel = $localize`:@@tree.decoded.menu.openDialog:Open decoded value`;

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

  // Phase 2 (issue #95) -- expansion-state helpers.
  //
  // The helper shape was introduced in Phase 0.5 against MatTree's
  // `treeControl`; Phase 2 swaps the bodies to read / write the
  // authoritative `expandedPaths` signal directly. The
  // `__getHelpersForTesting()` seam keeps the same surface so the ~96
  // spec callsites that migrated in Phase 0.5 continue to work.
  //
  // Single-node setters clone the Set once per call (signal write
  // semantics demand a fresh reference for change detection); bulk
  // operations route through `setExpandedBulk` so an N-node bulk op
  // produces exactly one signal write.

  protected isExpanded(node: TreeNode): boolean {
    return this.expandedPaths().has(node.pathString);
  }

  private setExpanded(node: TreeNode, on: boolean): void {
    const current = this.expandedPaths();
    if (on === current.has(node.pathString)) return;
    const next = new Set(current);
    if (on) next.add(node.pathString);
    else next.delete(node.pathString);
    this.expandedPaths.set(next);
  }

  private toggleExpanded(node: TreeNode): void {
    this.setExpanded(node, !this.isExpanded(node));
  }

  private collapseAllNodes(): void {
    if (this.expandedPaths().size === 0) return;
    this.expandedPaths.set(new Set());
  }

  /**
   * Phase 2 (issue #95) -- one signal write per bulk expansion change.
   * Callers (e.g. `expandAll`, `expandToLevel`, `expandAllFromHere`,
   * `expandAndScroll` ancestor walk) build the next Set in one pass
   * and hand it off here. Skip the write entirely if nothing changed
   * to keep change detection quiet.
   */
  private setExpandedBulk(next: ReadonlySet<string>): void {
    const current = this.expandedPaths();
    if (next === current) return;
    if (next.size === current.size) {
      let equal = true;
      for (const path of next) {
        if (!current.has(path)) {
          equal = false;
          break;
        }
      }
      if (equal) return;
    }
    this.expandedPaths.set(next);
  }

  // Test seam exposing the private expansion helpers + a flat-list-
  // backed node lookup (replacing the prior `treeControl.dataNodes`
  // spec access). Spec calls go through this seam so the production
  // helpers stay private. `expandedPaths` is exposed read-only so the
  // Phase 2 invariant spec can audit the authoritative state directly
  // without poking at private fields.
  __getHelpersForTesting() {
    return {
      isExpanded: (node: TreeNode): boolean => this.isExpanded(node),
      setExpanded: (node: TreeNode, on: boolean): void => this.setExpanded(node, on),
      toggleExpanded: (node: TreeNode): void => this.toggleExpanded(node),
      collapseAllNodes: (): void => this.collapseAllNodes(),
      findNode: (predicate: (n: TreeNode) => boolean): TreeNode | null => {
        const item = this.flatList().find((row) => row.kind !== 'close' && predicate(row.node));
        return item?.node ?? null;
      },
      readExpandedPaths: (): ReadonlySet<string> => this.expandedPaths(),
      // Perf-bench accessor: the L2 bench needs to drive
      // `viewport.scrollToOffset()` directly to simulate user scroll
      // after the Phase 2 (issue #95) virtualization landed. Kept here
      // rather than exposing `viewport` publicly so the production API
      // surface stays narrow.
      getViewport: (): CdkVirtualScrollViewport | undefined => this.viewport(),
      // Test seam for the cursor-aware non-hit fallback path. Production
      // entry points (`findByKey`, `findByValue`) always force the
      // clicked row's key/value into the search, which guarantees the
      // path lands in the hit set. The non-hit branch only fires when
      // a future caller passes an unmatched path (e.g. a JSON-escape
      // mismatch like issue #238). Exposed here so the unit test can
      // exercise the at-or-after fallback directly.
      activateClickedHitOrFirst: (path: string): void => this.activateClickedHitOrFirst(path),
    };
  }

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
   * Ordered list of paths matching the current query in **document
   * order** (depth-first, root-to-leaf walk via `searchHitData`).
   * Backs prev/next navigation and the displayed match count, and is
   * load-bearing for cursor-aware navigation: the
   * `firstHitIndexAfter` / `lastHitIndexBefore` /
   * `firstHitIndexAtOrAfter` helpers rely on `paths` being sorted by
   * the same `nodeOrder` map they consult. Any future change to
   * `searchHitData` must preserve the document-order invariant.
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
    if (this.prefs.prefs().searchMatchMode !== 'regex') return false;
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
   * The computed reads `expandedPaths()` (through `this.isExpanded`)
   * so any toggle / expand / collapse flow re-evaluates the bolding
   * without requiring components to track the expansion set
   * directly.
   */
  readonly defaultActionKind = computed<'copyValue' | 'collapseRow' | 'expandRow' | 'none'>(() => {
    const cn = this.contextNode();
    if (!cn) return 'none';
    if ((cn.type === 'object' || cn.type === 'array') && cn.children?.length) {
      return this.isExpanded(cn) ? 'collapseRow' : 'expandRow';
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
   * Localized label for the match-mode dropdown trigger and menu
   * items. Used by the `searchMatchModeButtonLabel` computed and the
   * template's `@for` over `matchModes`.
   */
  matchModeLabel(mode: SearchMatchMode): string {
    switch (mode) {
      case 'contains':
        return this.searchMatchModeContainsLabel;
      case 'starts_with':
        return this.searchMatchModeStartsWithLabel;
      case 'ends_with':
        return this.searchMatchModeEndsWithLabel;
      case 'exact':
        return this.searchMatchModeExactLabel;
      case 'regex':
        return this.searchMatchModeRegexLabel;
    }
  }

  /**
   * Ordered list driving the type-filter dropdown. `'all'` is first
   * (the no-filter sentinel) followed by every `ValueClassification`
   * value except `'undefined'` (no JSON `undefined`).
   */
  readonly searchValueTypes: readonly SearchValueType[] = SEARCH_VALUE_TYPES;

  readonly searchScope = computed(() => this.prefs.prefs().searchScope);
  readonly searchCaseSensitive = computed(() => this.prefs.prefs().searchCaseSensitive);
  readonly searchMatchMode = computed(() => this.prefs.prefs().searchMatchMode);
  readonly searchValueType = computed(() => this.prefs.prefs().searchValueType);

  readonly searchScopeButtonLabel = computed(() => this.scopeLabel(this.searchScope()));
  readonly searchValueTypeButtonLabel = computed(() => this.valueTypeLabel(this.searchValueType()));
  readonly searchMatchModeButtonLabel = computed(() => this.matchModeLabel(this.searchMatchMode()));

  /**
   * Ordered list driving the match-mode dropdown. Order also defines
   * the Alt+R cycle sequence: contains -> starts_with -> ends_with ->
   * exact -> regex -> contains.
   */
  readonly matchModes: readonly { mode: SearchMatchMode; label: () => string }[] = [
    { mode: 'contains', label: () => this.searchMatchModeContainsLabel },
    { mode: 'starts_with', label: () => this.searchMatchModeStartsWithLabel },
    { mode: 'ends_with', label: () => this.searchMatchModeEndsWithLabel },
    { mode: 'exact', label: () => this.searchMatchModeExactLabel },
    { mode: 'regex', label: () => this.searchMatchModeRegexLabel },
  ];

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
    const mode = prefs.searchMatchMode;
    // Build the predicate up-front so we can short-circuit before the
    // tree walk on invalid regex (where `buildMatcher` returns null).
    // Pre-fix the matcher always returned a function, so this short-
    // circuit was dead code and an invalid regex walked the entire
    // tree calling `() => false` on every node - O(N) wasted work
    // per keystroke for large blobs. The explicit if/else gives `test`
    // a non-nullable type past this block (TypeScript can't narrow
    // a nullable across the closure boundary into `walk`).
    let test: (hay: string) => boolean;
    if (query) {
      const compiled = buildMatcher(mode, query, caseSensitive);
      if (!compiled) return { set: new Set(), order: [] };
      test = compiled;
    } else {
      test = () => false;
    }
    const haystackOpts = valueHaystackOpts(mode);
    const matchSet = new Set<string>();
    const matchOrder: string[] = [];
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
              if (test(this.valueHaystack(node, haystackOpts))) record(node.pathString);
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
   * `pathString -> document-order position` map rebuilt whenever the
   * tree root changes. Used by cursor-aware navigation to compare the
   * current selection's position to hit positions in O(1) per lookup.
   * Walk order matches `searchHitData` (depth-first), so the integer
   * position is directly comparable across hits and selection. One
   * extra O(n) walk per root rebuild on top of `nodeIndex`'s parallel
   * walk; negligible alongside parse + build cost. Kept as a separate
   * computed rather than folded into `nodeIndex` (Map<string, {node,
   * order}>) so the two callsets don't accidentally cross-depend.
   */
  private readonly nodeOrder = computed<ReadonlyMap<string, number>>(() => {
    const map = new Map<string, number>();
    let order = 0;
    const walk = (node: TreeNode | undefined): void => {
      if (!node) return;
      map.set(node.pathString, order++);
      node.children?.forEach(walk);
    };
    walk(this.root());
    return map;
  });

  /**
   * Phase 2 (issue #95) -- flattened render-order list of every row
   * the viewport should draw. Each non-empty container produces an
   * `'open'` row at entry and a `'close'` row when the walk
   * returns past its last child; primitives and empty containers
   * produce a single `'leaf'` row. Drives `*cdkVirtualFor` and is
   * recomputed whenever `root()` or `expandedPaths()` changes.
   */
  readonly flatList = computed<readonly FlatItem[]>(() => {
    const rootNode = this.root();
    if (!rootNode) return [];
    const out: FlatItem[] = [];
    flatten(rootNode, 0, this.expandedPaths(), out);
    return out;
  });

  /**
   * Path -> visible-row-index lookup over `flatList()`, skipping
   * `'close'` rows so containers map to their canonical `'open'`
   * index. Used by `expandAndScroll` to compute pixel offsets and
   * by the focus-recovery effects to test whether `focusedPath`
   * still maps to a row in the flattened render order. Delegates
   * to the shared `buildVisibleIndexMap` helper in `flatten.ts`
   * so the "skip close rows" rule has a single home and is covered
   * by `flatten.spec.ts`.
   */
  private readonly visibleIndexByPath = computed<ReadonlyMap<string, number>>(() =>
    buildVisibleIndexMap(this.flatList()),
  );

  /**
   * Phase 2 (issue #95) -- visible rows in document order, with
   * synthetic `'close'` rows filtered out. Drives keyboard
   * navigation (Arrow keys, Home / End) and the focus-recovery
   * lifecycle effect.
   */
  private readonly visibleRowsInOrder = computed<readonly TreeNode[]>(() => {
    return this.flatList()
      .filter((item) => item.kind !== 'close')
      .map((item) => item.node);
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
      let label: string;
      let decodedLabel: string | undefined;
      if (typeof segment === 'number') {
        label = `[${segment}]`;
      } else {
        const raw = String(segment);
        label = displayKeyHelper(raw);
        if (label !== raw) decodedLabel = raw;
      }
      const base = {
        label,
        canonicalPath: formatPath(partial),
        current: i === path.length,
      };
      // Conditional spread honors aspirational exactOptionalPropertyTypes
      // (AGENTS.md section 4) by not emitting `decodedLabel: undefined`.
      out.push(decodedLabel !== undefined ? { ...base, decodedLabel } : base);
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
      ancestors.add(formatPath(partial));
    }
    return ancestors;
  });

  private hasInitializedExpansion = false;
  private lastObservedResetToken = 0;
  private renderGeneration = 0;
  private cancelledRender = false;

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
   * Last `selectedPath` value emitted to `selectionChange`. Used by
   * the `selectionChange` effect to dedup spurious re-emissions when
   * only `nodeIndex` changed (e.g., the home's 150 ms tree-pane
   * debounce rebuilds `root()` after a keystroke). Without dedup,
   * the second emission would bypass the home's single-shot
   * `pendingTreeApply` echo-suppression sentinel and trigger an
   * unwanted `editor.revealRange` -> `setSelection` over the AST
   * range (which selects the entire document when the path is `$`).
   *
   * Initial value `undefined` (not `null`) so the construction-time
   * first run with `selectedPath() === null` still emits an initial
   * `null` per the documented output contract.
   */
  private lastEmittedSelectedPath: string | null | undefined = undefined;

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

    // Phase 2 (issue #95) -- measure the probe row whenever any
    // height-driving preference changes. The probe is offscreen and
    // carries every height-contributing element (twisty, key, value,
    // date annotation, comment, kebab pill, extract pill, decoded
    // pill), so its bounding-rect height is an upper bound on the
    // tallest row that could render. The measurement drives the
    // `<cdk-virtual-scroll-viewport>` `[itemSize]` binding via
    // `effectiveRowHeightPx()` (which falls back to a font-size-derived
    // default before the first measurement lands so the viewport
    // never sees `[itemSize]="0"`) and preserves the user's logical
    // scroll position across font-size changes.
    effect(() => {
      this.treeFontSize();
      this.prefs.prefs().treeShowTypeLabels;
      this.prefs.prefs().treeShowDateAnnotations;
      afterNextRender(() => this.measureAndUpdate(), { injector: this.injector });
    });

    effect(() => {
      const token = this.viewResetToken();
      const rootNode = this.root();
      untracked(() => {
        const wasReset = token > 0 && token !== this.lastObservedResetToken;
        if (wasReset) {
          this.lastObservedResetToken = token;
          this.hasInitializedExpansion = false;
        }
        // Fires for every root or token change; invalidates any in-flight
        // prior-run auto-fit rAF before it can emit stale telemetry.
        this.autoFitGeneration += 1;
        // Phase 2 (issue #95) -- no `dataSource.data` write needed;
        // `flatList` is computed off `root()` directly.
        if (!rootNode) {
          this.hasInitializedExpansion = false;
          this.selectedPath.set(null); // allow:selected-path-set system-clear
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
        // On true view-reset (replaceDocument bumped viewResetToken),
        // drop the prior selection because the document is conceptually
        // different. On same-document value changes (typing, Format,
        // Minify, Extract), preserve the prior selection if its path
        // still resolves in the new tree; clear otherwise.
        // `selectedPath` already stores the formatted pathString (see
        // the field declaration above), so it can be used as the
        // `nodeIndex` key directly - do NOT wrap in `formatPath()` /
        // `pathToString()`, which would take a path-segments array.
        if (wasReset) {
          this.selectedPath.set(null); // allow:selected-path-set system-clear
        } else {
          const prior = this.selectedPath();
          if (prior !== null && !this.nodeIndex().has(prior)) {
            this.selectedPath.set(null); // allow:selected-path-set system-clear
          }
        }
      });
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
    // (different query, scope, or value). Cursor-aware: if the
    // current selection is itself a hit (or sits before the first
    // hit), land on the first hit AT-OR-AFTER the selection's
    // document-order position; otherwise wrap to 0. When the hit
    // list is empty, reset to -1.
    //
    // The entire body runs inside `untracked()` so neither
    // `selectedPath` nor `nodeOrder` writes re-fire this effect.
    // The effect's tracked surface is exactly `searchHitPaths`.
    effect(() => {
      const paths = this.searchHitPaths();
      untracked(() => {
        if (paths.length === 0) {
          this.activeHitIndex.set(-1);
          return;
        }
        const sel = this.selectedPath();
        if (sel === null) {
          this.activeHitIndex.set(0);
          return;
        }
        const orderMap = this.nodeOrder();
        const selPos = orderMap.get(sel);
        if (selPos === undefined) {
          this.activeHitIndex.set(0);
          return;
        }
        this.activeHitIndex.set(this.firstHitIndexAtOrAfter(paths, selPos, orderMap));
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

    // Issue #266 retry-pending effect. Declared BEFORE the dedup-emit
    // effect so within a single CD flush the order is:
    //   1. preserve-or-clear effect runs (above), updates selectedPath.
    //   2. THIS effect runs, applies pending if discriminator allows.
    //   3. dedup-emit effect runs, emits the final selectedPath value.
    // Inverting #2 and #3 would emit a transient null between the
    // preserve-or-clear clear and the retry apply, causing a visible
    // tree flicker on the home component's editor-cursor sync path.
    //
    // The effect tracks `nodeIndex` so it re-evaluates whenever the
    // tree's structural index rebuilds (typically after the home's
    // 150 ms tree-pane debounce flushes a fresh `root()`). Inside
    // `untracked` the plain `pendingSelectPathString` and
    // `pendingPriorSelectedPath` fields are read; signal-tracking
    // them would defeat the discriminator (the retry must read the
    // most-recent priorSelected snapshot, not a stale tracked one).
    effect(() => {
      const index = this.nodeIndex();
      untracked(() => {
        const pending = this.pendingSelectPathString;
        if (pending === null) return;
        if (!index.has(pending)) return;
        const selected = this.selectedPath();
        const priorSelected = this.pendingPriorSelectedPath;
        // Discriminator (issue #266; now a defensive backstop per
        // issue #274): discard pending if some writer wrote a
        // non-null `selectedPath` different from the priorSelected
        // snapshot between defer and now. After #274 every
        // intentional writer clears pending synchronously via
        // `setUserSelection()`, so this branch only fires when a
        // writer bypasses the helper. Allows:
        //  - selected === null (system-cleared by preserve-or-
        //    clear effect; apply).
        //  - selected === priorSelected (passive preserve; apply).
        if (selected !== null && selected !== priorSelected) {
          this.clearPendingSelectPath();
          return;
        }
        // Apply via `setUserSelection` (issue #274). The helper
        // clears pending (no-op when this effect was already
        // going to clear it) then writes selectedPath. The
        // dedup-emit effect observes the set on the next flush
        // step.
        this.setUserSelection(pending);
        this.expandAndScroll(pending);
      });
    });

    // Emit selectionChange whenever the canonical selectedPath signal
    // settles. Both user clicks (which write through onSelect) and
    // programmatic selects (selectByPathString) go through this funnel,
    // so the home component never has to wire two separate channels.
    // We swallow the transient case where selectedPath references a
    // path the current nodeIndex hasn't seen yet (e.g., a still-mid-
    // render mat-tree update) - the next effect tick will emit when
    // both signals agree. selectedPath = null always emits null.
    //
    // Dedup via `lastEmittedSelectedPath`: when only `nodeIndex`
    // changes (e.g., the home's 150 ms tree-pane debounce rebuilds
    // `root()` after a keystroke), `selectedPath` is unchanged and we
    // must NOT re-emit. Re-emitting would bypass the home's single-
    // shot `pendingTreeApply` sentinel and trigger an unwanted
    // `editor.revealRange` -> `setSelection` over the AST range
    // (catastrophic when the path is `$` because it selects the whole
    // document).
    effect(() => {
      const selected = this.selectedPath();
      if (selected === this.lastEmittedSelectedPath) return;
      if (selected === null) {
        this.lastEmittedSelectedPath = null;
        this.selectionChange.emit(null);
        return;
      }
      const node = this.nodeIndex().get(selected);
      // Transient: selectedPath references a path the current
      // nodeIndex hasn't seen yet. Leave `lastEmittedSelectedPath`
      // unchanged so the next effect tick (after nodeIndex catches
      // up) re-evaluates and emits.
      if (!node) return;
      this.lastEmittedSelectedPath = selected;
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

    // Phase 2 (issue #95) -- `expandedPaths` is now the authoritative
    // expansion state; computed signals such as `visibleRowsInOrder`
    // depend on it directly, so no expansion-version counter or
    // expansionModel subscription is needed.

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
      const map = this.visibleIndexByPath();

      if (visible.length === 0) {
        if (path !== null) untracked(() => this.focusedPath.set(null));
        return;
      }

      if (path === null) {
        const first = visible[0]!;
        untracked(() => this.focusedPath.set(first.pathString));
        return;
      }

      // O(1) membership check via `visibleIndexByPath`. Both `visibleRowsInOrder`
      // and `visibleIndexByPath` skip `'close'` rows, so they share the same
      // key set; the index map gives us a hash lookup instead of an O(N)
      // `Set` build on every effect run (matters when `flatList` is 100K
      // and this effect fires on every snap from the scroll-out handler
      // below).
      if (map.has(path)) return;

      // Walk up the path of the (possibly hidden) node to find the
      // nearest currently-visible ancestor.
      const node = this.nodeIndex().get(path);
      if (node) {
        const parts: (string | number)[] = [];
        let recovered: string | null = null;
        for (let i = 0; i < node.path.length; i++) {
          parts.push(node.path[i]!);
          const ancestorPath = formatPath(parts);
          if (map.has(ancestorPath)) recovered = ancestorPath;
        }
        // Root may also be the recovery target (path === '$').
        if (recovered === null && map.has('$')) recovered = '$';
        if (recovered !== null) {
          const finalRecovered = recovered;
          untracked(() => this.focusedPath.set(finalRecovered));
          return;
        }
      }

      // Path no longer exists in the index at all -- reset to first.
      untracked(() => this.focusedPath.set(visible[0]!.pathString));
    });

    // Phase 2 (issue #95) -- snap `focusedPath` into the rendered range
    // when the focused row goes out of the rendered window. With
    // `<mat-tree>` every row was in the DOM, so `tabindex="0"` on the
    // focused row was always present and Tab-into-tree-from-outside
    // always worked. With CDK virtual scroll, only rows in the rendered
    // window are in the DOM; if `focusedPath` points to an unmounted
    // row no element has `tabindex="0"` and Tab skips the tree
    // entirely (broken roving-tabindex invariant per WAI-ARIA Tree).
    //
    // The effect fires on changes to `flatList`, `renderedRange`, or
    // `visibleIndexByPath` -- the three signals that can move the
    // focused row's index relative to the rendered window:
    //   (a) user scroll -> `renderedRange` changes
    //   (b) expansion/collapse -> `flatList` (and derived
    //       `visibleIndexByPath`) changes; focused row's index shifts
    //       even though `scrollTop` is unchanged
    // The `focusedPath` READ is `untracked` so this effect does NOT
    // fire on programmatic or keyboard-driven `focusedPath` writes;
    // that responsibility belongs to the keyboard handler / moveFocusTo
    // path (which scrolls the viewport when the target row is unmounted).
    // `focusingProgrammatically` short-circuits the snap while
    // `moveFocusTo` (or the existing smooth-scroll paths in
    // `expandAndScroll`) is mid-flight, so the snap effect doesn't
    // chase intermediate `renderedRange` emissions and clobber focus
    // before the target row lands in the rendered window.
    //
    // Edge case: if every row in `[range.start, range.end)` is a
    // synthetic close-brace row, the loop falls through without
    // setting `focusedPath`. The existing recovery effect above
    // (which tracks `focusedPath`) acts as a backstop on the next
    // `map.has(path) === false` evaluation.
    effect(() => {
      const list = this.flatList();
      const range = this.renderedRange();
      const map = this.visibleIndexByPath();
      if (untracked(() => this.focusingProgrammatically())) return;
      const path = untracked(() => this.focusedPath());
      if (path === null || list.length === 0) return;
      const focusedIndex = map.get(path);
      if (focusedIndex === undefined) return;
      if (focusedIndex >= range.start && focusedIndex < range.end) return;
      const upper = Math.min(range.end, list.length);
      for (let i = range.start; i < upper; i++) {
        const item = list[i]!;
        if (item.kind !== 'close') {
          const snappedPath = item.node.pathString;
          untracked(() => this.focusedPath.set(snappedPath));
          return;
        }
      }
    });

    // Subscribe to the viewport's rendered-range stream the moment the
    // viewport view-child mounts. The effect re-runs if the viewport
    // ever unmounts and remounts (e.g., root() -> null -> root() again);
    // `onCleanup` tears down the prior subscription so we never leak.
    //
    // `renderedRangeStream` is a plain `Subject` (not a `BehaviorSubject`),
    // so subscribing after the viewport's initial layout would miss the
    // first emission and leave `renderedRange` stuck at `{0, 0}` until
    // the user scrolls. Seed from `getRenderedRange()` synchronously so
    // the snap effect sees a non-empty range from the first tick.
    // `untracked` around the writes avoids re-tracking the stream
    // emissions; the `getRenderedRange()` read is a plain getter (no
    // signal access) so it does not need wrapping.
    effect((onCleanup) => {
      const vp = this.viewport();
      if (!vp) return;
      const initial = vp.getRenderedRange();
      untracked(() => this.renderedRange.set({ start: initial.start, end: initial.end }));
      const sub = vp.renderedRangeStream.subscribe((range) => {
        untracked(() => this.renderedRange.set({ start: range.start, end: range.end }));
      });
      onCleanup(() => sub.unsubscribe());
    });
  }

  /**
   * `trackBy` for `*cdkVirtualFor` over `flatList()`. Uses
   * `path + kind` so the OPEN and CLOSE rows of the same container
   * keep distinct identities and the virtual scroll viewport
   * recycles correctly when a container expands/collapses.
   */
  trackByFlatItem = (_: number, item: FlatItem): string => `${item.kind}:${item.node.pathString}`;

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
    if (target.closest('button, a, input, [role="button"]')) {
      return;
    }
    this.setUserSelection(node.pathString);
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
    return this.nodeIndex().get(formatPath(parentPath));
  }

  /**
   * M7g-3b. Updates `focusedPath` and DOM-focuses the matching row
   * after Angular renders the new `tabindex=0`.
   *
   * Defers to `requestAnimationFrame` so the tabindex flip is
   * committed before we call `focus()`. With CDK virtual scroll
   * (Phase 2, issue #95), the target row may be **unmounted** when
   * `focusedPath` points outside the rendered window. In that case
   * the synchronous `querySelector` returns `null`, so we fall back
   * to scrolling the viewport to the target index and waiting for
   * the next `renderedRangeStream` emission that contains the target
   * before focusing.
   *
   * The fallback flow:
   *   1. `focusingProgrammatically.set(true)` so the snap effect
   *      short-circuits while we scroll (otherwise it would chase
   *      the in-flight scroll and clobber `focusedPath`).
   *   2. `viewport.scrollToIndex(index, 'auto')` -- `'auto'` not
   *      `'smooth'` so the rendered range arrives in one emission
   *      instead of over many frames.
   *   3. Subscribe to `renderedRangeStream` filtered for
   *      `target index in [start, end)`, take(1), timeout(1000),
   *      takeUntilDestroyed. The `finalize()` clears the flag,
   *      gated on the move-token so a stale subscription from a
   *      prior call cannot clear the flag during a later in-flight
   *      move.
   *   4. On `next`, inner rAF runs `querySelector` again (CD flushes
   *      in microtasks between the renderedRange emission and this
   *      rAF, so the row is materialized) and calls `focus()`.
   *   5. On `error` (timeout because `scrollToIndex` was a silent
   *      no-op -- e.g., the requested offset equals the current
   *      `scrollTop`), fall back to snapping `focusedPath` into
   *      whatever is currently in the rendered range so we never
   *      leave focus pinned to an unmounted row.
   */
  private moveFocusTo(path: string | null): void {
    if (path === null) return;
    this.focusedPath.set(path);
    const myToken = ++this.moveFocusToken;
    requestAnimationFrame(() => {
      if (myToken !== this.moveFocusToken) return;
      const el = this.host.nativeElement.querySelector(
        `[data-path="${cssEscape(path)}"]`,
      ) as HTMLElement | null;
      if (el) {
        el.focus({ preventScroll: true });
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      const vp = this.viewport();
      const index = this.visibleIndexByPath().get(path);
      if (!vp || index === undefined) return;
      this.focusingProgrammatically.set(true);
      vp.scrollToIndex(index, 'auto');
      vp.renderedRangeStream
        .pipe(
          filter(({ start, end }) => index >= start && index < end),
          take(1),
          timeout(1000),
          takeUntilDestroyed(this.destroyRef),
          finalize(() => {
            if (myToken === this.moveFocusToken) {
              this.focusingProgrammatically.set(false);
            }
          }),
        )
        .subscribe({
          next: () => {
            // CD flushes in microtasks between this rAF and the next,
            // so `cdkVirtualFor` has materialized the row by the
            // time the inner rAF fires.
            requestAnimationFrame(() => {
              if (myToken !== this.moveFocusToken) return;
              const targetEl = this.host.nativeElement.querySelector(
                `[data-path="${cssEscape(path)}"]`,
              ) as HTMLElement | null;
              targetEl?.focus({ preventScroll: true });
            });
          },
          error: () => {
            // `scrollToIndex` was a silent no-op (offset already
            // matched, or browser clamped). Re-snap into whatever
            // IS in the current rendered range so we don't leave
            // `focusedPath` pinned to an unmounted row.
            if (myToken !== this.moveFocusToken) return;
            const range = untracked(() => this.renderedRange());
            const list = untracked(() => this.flatList());
            const upper = Math.min(range.end, list.length);
            for (let i = range.start; i < upper; i++) {
              const item = list[i]!;
              if (item.kind !== 'close') {
                this.focusedPath.set(item.node.pathString);
                break;
              }
            }
          },
        });
    });
  }

  /**
   * M7v: public focus entry point for parent-component restore-after-dialog flows (e.g., extract dialog close).
   */
  focusRowByPath(pathString: string): void {
    this.moveFocusTo(pathString);
  }

  /**
   * M7g-3b. Keyboard handler bound on `.tree-row` (both leaf and
   * container variants). Implements the WAI-ARIA Tree pattern minus
   * type-ahead (deferred to issue #108). Phase 2 (issue #95) moved
   * this from `<mat-nested-tree-node>` when virtualization replaced
   * the Material tree with `<cdk-virtual-scroll-viewport>`.
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
    const isExpanded = isContainer && this.isExpanded(node);

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
          this.setExpanded(node, true);
        } else if (isContainer && isExpanded && node.children && node.children.length > 0) {
          this.moveFocusTo(node.children[0]!.pathString);
        }
        // Leaf: no-op.
        return;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        if (isContainer && isExpanded) {
          this.setExpanded(node, false);
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
        this.setUserSelection(node.pathString);
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
      `.tree-row[data-path="${cssEscape(node.pathString)}"]`,
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
    // Issue #266: pending-clear is required. Without it, the
    // retry-pending effect cannot distinguish "system cleared
    // because prior path vanished -- apply pending" (the
    // preserve-or-clear case) from "user explicitly cleared --
    // discard pending" (this case), and pending would re-apply
    // after the tree-pane debounce flushes. Issue #274 routes
    // both halves through `setUserSelection(null)` so the idiom
    // lives in exactly one place.
    this.setUserSelection(null);
  }

  /**
   * Escape clears the active selection. We do not call preventDefault()
   * so the search input's own Esc binding can also clear the search
   * query when it has focus - one Esc press exits both at once.
   *
   * Two production paths, kept separate so each can be tested in
   * isolation (the two Escape-during-defer specs cover distinct
   * production paths):
   *
   *  - Cold-start backstop (selectedPath already null, pending
   *    possibly non-null from typing-before-tree-catches-up):
   *    clear pending only. We do NOT route through
   *    `setUserSelection(null)` here to avoid a redundant
   *    same-value signal write that would re-fire the dedup-
   *    emit effect.
   *  - Warm-path (selectedPath non-null): `clearSelection()`,
   *    which calls `setUserSelection(null)`, which clears
   *    pending and writes null.
   *
   * The cold-start branch's `clearPendingSelectPath()` call is
   * load-bearing for #266 v2.4 cold-start regression coverage
   * at `json-tree.component.spec.ts` (search for "cold-start").
   * Future cleanup PRs MUST preserve the branch split or update
   * both tests in lockstep.
   */
  @HostListener('document:keydown.escape')
  onDocumentEscape(): void {
    if (this.selectedPath() === null) {
      this.clearPendingSelectPath();
      return;
    }
    this.clearSelection();
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

  setSearchMatchMode(mode: SearchMatchMode): void {
    this.prefs.update({ searchMatchMode: mode });
  }

  /**
   * Keyboard shortcut handler for Alt+R when the search input is
   * focused. Cycles match mode through the `matchModes` array order
   * (contains -> starts_with -> ends_with -> exact -> regex ->
   * contains). Mitigates the loss of the legacy 1-click `.*` toggle
   * (see plan.md "Pre-presentation gate" -> Skeptic #9 / Advocate #2).
   */
  onMatchModeShortcut(ev: Event): void {
    ev.preventDefault();
    const current = this.searchMatchMode();
    const idx = this.matchModes.findIndex((m) => m.mode === current);
    const nextIdx = (idx + 1) % this.matchModes.length;
    const nextEntry = this.matchModes[nextIdx];
    if (nextEntry) this.setSearchMatchMode(nextEntry.mode);
  }

  goToNextMatch(): void {
    const paths = this.searchHitPaths();
    if (paths.length === 0) return;
    const next = this.nextHitFromSelection(paths);
    this.activeHitIndex.set(next);
    const path = paths[next] as string;
    // Issue #266 / #274: intentional writer; route through
    // `setUserSelection` so any in-flight defer from editor-
    // typing is cancelled synchronously. Placed AFTER the
    // `paths.length === 0` early return so a zero-hit press of
    // Next/Prev does not destroy an in-flight defer.
    this.setUserSelection(path);
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
    const prev = this.prevHitFromSelection(paths);
    this.activeHitIndex.set(prev);
    const path = paths[prev] as string;
    // Issue #266 / #274: see goToNextMatch.
    this.setUserSelection(path);
    // See goToNextMatch: focused-but-not-DOM-focused so the search
    // input keeps focus.
    this.focusedPath.set(path);
    this.revealHit(path);
  }

  /**
   * Resolves the next-hit index from the current selection, honoring
   * cursor-aware semantics. When `selectedPath` is `null` or stale
   * (no longer in the current tree -- e.g. after a document reload
   * before signal sync), falls back to the legacy increment so
   * keyboard-only sessions retain their cycle behavior.
   */
  private nextHitFromSelection(paths: readonly string[]): number {
    const sel = this.selectedPath();
    if (sel === null) return this.legacyNextIndex(paths);
    const orderMap = this.nodeOrder();
    const selPos = orderMap.get(sel);
    if (selPos === undefined) return this.legacyNextIndex(paths);
    return this.firstHitIndexAfter(paths, selPos, orderMap);
  }

  /**
   * Resolves the previous-hit index from the current selection. Same
   * stale-fallback contract as `nextHitFromSelection`.
   */
  private prevHitFromSelection(paths: readonly string[]): number {
    const sel = this.selectedPath();
    if (sel === null) return this.legacyPrevIndex(paths);
    const orderMap = this.nodeOrder();
    const selPos = orderMap.get(sel);
    if (selPos === undefined) return this.legacyPrevIndex(paths);
    return this.lastHitIndexBefore(paths, selPos, orderMap);
  }

  private legacyNextIndex(paths: readonly string[]): number {
    const index = this.activeHitIndex();
    return index < 0 ? 0 : (index + 1) % paths.length;
  }

  private legacyPrevIndex(paths: readonly string[]): number {
    const index = this.activeHitIndex();
    return index <= 0 ? paths.length - 1 : index - 1;
  }

  /**
   * Returns the index into `paths` of the smallest hit position
   * STRICTLY greater than `selPos`, with wrap-around to 0. Returns
   * `-1` when `paths` is empty. Used by the Next press.
   */
  private firstHitIndexAfter(
    paths: readonly string[],
    selPos: number,
    orderMap: ReadonlyMap<string, number>,
  ): number {
    if (paths.length === 0) return -1;
    for (let i = 0; i < paths.length; i++) {
      const hitPath = paths[i] as string;
      const hitPos = orderMap.get(hitPath);
      if (hitPos !== undefined && hitPos > selPos) return i;
    }
    return 0;
  }

  /**
   * Returns the index into `paths` of the largest hit position
   * STRICTLY less than `selPos`, with wrap-around to last. Returns
   * `-1` when `paths` is empty. Used by the Prev press.
   */
  private lastHitIndexBefore(
    paths: readonly string[],
    selPos: number,
    orderMap: ReadonlyMap<string, number>,
  ): number {
    if (paths.length === 0) return -1;
    for (let i = paths.length - 1; i >= 0; i--) {
      const hitPath = paths[i] as string;
      const hitPos = orderMap.get(hitPath);
      if (hitPos !== undefined && hitPos < selPos) return i;
    }
    return paths.length - 1;
  }

  /**
   * Returns the index into `paths` of the smallest hit position
   * AT-OR-AFTER `selPos`, with wrap-around to 0. Returns `-1` when
   * `paths` is empty. Used by:
   *
   *   1. The `activeHitIndex` reset effect (cursor-aware
   *      auto-activate of the cursor's own hit on query change).
   *   2. The `activateClickedHitOrFirst` non-hit fallback (anchor
   *      on clicked row when it matches, else jump to nearest
   *      forward hit).
   *
   * Forward-compat hazard: if the design ever flips to symmetric
   * strict (`>` everywhere), `activateClickedHitOrFirst` should
   * keep using THIS helper, NOT `firstHitIndexAfter`. The click
   * action's "anchor here" intent diverges from typed Next
   * navigation: click-on-hit must activate that hit, not skip
   * past it.
   */
  private firstHitIndexAtOrAfter(
    paths: readonly string[],
    selPos: number,
    orderMap: ReadonlyMap<string, number>,
  ): number {
    if (paths.length === 0) return -1;
    for (let i = 0; i < paths.length; i++) {
      const hitPath = paths[i] as string;
      const hitPos = orderMap.get(hitPath);
      if (hitPos !== undefined && hitPos >= selPos) return i;
    }
    return 0;
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
   * is already selected). For paths not yet in `nodeIndex` (e.g.,
   * editor-cursor-driven calls during the home's tree-pane debounce
   * window), DEFERS the write: the path is stored in
   * `pendingSelectPathString` together with a snapshot of
   * `pendingPriorSelectedPath`, and the retry-pending effect applies
   * it once `nodeIndex` catches up.
   *
   * The retry-pending effect uses a discriminator to decide whether
   * to apply pending or discard it:
   *  - If `selectedPath()` is null (system-cleared because the prior
   *    path vanished, or cold-start) OR equal to
   *    `pendingPriorSelectedPath` (passive preserve), APPLY.
   *  - Otherwise (a user-intent writer set a different path between
   *    defer and retry), DISCARD pending.
   *
   * To cancel an in-flight defer without touching the visible
   * selection, call `clearPendingSelectPath()`. To clear BOTH the
   * visible selection and any defer, call this method with `null`.
   *
   * `null` clears the selection (and pending). Expands ancestor
   * containers and scrolls the row into view, mirroring the
   * search-jump UX. (Defer + retry from #266.)
   */
  selectByPathString(pathString: string | null): void {
    if (pathString === null) {
      // Programmatic clear. Issue #274 routes through
      // `setUserSelection(null)`. The dedup-emit effect's
      // `lastEmittedSelectedPath` swallows the redundant
      // same-value emission when `selectedPath` is already null,
      // so we do not gate the helper call.
      this.setUserSelection(null);
      return;
    }
    if (this.selectedPath() === pathString) {
      // Idempotent: even though selectedPath is already the
      // requested value, clear pending so a prior defer cannot
      // re-apply later. The caller just re-affirmed this path.
      this.clearPendingSelectPath();
      return;
    }
    if (!this.nodeIndex().has(pathString)) {
      // Defer: path not in nodeIndex yet. Capture pending +
      // priorSelected so the retry-pending effect can apply it
      // when nodeIndex catches up (subject to the discriminator).
      this.pendingSelectPathString = pathString;
      this.pendingPriorSelectedPath = this.selectedPath();
      return;
    }
    // Immediate apply: nodeIndex already has the path. Issue
    // #274 routes through `setUserSelection` (clears any stale
    // pending then writes selectedPath); `expandAndScroll` is
    // the immediate-apply-specific tail.
    this.setUserSelection(pathString);
    this.expandAndScroll(pathString);
  }

  /**
   * Cancel any in-flight `selectByPathString` defer without
   * touching the visible `selectedPath`. Used by callers that
   * need to invalidate pending user-intent state without
   * gesturing at the tree (e.g., editor `setContent` clearing
   * stale typing-induced defers; sync-OFF toggle).
   */
  clearPendingSelectPath(): void {
    this.pendingSelectPathString = null;
    this.pendingPriorSelectedPath = null;
  }

  /**
   * Issue #274. Standard "clear pending then set" idiom for every
   * in-component intentional write to `selectedPath`. Clears any
   * in-flight #266 defer (so the retry-pending effect's
   * discriminator cannot later re-apply a stale pending path
   * over this write), then writes the new path.
   *
   * Call sites (also enumerated in the "Intentional writers" doc
   * block at `selectedPath`'s declaration):
   *  - Direct user gestures: `onSelect` (mouse click),
   *    keyboard Enter / Space, `onKebabClick`, Escape via
   *    `clearSelection`, search-nav (`goToNextMatch` /
   *    `goToPrevMatch`).
   *  - Microtask-deferred user gesture:
   *    `activateClickedHitOrFirst` (the microtask defers the
   *    write past the search-hit-list reset effect, but the
   *    originating gesture is the user's click).
   *  - Programmatic: `selectByPathString` immediate-apply
   *    branch, `selectByPathString` null-clear branch, the
   *    retry-pending effect's apply branch.
   *
   * `null` clears the selection (and pending). Does NOT touch
   * `focusedPath`: callers that also want to move the keyboard
   * cursor (e.g., `onSelect`, search-nav) update `focusedPath`
   * separately. Does NOT expand or scroll: the immediate-apply
   * branch of `selectByPathString` chains `expandAndScroll`
   * after this call.
   *
   * Caller contract: pass a path that is in `nodeIndex()` (or
   * `null`). The helper does NOT defer like `selectByPathString` --
   * if the path is not in `nodeIndex`, the preserve-or-clear
   * effect on the next nodeIndex tick will clear `selectedPath`
   * back to null. All current callers satisfy this naturally:
   * direct gestures operate on rendered `TreeNode`s; programmatic
   * callers go through `selectByPathString` which checks
   * `nodeIndex().has(...)` before deciding to defer vs
   * immediate-apply.
   *
   * Why this exists (issue #274): pre-helper, only 3 of 7
   * intentional writers cleared pending; the other 4 relied on
   * keyboard-release timing to terminate any in-flight typing-
   * induced defer. The helper makes the pending-clear structural
   * rather than empirical. The `check-prod-patterns.mjs`
   * `selected-path-set` rule rejects raw `selectedPath.set(...)`
   * writes outside this helper (system-clear writes inside this
   * file carry the trailing pragma
   * `// allow:selected-path-set <category>`).
   */
  setUserSelection(path: string | null): void {
    this.clearPendingSelectPath();
    this.selectedPath.set(path); // allow:selected-path-set helper
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
    const node = this.nodeIndex().get(formatPath(path));
    if (!node) return;
    this.setExpanded(node, true);
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
    // Build the ancestor expansion set in one pass, then write the
    // signal exactly once via setExpandedBulk (issue #95 Phase 2).
    if (node.path.length > 1) {
      const current = this.expandedPaths();
      let next: Set<string> | null = null;
      const partial: (string | number)[] = [];
      for (let i = 0; i < node.path.length - 1; i++) {
        partial.push(node.path[i] as string | number);
        const ancestorPath = formatPath(partial);
        if (!current.has(ancestorPath) && this.nodeIndex().has(ancestorPath)) {
          if (next === null) next = new Set(current);
          next.add(ancestorPath);
        }
      }
      if (next !== null) this.setExpandedBulk(next);
    }
    // Defer scroll until after Angular renders the expansion. True
    // 'nearest'-equivalent semantics: scroll the minimum amount
    // needed to reveal the row. Locked decision 10 (round 2).
    afterNextRender(
      () => {
        const viewport = this.viewport();
        const rowHeight = this.measuredRowHeightPx();
        const index = this.visibleIndexByPath().get(path);
        if (!viewport || rowHeight <= 0 || index === undefined) {
          // Fallback for the rule-preview path or pre-measure window.
          const el = this.host.nativeElement.querySelector(
            `[data-path="${cssEscape(path)}"]`,
          ) as HTMLElement | null;
          el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          return;
        }
        const top = index * rowHeight;
        const bottom = top + rowHeight;
        const scroll = viewport.measureScrollOffset();
        const view = viewport.getViewportSize();
        if (top < scroll) viewport.scrollToOffset(top, 'smooth');
        else if (bottom > scroll + view) viewport.scrollToOffset(bottom - view, 'smooth');
        // else: fully visible, skip.
      },
      { injector: this.injector },
    );
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
    const next = new Set(this.expandedPaths());
    const walk = (node: TreeNode | undefined, relativeDepth: number): void => {
      if (!node || !node.children?.length) return;
      nodeCount += 1;
      maxDepth = Math.max(maxDepth, relativeDepth);
      next.add(node.pathString);
      for (const child of node.children) walk(child, relativeDepth + 1);
    };
    walk(this.root(), 0);
    this.setExpandedBulk(next);
    this.emitSlowExpandIfNeeded(performance.now() - start, maxDepth, nodeCount);
  }

  collapseAll(): void {
    this.collapseAllNodes();
  }

  expandToLevel(depth: number, internal = false): void {
    const start = performance.now();
    let nodeCount = 0;
    const next = new Set<string>();
    const walk = (node: TreeNode | undefined): void => {
      if (!node || !node.children?.length) return;
      nodeCount += 1;
      if (node.depth < depth) {
        next.add(node.pathString);
        for (const child of node.children) walk(child);
      }
    };
    walk(this.root());
    this.setExpandedBulk(next);
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
    const probeRef = this.rowHeightProbe();
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

  /**
   * Phase 2 (issue #95) -- reads the probe row's current height and
   * writes the result into `measuredRowHeightPx` so the virtual
   * scroll viewport's `[itemSize]` binding reflects it. Skips the
   * write when nothing changed. Preserves the user's logical scroll
   * position across font-size changes by scaling the pre-change
   * pixel offset to the new row height.
   *
   * The probe-height cache is invalidated first so the new height
   * is measured (the cache key is `treeFontSize` but other prefs
   * such as `showTypeLabels` can change height too).
   */
  private measureAndUpdate(): void {
    const probe = this.rowHeightProbe()?.nativeElement;
    if (!probe) return;
    const newH = Math.ceil(probe.getBoundingClientRect().height);
    if (newH <= 0 || newH === this.measuredRowHeightPx()) return;
    const oldH = this.measuredRowHeightPx();
    const viewport = this.viewport();
    const oldOffset = viewport?.measureScrollOffset() ?? 0;
    // Invalidate the auto-fit probe cache so the next auto-fit run
    // re-measures against the same height we just wrote.
    this.probeRowHeightCache = null;
    this.measuredRowHeightPx.set(newH);
    queueMicrotask(() => {
      const vp = this.viewport();
      if (!vp) return;
      vp.checkViewportSize();
      // Scroll-position preservation: scale the prior pixel offset to
      // the new row height so the user's logical position is
      // preserved. Skip on the initial 0 -> first measurement to
      // avoid a NaN scroll.
      if (oldH > 0) {
        const offsetRows = oldOffset / oldH;
        vp.scrollToOffset(offsetRows * newH, 'auto');
      }
    });
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
    if (target instanceof Element && target.closest('button, a, input, [role="button"]')) {
      return;
    }
    this.openContextMenuAt(event, node, 'row', false);
  }

  onCloseRowContextMenu(event: MouseEvent, node: TreeNode): void {
    if (event.clientX === 0 && event.clientY === 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest('button, a, input, [role="button"]')) {
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
    if (target instanceof Element && target.closest('button, a, input, [role="button"]')) {
      return;
    }
    if ((node.type === 'object' || node.type === 'array') && node.children?.length) {
      const wasExpanded = this.isExpanded(node);
      this.toggleExpanded(node);
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
    this.setUserSelection(node.pathString);
    this.logger.info('tree.contextMenu.opened', { source: 'kebab' });
  }

  /**
   * Click handler for the container twisty button. Toggles expansion
   * and stops propagation so the row-level `onSelect` does not also
   * fire on the same click. Phase 2 (issue #95) replaces the
   * `matTreeNodeToggle` directive that previously handled this.
   */
  onTwistyClick(node: TreeNode, event: MouseEvent): void {
    event.stopPropagation();
    this.toggleExpanded(node);
  }

  /**
   * Clamp a tooltip source string at {@link MAX_TOOLTIP_LEN_CHARS}
   * characters, appending a localized truncation suffix when the
   * cap is exceeded. The full value is always reachable through the
   * decoded value viewer dialog (the `tree-decoded-pill` becomes
   * visible for `length > DECODED_LONG_THRESHOLD_CHARS` per
   * `decodedCandidate`).
   */
  clampTooltip(value: string): string {
    if (value.length <= MAX_TOOLTIP_LEN_CHARS) return value;
    const head = value.slice(0, MAX_TOOLTIP_LEN_CHARS);
    const remaining = value.length - MAX_TOOLTIP_LEN_CHARS;
    return (
      head +
      $localize`:@@tree.decoded.tooltipTruncated:... (${remaining} more characters; open the pill to view full value)`
    );
  }

  extractCandidate(node: TreeNode): ExtractedJson | null {
    if (node.type !== 'string' || typeof node.value !== 'string') return null;
    const map = this.extractCandidates();
    if (!map) return null;
    return map.get(node.value) ?? null;
  }

  onExtractButtonClick(node: TreeNode, event: MouseEvent): void {
    event.stopPropagation();
    this.emitExtract(node, 'rowPillPrimitiveArray');
  }

  onExtractMenuClick(node: TreeNode): void {
    // Phase 4 (tree-menu overhaul): counts-only marker for the
    // menu-driven Extract entry point. The inline pill button uses
    // `tree.extract.click` with `source: 'rowPillPrimitiveArray'`
    // separately.
    this.logger.info('tree.contextMenu.extract');
    this.emitExtract(node, 'contextMenu');
  }

  private emitExtract(
    node: TreeNode,
    source: 'rowPillPrimitiveArray' | 'contextMenu' | 'decodedDialog',
  ): void {
    const candidate = this.extractCandidate(node);
    if (!candidate) return;
    const sourceVersion = this.extractSourceVersion() ?? -1;
    this.extractRequest.emit({ path: node.path, sourceVersion, replacement: candidate, source });
  }

  /**
   * Returns true when this node is a string leaf whose JSON-escaped
   * single-line rendering is hard to read at a glance, so the row
   * exposes a "decoded value" pill that opens the dedicated viewer
   * dialog. The predicate is intentionally broad:
   *
   * - any control character that JSON would have escaped (`\n`, `\r`,
   *   `\t`), plus embedded quotes (`"`) or backslashes (`\`), OR
   * - any string longer than {@link DECODED_LONG_THRESHOLD_CHARS}
   *   characters (roughly two desktop screen widths at default font),
   *   so long single-line URLs / GUIDs / base64 IDs / large numeric
   *   IDs as strings are also reachable through the dialog viewer.
   *
   * A short, plain ASCII string with no escape-worthy characters
   * shows fine as-is and gets no pill.
   */
  decodedCandidate(node: TreeNode): boolean {
    if (node.type !== 'string' || typeof node.value !== 'string') return false;
    return node.value.length > DECODED_LONG_THRESHOLD_CHARS || /[\n\r\t"\\]/.test(node.value);
  }

  decodedPillTitleFor(node: TreeNode): string {
    return this.extractCandidate(node) !== null
      ? this.decodedOpenDialogWithExtractTitleLabel
      : this.decodedOpenDialogTitleLabel;
  }

  decodedPillAriaFor(node: TreeNode): string {
    return this.extractCandidate(node) !== null
      ? this.decodedOpenDialogWithExtractAriaLabel
      : this.decodedOpenDialogAriaLabel;
  }

  /**
   * Template-only renderer for value text. Always returns the
   * canonical JSON-escaped form via {@link renderLeaf} so every tree
   * row is uniform-height (issue #95 Phase 0). Decoded multi-line
   * content is shown via {@link openDecodedDialog} instead.
   *
   * Analog for object keys: `displayKey` in
   * `src/app/core/json/key-display.ts`. That helper applies the same
   * JSON-escape transform but strips the wrapping quotes so bare
   * keys render naturally in `.tree-key` spans.
   */
  displayLeaf(node: TreeNode): string {
    return this.renderLeaf(node.value, node.type);
  }

  /**
   * Template wrapper around `displayKey` (in
   * `src/app/core/json/key-display.ts`) that narrows the polymorphic
   * `TreeNode.segment` type for binding inside `.tree-key` spans.
   * Numeric segments never reach the `.tree-key` branch (they go to
   * `.tree-index` via `segmentIsIndex`), but the defensive `number`
   * branch keeps the wrapper total and the template type-safe.
   */
  displayKey(segment: string | number): string {
    if (typeof segment === 'number') return String(segment);
    return displayKeyHelper(segment);
  }

  /**
   * Pill-button click handler. Opens the decoded value dialog and
   * stops the click from bubbling up to the row, which would
   * otherwise change selection.
   */
  onDecodedButtonClick(node: TreeNode, event: MouseEvent): void {
    event.stopPropagation();
    this.openDecodedDialog(node, 'rowButton');
  }

  /**
   * Kebab "Open decoded value" entry-point handler. Same dialog as
   * the row pill; the source prop disambiguates the entry point in
   * telemetry.
   */
  onDecodedMenuClick(node: TreeNode): void {
    this.openDecodedDialog(node, 'contextMenu');
  }

  /**
   * Opens {@link DecodedValueDialogComponent} for `node` and emits
   * one `tree.decoded.viewerOpened` event with bucketed properties
   * (see the catalog entry in `telemetry-message-ids.ts`). Aborts
   * silently when the node is not a current decoded candidate so a
   * stale row click after the value type changed is a no-op.
   */
  private openDecodedDialog(node: TreeNode, source: 'rowButton' | 'contextMenu'): void {
    const current = this.nodeIndex().get(node.pathString);
    if (current !== node) return;
    if (!this.decodedCandidate(node)) return;
    const value = node.value as string;
    const reason: 'escape' | 'long' = /[\n\r\t"\\]/.test(value) ? 'escape' : 'long';
    const capturedExtractCandidate = this.extractCandidate(node);
    const capturedSourceVersion = this.extractSourceVersion() ?? -1;
    const data: DecodedValueDialogData = {
      value,
      pathString: node.pathString,
      ...(capturedExtractCandidate !== null
        ? { extractCandidate: capturedExtractCandidate, extractPath: node.path }
        : {}),
    };
    const dialogRef = this.dialog.open<
      DecodedValueDialogComponent,
      DecodedValueDialogData,
      DecodedValueDialogResult
    >(DecodedValueDialogComponent, {
      data,
      // Viewport-relative width follows the v0.23.1 tree-value tooltip
      // approach in `src/styles/_material.scss` (the `.jj-tooltip-wide`
      // surface uses `max-width: 90vw` and rejects fixed pixel caps).
      // Tooltips and this dialog are two tiers of viewer for the same
      // content kind (long monospace strings); the dialog is the
      // committed-inspection mode, so the same percentage-only rule
      // applies here. Other MatDialog callers in this app (history,
      // blobs, formatting-rules, etc.) keep their fixed `420px` form
      // dialogs; this pattern is specific to dialogs rendering
      // pre-wrap monospace user content where horizontal real estate
      // matters.
      width: '90vw',
      maxWidth: '95vw',
      autoFocus: 'dialog',
    });
    dialogRef
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => {
        if (result?.extract === true) {
          const currentSourceVersion = this.extractSourceVersion() ?? -1;
          const currentCandidate = this.extractCandidate(node);
          const staleDialogClose =
            currentSourceVersion !== capturedSourceVersion ||
            this.nodeIndex().get(node.pathString) !== node ||
            capturedExtractCandidate === null ||
            currentCandidate === null ||
            currentCandidate.text !== capturedExtractCandidate.text;
          if (staleDialogClose) {
            this.logger.event('tree.extract.dialog.staleClose');
          } else {
            this.extractRequest.emit({
              path: node.path,
              sourceVersion: currentSourceVersion,
              replacement: currentCandidate,
              source: 'decodedDialog',
            });
          }
        }
        this.focusRowByPath(node.pathString);
      });
    this.logger.event('tree.decoded.viewerOpened', {
      source,
      reason,
      pathDepth: bucketCount(node.path.length),
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
   *   - Q2: forces `searchMatchMode: 'contains'` (was
   *     `searchRegexMode: false` pre-rename) so keys with regex
   *     metachars don't surprise users.
   *   - Q-activeHit: makes the clicked row the active hit if it
   *     ended up in the result set; falls back to first hit otherwise.
   *
   * Each pref change is a write-through to `PreferencesService`,
   * matching the pattern used by `setSearchScope`.
   */
  findByKey(node: TreeNode): void {
    if (node.segment === undefined) return;
    this.logger.info('tree.contextMenu.searchByKey');
    // Force `searchMatchMode: 'contains'` (was `searchRegexMode: false`
    // pre-rename). Two intents: (1) defend against keys with regex
    // metachars (`.`, `$`, `*`) so power users don't see surprises;
    // (2) ensure the JSON-escaped haystack path is used so the
    // clicked row's key matches even with embedded quotes. This
    // intentionally clobbers a user's `'starts_with'`/`'ends_with'`/
    // `'exact'`/`'regex'` choice for this one-shot action - the
    // safety guarantee is more important than preserving picker
    // state across context-menu clicks. Tracked: see plan.md
    // "Pre-presentation gate" -> Skeptic #3 / Architect #findByKey.
    this.prefs.update({
      searchScope: 'keys',
      searchMatchMode: 'contains',
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
    // findByValue writes to the contains-mode search query. The
    // value-haystack path for string leaves in contains mode is the
    // JSON-escaped form (see `valueHaystack` JSDoc), so the raw
    // string here matches as a substring inside the quoted hay -
    // e.g. query `hello` finds within hay `"hello"`. Pre-existing
    // limitation: values containing JSON-escape characters (`"`,
    // `\`, `\n`, `\t`, ...) do NOT round-trip correctly through this
    // path - tracked separately; do not extend the workaround here.
    // Mode is forced to `'contains'` (was `searchRegexMode: false`
    // pre-rename) to defend against regex metachars in the value,
    // intentionally clobbering a user's other mode choice - see
    // `findByKey` JSDoc for the same rationale.
    const query =
      node.type === 'string' ? (node.value as string) : this.renderLeaf(node.value, node.type);
    this.prefs.update({
      searchScope: 'values',
      searchMatchMode: 'contains',
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
   * True iff the `Subtree >` submenu trigger should render in the
   * row menu. Path Y groups all subtree-affecting actions
   * (highlight subtree, collapse from here, isolate variants,
   * expand from here >) under one named submenu. The trigger
   * renders when the submenu would have **2 or more** visible
   * items; a single-item Subtree elevates the lone item directly
   * into the row menu (`subtreeElevatedAction`). Zero items hide
   * everything.
   *
   * Edge case (v0.19.4): when the only Subtree item would be the
   * same action as the surfaced default-shortcut row (e.g. an
   * expanded container has no isolate / highlight conditions met
   * and Subtree would only contain `Collapse`, while the surfaced
   * row already shows `Collapse from here`), elevation would
   * produce two adjacent identical items. We suppress in that
   * case via `subtreeElevatedAction()` returning `'collapseSame'`,
   * and `showSubtreeMenu` returns false.
   */
  showSubtreeMenu(node: TreeNode): boolean {
    return this.subtreeItemCount(node) >= 2;
  }

  /**
   * When the Subtree submenu would have exactly one visible item,
   * returns metadata for elevating that item to the row menu;
   * otherwise null. The row template uses this signal to render
   * the elevated action flat (no Subtree > trigger).
   *
   * Returns `'collapseSame'` as a sentinel when the lone Subtree
   * action is `Collapse` AND the surfaced default-shortcut row is
   * already `Collapse from here` -- in that case the row menu
   * shouldn't render anything (the action is already accessible
   * via the surfaced row), so the template hides Subtree entirely.
   */
  subtreeElevatedAction(node: TreeNode): SubtreeElevatedAction | null {
    if (this.subtreeItemCount(node) !== 1) return null;
    if (this.showHighlightTree(node)) {
      return { kind: 'highlightTree' };
    }
    if (this.showRemoveTreeHighlight(node)) {
      return { kind: 'removeTreeHighlight' };
    }
    if (this.showIsolateSingle(node)) {
      return { kind: 'isolate', mode: 'single' };
    }
    if (this.showCollapse(node)) {
      // Suppress when the surfaced shortcut already exposes the
      // same Collapse action (avoids duplicate adjacent items).
      if (this.defaultActionKind() === 'collapseRow') {
        return { kind: 'collapseSame' };
      }
      return { kind: 'collapse' };
    }
    if (this.showExpandFromHereMenu(node)) {
      // The whole Expand contribution is the single Subtree item.
      // It either elevates (single Expand action) or stays a
      // flyout (multiple Expand actions), but either way it is
      // the lone Subtree item. v0.23.0 retired the `'expandSame'`
      // sentinel: when the lone Expand action would be `+1` with
      // an `expandRow` default, `isLoneDepth1RedundantWithSurfaced`
      // suppresses the whole Expand contribution upstream so this
      // arm only ever fires for non-redundant cases.
      const expandSingle = this.expandFromHereSingleAction(node);
      if (expandSingle) {
        return { kind: 'expandSingle', single: expandSingle };
      }
      // Multiple Expand options -- elevate the whole Expand
      // submenu trigger to row level.
      return { kind: 'expandSubmenu' };
    }
    return null;
  }

  /**
   * Number of visible items in the `Subtree >` submenu. Each
   * top-level submenu child counts as 1 item, including the
   * `Expand >` sub-submenu (which counts as 1 regardless of how
   * many depths it contains).
   *
   * `showIsolatePair` contributes 2 items (Isolate + Collapse
   * siblings); the others are 1 each. Used to drive
   * single-option elevation in v0.19.4.
   */
  private subtreeItemCount(node: TreeNode): number {
    let count = 0;
    if (this.showHighlightTree(node)) count += 1;
    if (this.showRemoveTreeHighlight(node)) count += 1;
    if (this.showCollapse(node)) count += 1;
    if (this.showIsolateSingle(node)) count += 1;
    if (this.showIsolatePair(node)) count += 2; // Isolate + Collapse siblings
    if (this.showExpandFromHereMenu(node)) count += 1;
    return count;
  }

  /**
   * True iff the `Expand >` sub-submenu (inside Subtree >)
   * should render as a flyout. Renders when there are 2 or more
   * visible Expand items; a single Expand item elevates to the
   * Subtree level via `expandFromHereSingleAction`. Zero items
   * means no Expand contribution at all.
   */
  showExpandFromHereSubmenu(node: TreeNode): boolean {
    return this.expandFromHereItemCount(node) >= 2;
  }

  /**
   * True iff there is any Expand contribution (>= 1 visible item).
   * The Expand "section" exists in the menu hierarchy; whether it
   * renders as a flyout, an elevated-single, or contributes to a
   * higher elevation is decided by `subtreeElevatedAction` and the
   * template.
   */
  showExpandFromHereMenu(node: TreeNode): boolean {
    return this.expandFromHereItemCount(node) >= 1;
  }

  /**
   * When the Expand sub-submenu would have exactly one visible
   * item, returns metadata for elevating that item; otherwise
   * null. Cases:
   *
   *   - `{ kind: 'expandToDepth', depth: N }`: only one specific
   *     depth +N is visible (e.g. partial-expand state where
   *     +1 is hidden because top-level is expanded, only +2 has
   *     a collapsed container reachable, and +3..+9 exceed
   *     subtree depth).
   *
   * Returns null when 0 or >= 2 items are visible, OR when
   * `isLoneDepth1RedundantWithSurfaced` fires (the lone +1
   * case where the bolded surfaced shortcut already covers the
   * action).
   *
   * v0.23.0: the `{ kind: 'expandAll' }` case was retired; the
   * top-level `Expand all from here` row covers it directly.
   */
  expandFromHereSingleAction(node: TreeNode): ExpandSingleAction | null {
    if (this.isLoneDepth1RedundantWithSurfaced(node)) return null;
    if (this.expandFromHereItemCount(node) !== 1) return null;
    for (let depth = 1; depth <= 9; depth++) {
      if (this.showExpandToDepth(node, depth)) {
        return { kind: 'expandToDepth', depth };
      }
    }
    return null;
  }

  private expandFromHereItemCount(node: TreeNode): number {
    if (this.isLoneDepth1RedundantWithSurfaced(node)) return 0;
    let count = 0;
    for (let depth = 1; depth <= 9; depth++) {
      if (this.showExpandToDepth(node, depth)) count += 1;
    }
    return count;
  }

  /**
   * Suppresses the `Expand >` sub-submenu's lone `+1` entry (and
   * the in-Subtree single-item elevation that would otherwise
   * render it) when the bolded surfaced shortcut row already
   * fires the identical `expandToDepthFromHere(_, 1)` action.
   *
   * Fires iff (a) the subtree has exactly one container descendant
   * level (`maxDescendantDepth === 1`) AND (b) the row's
   * `defaultActionKind` is `'expandRow'` (the bolded surfaced
   * shortcut is "Expand 1 level"). Cascades through
   * `expandFromHereItemCount` (returns 0) ->
   * `expandFromHereSingleAction` (returns null) ->
   * `showExpandFromHereMenu` (returns false) ->
   * `subtreeItemCount` (drops the Expand contribution) ->
   * `showSubtreeMenu` (may become false if Expand was the lone
   * Subtree contributor) -- keeping all downstream accounting
   * consistent with the visible suppression.
   *
   * Same shape as `hasContainerDescendants`-gated suppression of
   * the new top-level row in v0.23.0: both eliminate cross-row
   * duplication with the bolded surfaced shortcut.
   */
  private isLoneDepth1RedundantWithSurfaced(node: TreeNode): boolean {
    return this.maxDescendantDepth(node) === 1 && this.defaultActionKind() === 'expandRow';
  }

  /**
   * Maps an `ExpandSingleAction` to its elevated label (the
   * row-level form, where the menu name no longer carries the
   * "from here" scope and the label has to restore it).
   *
   * v0.23.0: the `'expandAll'` arm was deleted alongside the type
   * variant. The switch covers `depth: 1..9`; the `default` arm
   * is unreachable given the predicate loop bound (matches the
   * `expandFromHereSingleAction` range) but is retained as
   * defense-in-depth.
   */
  expandSingleElevatedLabel(action: ExpandSingleAction): string {
    switch (action.depth) {
      case 1:
        return this.ctxExpandToDepth1ElevatedLabel;
      case 2:
        return this.ctxExpandToDepth2ElevatedLabel;
      case 3:
        return this.ctxExpandToDepth3ElevatedLabel;
      case 4:
        return this.ctxExpandToDepth4ElevatedLabel;
      case 5:
        return this.ctxExpandToDepth5ElevatedLabel;
      case 6:
        return this.ctxExpandToDepth6ElevatedLabel;
      case 7:
        return this.ctxExpandToDepth7ElevatedLabel;
      case 8:
        return this.ctxExpandToDepth8ElevatedLabel;
      case 9:
        return this.ctxExpandToDepth9ElevatedLabel;
      default:
        return this.ctxExpandToDepth1ElevatedLabel;
    }
  }

  /**
   * Click handler for an elevated Expand single action (when the
   * Expand sub-submenu would have only one item, that item renders
   * directly at the Subtree or row level).
   *
   * v0.23.0: the `'expandAll'` arm was deleted; the elevated
   * Expand single action is now always depth-based.
   */
  onExpandSingleElevatedClick(node: TreeNode, action: ExpandSingleAction): void {
    this.expandToDepthFromHere(node, action.depth);
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
    this.setExpanded(node, false);
  }

  /**
   * Expands the clicked node and every container in its subtree.
   * Caller should guard with `showExpandAllFromHere(node)` AND
   * `hasContainerDescendants(node)` (the new top-level row in
   * v0.23.0 includes both gates; primitives-only containers fall
   * through to the bolded `Expand 1 level` surfaced shortcut).
   *
   * `source` is `'topRow'` for the new top-level `Expand all from
   * here` row (the only menu entry point in v0.23.0+ -- the deep
   * `Subtree > Expand > All` leaf and the in-Subtree `expandAll`
   * elevation were both retired). The value is intentionally
   * non-`'top'` because the new row is non-bolded; sibling events
   * `tree.contextMenu.collapse` and `tree.contextMenu.expandToDepth`
   * use `'top'` for their bolded surfaced shortcuts. KQL queries
   * that cross-filter on `source` must use
   * `where customDimensions.source in ('top', 'topRow')` to union
   * both styles.
   */
  expandAllFromHere(node: TreeNode, source: 'topRow' = 'topRow'): void {
    const start = performance.now();
    if (!node.children?.length) return;
    this.logger.info('tree.contextMenu.expandAllFromHere', { source });
    let nodeCount = 0;
    let maxDepth = 0;
    const next = new Set(this.expandedPaths());
    const walk = (currentNode: TreeNode, relativeDepth: number): void => {
      if (!currentNode.children?.length) return;
      nodeCount += 1;
      maxDepth = Math.max(maxDepth, relativeDepth);
      next.add(currentNode.pathString);
      for (const child of currentNode.children) walk(child, relativeDepth + 1);
    };
    walk(node, 0);
    this.setExpandedBulk(next);
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
   * The in-Subtree per-depth items cover `relativeDepth: 1..9`
   * (extended from 1..5 in v0.23.0 to mirror the toolbar's
   * `Expand to Level` dropdown range). Defaults to `'submenu'` for
   * backward compatibility with existing call sites.
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
    const next = new Set(this.expandedPaths());
    const walk = (currentNode: TreeNode, currentDepth: number): void => {
      if (!currentNode.children?.length) return;
      if (currentDepth >= relativeDepth) return;
      nodeCount += 1;
      next.add(currentNode.pathString);
      for (const child of currentNode.children) walk(child, currentDepth + 1);
    };
    walk(node, 0);
    this.setExpandedBulk(next);
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
    return !!node.children?.length && this.isExpanded(node);
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
    const current = this.expandedPaths();
    let next: Set<string> | null = null;
    for (const child of result.narrowSet) {
      if (current.has(child.pathString)) {
        if (next === null) next = new Set(current);
        next.delete(child.pathString);
      }
    }
    for (const child of result.widerSet) {
      if (current.has(child.pathString)) {
        if (next === null) next = new Set(current);
        next.delete(child.pathString);
      }
    }
    if (next !== null) this.setExpandedBulk(next);
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
    const current = this.expandedPaths();
    let next: Set<string> | null = null;
    for (const child of result.narrowSet) {
      if (current.has(child.pathString)) {
        if (next === null) next = new Set(current);
        next.delete(child.pathString);
      }
    }
    if (next !== null) this.setExpandedBulk(next);
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
        if (!this.isExpanded(child)) continue;
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
      if (!this.isExpanded(c)) {
        allExpanded = false;
        return;
      }
      for (const child of c.children) walk(child);
    };
    walk(node);
    return allExpanded;
  }

  /**
   * Public wrapper around `maxDescendantDepth` for template-side
   * gating under `strictTemplates`. True iff `node` has at least
   * one container descendant (`maxDescendantDepth > 0`); false for
   * primitives-only containers and leaves.
   *
   * Used to gate the v0.23.0 top-level `Expand all from here` row:
   * when the subtree has no container descendants, `expandAll`
   * produces the same visible state change as the bolded `Expand
   * 1 level` surfaced shortcut, so rendering both adjacent rows
   * would be cross-row duplication.
   */
  hasContainerDescendants(node: TreeNode): boolean {
    return this.maxDescendantDepth(node) > 0;
  }

  /**
   * Returns the label for the top-level `Expand all from here` row.
   * Suffixes the label with the level count (`(+N levels)`) whenever
   * the row is visible, so the user can see how deep `all` will go
   * before clicking.
   *
   * Metric note: `maxDescendantDepth(node)` returns the relative
   * depth of the deepest **container** descendant (containers below
   * `node`; primitive leaves don't extend the count). But
   * `expandAllFromHere` walks every container at relative depths
   * `0..maxDescendantDepth` -- that's `maxDescendantDepth + 1`
   * distinct levels of expansion in the submenu's `+N levels`
   * vocabulary. The submenu's per-row depth options
   * (`showExpandToDepth`) cap at `maxDescendantDepth` to avoid
   * duplicating this row's end state; this label therefore always
   * reads exactly one more than the largest submenu entry, which is
   * the deliberate "+M+1 levels" the submenu intentionally omits.
   *
   * Threshold change (v0.25.0 follow-up bugfix): the prior
   * `maxDescendantDepth >= 2` threshold was rooted in a now-invalid
   * concern about a `(+1 level)` suffix colliding with the bolded
   * `Expand 1 level` surfaced shortcut. With the corrected metric
   * the smallest visible suffix is `(+2 levels)` -- no `(+1 level)`
   * is ever rendered. The earlier "the verbs `1 level` vs `all`
   * carry the distinction without an explicit count" rationale is
   * superseded: with the corrected metric the suffix carries
   * genuine information (the action's reach is exactly `+2` rather
   * than the bolded shortcut's `+1`), not redundant decoration.
   *
   * The only remaining early-return is `containerDepth < 1`
   * (primitives-only safe default). In production the row is gated
   * out by `hasContainerDescendants` (`maxDescendantDepth > 0`); the
   * early-return covers programmatic callers.
   *
   * Telemetry divergence: `tree.expand.slow`
   * (`emitSlowExpandIfNeeded`) emits `depth: containerDepth` for both
   * top-row and submenu sources, preserving cross-version analytics
   * continuity. The visible label and the telemetry depth field
   * are therefore intentionally off-by-one for top-row events.
   * Renaming or splitting the telemetry field is out of scope for
   * this fix and is batched with issue #241 (telemetry migration).
   *
   * The suffixed message is always plural ("levels") because the
   * smallest visible value is 2; the source string avoids an i18n
   * ICU plural for which the codebase has no precedent.
   *
   * The trans-unit ID `@@tree.contextMenu.expandAllFromHere.withDepth`
   * is historical (introduced when the value was `containerDepth`).
   * Per i18n stability rule (AGENTS.md s4), the ID stays even though
   * the value is now `containerDepth + 1` (level count, not depth).
   */
  ctxExpandAllFromHereLabelFor(node: TreeNode): string {
    const containerDepth = this.maxDescendantDepth(node);
    if (containerDepth < 1) return this.ctxExpandAllFromHereElevatedLabel;
    const levels = containerDepth + 1;
    return $localize`:@@tree.contextMenu.expandAllFromHere.withDepth:Expand all from here (+${levels}:LEVELS: levels)`;
  }

  /**
   * Length of the longest path from `node` down to any descendant
   * **container** (not counting primitive leaves). Drives the cap on
   * visible "Expand to depth +N" entries so we never offer an `+N`
   * deeper than the subtree actually has containers to expand.
   *
   * Counts only containers because primitives render as soon as
   * their parent container is expanded -- you never need an extra
   * `+1` to "reveal" a leaf, so its depth doesn't extend the
   * expand-actionable subtree depth. Earlier this method counted
   * all descendants, which produced a redundant `+N` entry on
   * containers whose only descendants were leaves
   * (e.g. `{ a: 1 }` clicked on `outer` showed Expand all + +1
   * + +N up to leaf depth, with multiple entries doing the same
   * thing as Expand all). Fixed in v0.19.4.
   *
   * Returns 0 when `node` has no container descendants (i.e. all
   * children are primitive leaves).
   */
  private maxDescendantDepth(node: TreeNode): number {
    let max = 0;
    const walk = (c: TreeNode, d: number): void => {
      if (!c.children?.length) return;
      // c is a container; record its depth (relative to the original
      // `node`, which is at depth 0).
      if (d > max) max = d;
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
      if (d < relativeDepth && !this.isExpanded(c)) {
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
   * After a search-by-key/value completes, sets the active hit to
   * the clicked row when it landed in the result set; otherwise
   * falls back to the first hit AT-OR-AFTER the clicked row's
   * document-order position. The "at-or-after" fallback (rather
   * than always `0`) keeps the menu flow consistent with the
   * cursor-aware reset effect: a click expresses "anchor here",
   * and snapping forward to the nearest hit honors that intent
   * better than always cycling back to the start. When the clicked
   * path is unknown to `nodeOrder` (stale path), falls through to
   * `0` so the user still lands on a valid hit.
   *
   * Deferred via `queueMicrotask` because the existing reset effect
   * (which tracks `searchHitPaths`) is itself scheduled on the
   * microtask queue when our `prefs.update` / `search.set` calls
   * mark `searchHitPaths` dirty. By queueing our update *after*
   * that signal write, our microtask runs later in FIFO order and
   * our value wins the race. Without this, the effect would
   * clobber our set back to its at-or-after fallback after we
   * returned.
   */
  private activateClickedHitOrFirst(clickedPath: string): void {
    queueMicrotask(() => {
      const paths = this.searchHitPaths();
      if (paths.length === 0) {
        this.activeHitIndex.set(-1);
        return;
      }
      const idx = paths.indexOf(clickedPath);
      let next: number;
      if (idx >= 0) {
        next = idx;
      } else {
        const orderMap = this.nodeOrder();
        const selPos = orderMap.get(clickedPath);
        next = selPos === undefined ? 0 : this.firstHitIndexAtOrAfter(paths, selPos, orderMap);
      }
      this.activeHitIndex.set(next);
      const target = paths[next] as string;
      this.setUserSelection(target);
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
   * Returns the haystack text used by tree-search when matching a node's
   * value. Mode-dependent for string leaves only:
   *
   * - `rawForStrings: false` (default, substring mode): returns the
   *   canonical JSON-escaped display form via `renderLeaf` -
   *   e.g. value `hello` -> `"hello"` (with quotes), value `a\nb` (real
   *   newline) -> `"a\\nb"` (JSON escape `\n`). This preserves the
   *   long-standing substring contract that typing what you see in the
   *   tree finds what you see (issue #95 Phase 0).
   * - `rawForStrings: true` (regex mode, and the planned `exact` /
   *   `starts_with` / `ends_with` modes in plan #3): returns the raw
   *   string value with no JSON wrapping - e.g. value `hello` -> `hello`,
   *   value `a\nb` -> `a<LF>b`. Regex anchors `^/$` and escape-sequence
   *   metachars like `\n` then behave as users typing native regex
   *   expect.
   *
   * Non-string types always pass through `renderLeaf` because their
   * display form has no JSON wrapping (numbers `42`, booleans `true`,
   * `null`); the mode flag is a no-op for them. Containers return `''`
   * via `renderLeaf` and are excluded by the caller before reaching
   * here.
   *
   * See `DESIGN_SPEC.md:498` and the §Search highlight match-semantics
   * note for the full mode x type contract.
   */
  private valueHaystack(node: TreeNode, opts: { rawForStrings: boolean }): string {
    if (opts.rawForStrings && node.type === 'string') {
      return String(node.value);
    }
    return this.renderLeaf(node.value, node.type);
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
    if (this.isExpanded(node)) return EMPTY_ICONS;
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
      const candidatePathString = formatPath([...candidate]);
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
      const candidatePathString = formatPath([...candidate]);
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
    const { root, nodeCount } = buildTree(raw);
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
}
