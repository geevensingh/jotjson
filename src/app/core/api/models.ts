export interface JsonBlob {
  id: string;
  slug: string;
  content: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  ownerId: string;
  isPublic: boolean;
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
   * The wire surface accepts the legacy `defaultRuleSetIds` and
   * ancient singular `defaultRuleSetId` and folds both into this
   * array on read; new writes only emit `activeRuleSetIds`.
   */
  activeRuleSetIds: string[];
  editorWordWrap: boolean;
  layoutOrientation: 'horizontal' | 'vertical';
  treeFontSize: number;
  treeShowTypeLabels: boolean;
  treeShowDateAnnotations: boolean;
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
  searchCaseSensitive: boolean;
  searchRegexMode: boolean;
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
export type FormattingIcon =
  | 'warning'
  | 'check'
  | 'star'
  | 'info'
  | 'error'
  | 'flag'
  | 'bookmark';

export const FORMATTING_ICONS: readonly FormattingIcon[] = [
  'warning',
  'check',
  'star',
  'info',
  'error',
  'flag',
  'bookmark'
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
export type FormattingRuleMatchType =
  | 'exact'
  | 'contains'
  | 'starts_with'
  | 'ends_with';

export interface FormattingRule {
  id: string;
  target: 'key' | 'value' | 'key_and_value';
  matchType: FormattingRuleMatchType;
  matchValue: string;
  caseSensitive: boolean;
  style: FormattingStyle;
}

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
