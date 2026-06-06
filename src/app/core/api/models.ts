export interface BlobHighlight {
  path: string;
  color: string;
  cascade: boolean;
}

export interface JsonBlob {
  id: string;
  slug: string;
  content: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  ownerId: string;
  highlights?: BlobHighlight[];
  version: number;
}

/**
 * Metadata describing a blob that the server silently deleted to make room
 * for a new one under the auto-FIFO quota strategy. Kept off JsonBlob so the
 * shape of stored blobs stays clean.
 */
export interface AutoDeletedBlobInfo {
  id: string;
  slug: string;
  title?: string;
}

/**
 * The POST /api/blobs response: the newly-created blob, plus an optional
 * `autoDeleted` marker present only when the auto-FIFO quota strategy kicked
 * in and the server removed the caller's oldest blob.
 */
export type CreateBlobResponse = JsonBlob & { autoDeleted?: AutoDeletedBlobInfo };

export interface User {
  id: string;
  displayName: string;
  email: string;
  avatarUrl?: string;
  createdAt: string;
  plan: 'free' | 'pro';
  preferences: UserPreferences;
}

export interface ThemeColorSet {
  selectionColor: string;
  matchingValueColor: string;
  ancestorColor: string;
  searchHighlightColor: string;
  manualHighlightColor: string;
}

export interface TreeHighlightColors {
  dark: ThemeColorSet;
  light: ThemeColorSet;
}

export interface UserPreferences {
  theme: 'dark' | 'light' | 'system';
  editorFontSize: number;
  editorTabSize: 2 | 4;
  defaultTreeExpansionDepth: number;
  /**
   * Rule sets applied to the JSON view (eye/eye-off toggle on the
   * Formatting Rules listing page; chip toggle on the home toolbar).
   * Persisted server-side so the selection survives across sessions
   * and devices. IDs that no longer resolve to an owned rule set are
   * filtered out at read time. See DESIGN_SPEC.md §Features 7.
   *
   * Naming history: this field was originally `activeRuleSetIds`, was
   * renamed to `defaultRuleSetIds` in M6f-5, then renamed back to
   * `activeRuleSetIds` (issue #83) because the toggle is plain
   * enabled/disabled - there is no separate per-document override.
   * The wire surface emits only this canonical key; stale stored
   * docs default to `[]` server-side. See DESIGN_SPEC.md ->
   * Versioning -> Schema evolution.
   */
  activeRuleSetIds: string[];
  editorWordWrap: boolean;
  layoutOrientation: 'horizontal' | 'vertical';
  treeFontSize: number;
  treeShowTypeLabels: boolean;
  treeShowDateAnnotations: boolean;
  /**
   * When true, JSONC line/block comments harvested by the parser are
   * surfaced in the tree view as dimmed inline annotations next to the
   * value (or before the key for leading comments). Default true; this
   * is the named feature of M7k. See DESIGN_SPEC.md - Home Page Tree.
   */
  treeShowComments: boolean;
  treeDateAnnotationUnits: {
    year: boolean;
    month: boolean;
    day: boolean;
    hour: boolean;
    minute: boolean;
    second: boolean;
  };
  treeDateAnnotationFriendlyForms: boolean;
  treeAssumeUtcForIsoDateTime: boolean;
  treeAssumeUtcForIsoDateOnly: boolean;
  recentlyViewedEnabled: boolean;
  /**
   * When true, selecting a tree row reveals the matching range in the
   * editor and moving the editor cursor selects the matching tree row.
   * When false, both panes operate independently. Default true. See
   * DESIGN_SPEC.md - Tree feature, selection sync.
   */
  treeEditorSelectionSync: boolean;
  /**
   * When true, the JSON tree expands to an automatically computed depth
   * that fits the visible viewport (auto-fit mode). When false, the tree
   * expands to the fixed depth set by `defaultTreeExpansionDepth`.
   * Default true. See DESIGN_SPEC.md - Tree feature, auto-fit expansion.
   */
  treeAutoFitToWindow: boolean;
  searchCaseSensitive: boolean;
  /**
   * How tree search compares the query against keys and values. The
   * four anchored modes (`exact`, `contains`, `starts_with`,
   * `ends_with`) are shared with formatting-rule match types via the
   * `SearchMatchMode = FormattingRuleMatchType | 'regex'` alias - see
   * the `SearchMatchMode` declaration below and `FormattingRuleMatchType`
   * further down in this file. Default `'contains'`. Renamed from the
   * legacy boolean `searchRegexMode` (see DESIGN_SPEC.md -> Versioning
   * -> Schema evolution).
   */
  searchMatchMode: SearchMatchMode;
  searchScope: 'keys' | 'values' | 'both';
  /**
   * Restricts tree search to nodes whose classified value type matches.
   * `'all'` means no type filter. When set to a specific type, the
   * existing `searchScope` rules still decide whether key text and/or
   * value text are eligible for the text match. Empty query +
   * non-`'all'` lists every node of that type as a navigator.
   *
   * Mirrors `ValueClassification` from
   * `src/app/shared/utils/value-classifier.ts` minus `'undefined'`.
   */
  searchValueType:
    | 'all'
    | 'date'
    | 'date/time'
    | 'uuid'
    | 'url'
    | 'email'
    | 'path'
    | 'ipv4'
    | 'ipv6'
    | 'integer'
    | 'number'
    | 'string'
    | 'boolean'
    | 'null'
    | 'array'
    | 'object';
  blobQuotaStrategy: 'auto_fifo' | 'manual';
  seenBlobQuotaModal: boolean;
  seenClipboardBanner: boolean;
  /**
   * Display prefix used when copying a tree row's path to the clipboard.
   * Internal/canonical `pathString` always uses the JSONPath sentinel `$`;
   * only the clipboard text is rewritten per this preference.
   *
   * - `jsonpath`: `$.foo[0]` (default)
   * - `none`:     `foo[0]` (lodash-style; leading dot stripped)
   * - `root`:     `root.foo[0]`
   * - `data`:     `Data.foo[0]` (capital D)
   */
  treePathRoot: 'jsonpath' | 'none' | 'root' | 'data';
  /**
   * Cold-boot clipboard auto-paste behavior. When the home page (`/`) is
   * loaded with valid object/array JSON in the clipboard (and clipboard
   * permission is granted), this controls what happens:
   *
   * - `ask`:    show a one-shot non-blocking banner offering Always /
   *             Just this time / Never (default).
   * - `always`: silently load the clipboard JSON instead of the saved
   *             draft, with an Undo snackbar that restores the prior
   *             draft if clicked.
   * - `never`:  feature dormant; never read the clipboard on cold boot
   *             and never show the banner.
   *
   * Roams server-side for signed-in users, but clipboard permission
   * remains per-device/per-origin: a roamed `'always'` only activates
   * after each browser independently grants clipboard-read.
   */
  coldBootClipboardAutoPaste: 'ask' | 'always' | 'never';
  treeHighlightColors: TreeHighlightColors;
}

export type HistoryAction = 'viewed';

export interface HistoryEntry {
  id: string;
  userId: string;
  blobId?: string;
  slug?: string;
  title?: string;
  accessedAt: string;
  action: HistoryAction;
}

/**
 * Closed whitelist of icon identifiers a formatting rule may attach to
 * a matched key/value. New icons require a spec amendment, not a
 * user-supplied free-form string. See DESIGN_SPEC.md §Features 7.
 */
export type FormattingIcon = 'warning' | 'check' | 'star' | 'info' | 'error' | 'flag' | 'bookmark';

export const FORMATTING_ICONS: readonly FormattingIcon[] = [
  'warning',
  'check',
  'star',
  'info',
  'error',
  'flag',
  'bookmark',
] as const;

export interface FormattingStyle {
  backgroundColor?: string;
  textColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  borderColor?: string;
  icon?: FormattingIcon;
}

/**
 * Match-type union for v1. The `regex` option is deferred to v1.1
 * pending a safe-evaluation strategy (see DESIGN_SPEC.md §Features 7,
 * "Regex policy"). Add `'regex'` back here when M6+ ships it.
 */
export type FormattingRuleMatchType = 'exact' | 'contains' | 'starts_with' | 'ends_with';

/**
 * Match-mode union for the tree search feature. Extends
 * `FormattingRuleMatchType` with `'regex'`; the four anchored tokens
 * are intentionally shared so both surfaces speak the same vocabulary.
 * Tree search can include `'regex'` today because the pattern is
 * compiled per-keystroke against the local in-memory tree and is never
 * persisted or shared with other users; the safe-evaluation concern
 * that deferred `'regex'` for `FormattingRuleMatchType` (persisted,
 * user-shared rules) does not apply here. See
 * `UserPreferences.searchMatchMode`.
 */
export type SearchMatchMode = FormattingRuleMatchType | 'regex';

export interface FormattingRuleSimple {
  id: string;
  /** Missing legacy kind is read as 'simple'. */
  kind?: 'simple';
  target: 'key' | 'value' | 'key_and_value';
  matchType: FormattingRuleMatchType;
  matchValue: string;
  caseSensitive: boolean;
  style: FormattingStyle;
}

export interface FormattingRulePair {
  id: string;
  kind: 'pair';
  keyMatch: KeyMatch;
  valueMatch: ValueMatch;
  style: FormattingStyle;
}

export interface KeyMatch {
  matchType: FormattingRuleMatchType;
  matchValue: string;
  caseSensitive: boolean;
}

export type ValueMatch =
  | {
      kind: 'text';
      matchType: FormattingRuleMatchType;
      matchValue: string;
      caseSensitive: boolean;
    }
  | {
      kind: 'predicate';
      predicate: ValuePredicate;
    };

export type ValuePredicate =
  | 'is_null'
  | 'is_not_null'
  | 'is_empty'
  | 'is_not_empty'
  | 'has_content'
  | 'lacks_content'
  | 'is_string'
  | 'is_not_string'
  | 'is_number'
  | 'is_not_number'
  | 'is_integer'
  | 'is_not_integer'
  | 'is_boolean'
  | 'is_not_boolean'
  | 'is_object'
  | 'is_not_object'
  | 'is_array'
  | 'is_not_array';

export type ValueKind = 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object';

export type FormattingRule = FormattingRuleSimple | FormattingRulePair;

export interface FormattingRuleSet {
  id: string;
  userId: string;
  name: string;
  rules: FormattingRule[];
  /**
   * Monotonically incremented on every successful PUT. Surfaced as the
   * `ETag` response header and required via `If-Match` on PUT for
   * optimistic concurrency. See DESIGN_SPEC.md §Features 7.
   */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Server-defined built-in preset returned by `GET /api/rule-set-presets`.
 * Cloned into a user-owned rule set via
 * `POST /api/rule-set-presets/:id/clone`. See DESIGN_SPEC.md §Features 7
 * "Built-in Presets".
 */
export interface RuleSetPreset {
  id: string;
  name: string;
  rules: FormattingRule[];
}

/**
 * Wire payload accepted by POST `/api/rule-sets` and PUT
 * `/api/rule-sets/{id}`. The server assigns `id`, `userId`, `version`,
 * `createdAt`, and `updatedAt`; only `name` + `rules` are caller-supplied.
 */
export interface RuleSetPayload {
  name: string;
  rules: FormattingRule[];
}
