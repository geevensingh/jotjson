/**
 * Shared preference schema + normalization for the `/api/me/preferences`
 * endpoint. This file intentionally re-declares the same `UserPreferences`
 * shape as `src/app/core/api/models.ts` - `api/` has an independent
 * tsconfig and cannot import from the Angular app.
 *
 * Keep these two copies in lockstep. The canonical version is the one in
 * `DESIGN_SPEC.md`.
 */

export interface ThemeColorSet {
  selectionColor: string;
  matchingValueColor: string;
  ancestorColor: string;
  searchHighlightColor: string;
  manualHighlightColor: string;
}

/**
 * Match-mode union for the tree search feature. Parallels
 * `SearchMatchMode` in `src/app/core/api/models.ts` (cannot import
 * across workspaces). Tokens must stay in lockstep with that file.
 */
export type SearchMatchMode = 'exact' | 'contains' | 'starts_with' | 'ends_with' | 'regex';

export interface TreeHighlightColors {
  dark: ThemeColorSet;
  light: ThemeColorSet;
}

export interface TreeDateAnnotationUnits {
  year: boolean;
  month: boolean;
  day: boolean;
  hour: boolean;
  minute: boolean;
  second: boolean;
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
   * Naming history: was `activeRuleSetIds` originally, renamed to
   * `defaultRuleSetIds` in M6f-5, then renamed back to
   * `activeRuleSetIds` (issue #83). The wire surface emits only the
   * canonical key; `normalizeStoredPreferences` strips any legacy
   * `defaultRuleSetIds` / `defaultRuleSetId` left on stored docs and
   * defaults to `[]` when the canonical key is missing. See
   * DESIGN_SPEC.md -> Versioning -> Schema evolution.
   */
  activeRuleSetIds: string[];
  editorWordWrap: boolean;
  layoutOrientation: 'horizontal' | 'vertical';
  treeFontSize: number;
  treeShowTypeLabels: boolean;
  treeShowDateAnnotations: boolean;
  /**
   * When true, JSONC line/block comments harvested by the parser are
   * surfaced in the tree view as dimmed inline annotations next to
   * their nearest value. Default true; this is the named feature of
   * M7k. See DESIGN_SPEC.md - Home Page Tree.
   */
  treeShowComments: boolean;
  treeDateAnnotationUnits: TreeDateAnnotationUnits;
  treeDateAnnotationFriendlyForms: boolean;
  treeAssumeUtcForIsoDateTime: boolean;
  treeAssumeUtcForIsoDateOnly: boolean;
  /**
   * When true, JotJSON records a `viewed` history entry each time the
   * user opens a shared blob they don't own (debounced 5 minutes per
   * (user, blob) server-side). Default true.
   *
   * Replaces the legacy `historyTrackingMode: 'save_only' | 'all_actions'`
   * preference. The wire surface no longer accepts the legacy field;
   * `normalizeStoredPreferences` strips any `historyTrackingMode` left
   * on stored docs and defaults `recentlyViewedEnabled` to true when
   * missing (the narrowed feature is strictly less invasive than
   * either legacy mode, so true is the safest default).
   */
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
   *
   * One-shot migration (frontend only): if this field is absent from
   * a persisted prefs object, it defaults to false when the user had
   * customized `defaultTreeExpansionDepth` away from 2, and to true
   * otherwise. This preserves explicit slider customizations.
   */
  treeAutoFitToWindow: boolean;
  searchCaseSensitive: boolean;
  /**
   * How tree search compares the query against keys and values. The
   * four anchored modes (`exact`, `contains`, `starts_with`,
   * `ends_with`) are intentionally shared with the FormattingRule
   * match types declared in `src/app/core/api/models.ts:229` so the
   * two surfaces speak the same vocabulary. Tree search can include
   * `'regex'` today because the pattern is compiled per-keystroke
   * against the local in-memory tree and is never persisted or shared
   * with other users; the safe-evaluation concern that deferred
   * `'regex'` for `FormattingRuleMatchType` (persisted, user-shared
   * rules) does not apply here. Default `'contains'`. Renamed from
   * the legacy boolean `searchRegexMode` - see DESIGN_SPEC.md ->
   * Versioning -> Schema evolution.
   */
  searchMatchMode: SearchMatchMode;
  searchScope: 'keys' | 'values' | 'both';
  /**
   * When not `'all'`, the tree search restricts candidate nodes to
   * those whose classified value type matches; the existing
   * `searchScope` rules then decide whether key text and/or value
   * text are eligible for the text match. Empty query + non-`'all'`
   * lists every node of that type as a navigator.
   *
   * The string union mirrors `ValueClassification` in
   * `src/app/shared/utils/value-classifier.ts` minus `'undefined'`
   * (no JSON `undefined`). Default `'all'`.
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
   * Cold-boot clipboard auto-paste behavior. When the home page (`/`)
   * is loaded with valid object/array JSON in the clipboard (and
   * clipboard permission is granted), this controls what happens:
   *
   * - `ask`:    show a one-shot non-blocking banner offering Always /
   *             Just this time / Never (default).
   * - `always`: silently load the clipboard JSON instead of the saved
   *             draft, with an Undo snackbar.
   * - `never`:  feature dormant; never read the clipboard on cold boot.
   *
   * Roams server-side, but clipboard permission remains
   * per-device/per-origin: a roamed `'always'` only activates after
   * each browser independently grants clipboard-read.
   */
  coldBootClipboardAutoPaste: 'ask' | 'always' | 'never';
  treeHighlightColors: TreeHighlightColors;
}

const DEFAULT_TREE_DATE_ANNOTATION_UNITS: TreeDateAnnotationUnits = {
  year: true,
  month: true,
  day: true,
  hour: true,
  minute: true,
  second: true,
};

function defaultTreeDateAnnotationUnits(): TreeDateAnnotationUnits {
  return { ...DEFAULT_TREE_DATE_ANNOTATION_UNITS };
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  theme: 'system',
  editorFontSize: 14,
  editorTabSize: 2,
  defaultTreeExpansionDepth: 2,
  editorWordWrap: true,
  layoutOrientation: 'horizontal',
  treeFontSize: 13,
  treeShowTypeLabels: true,
  treeShowDateAnnotations: true,
  treeShowComments: true,
  treeDateAnnotationUnits: defaultTreeDateAnnotationUnits(),
  treeDateAnnotationFriendlyForms: true,
  treeAssumeUtcForIsoDateTime: true,
  treeAssumeUtcForIsoDateOnly: true,
  activeRuleSetIds: [],
  recentlyViewedEnabled: true,
  treeEditorSelectionSync: true,
  treeAutoFitToWindow: true,
  searchCaseSensitive: false,
  searchMatchMode: 'contains',
  searchScope: 'both',
  searchValueType: 'all',
  blobQuotaStrategy: 'auto_fifo',
  seenBlobQuotaModal: false,
  seenClipboardBanner: false,
  treePathRoot: 'jsonpath',
  coldBootClipboardAutoPaste: 'ask',
  treeHighlightColors: {
    dark: {
      selectionColor: '#264f78',
      matchingValueColor: '#3e3d32',
      ancestorColor: '#2a2d2e',
      searchHighlightColor: '#6a4c00',
      manualHighlightColor: '#7e6500',
    },
    light: {
      selectionColor: '#cce4f7',
      matchingValueColor: '#fff4cc',
      ancestorColor: '#ececec',
      searchHighlightColor: '#ffe082',
      manualHighlightColor: '#fff59d',
    },
  },
};

export class PreferenceValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'PreferenceValidationError';
  }
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const THEMES: readonly UserPreferences['theme'][] = ['dark', 'light', 'system'] as const;
const LAYOUTS: readonly UserPreferences['layoutOrientation'][] = [
  'horizontal',
  'vertical',
] as const;
const SEARCH_SCOPES: readonly UserPreferences['searchScope'][] = [
  'keys',
  'values',
  'both',
] as const;
const SEARCH_MATCH_MODES: readonly SearchMatchMode[] = [
  'exact',
  'contains',
  'starts_with',
  'ends_with',
  'regex',
] as const;
const SEARCH_VALUE_TYPES: readonly UserPreferences['searchValueType'][] = [
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
] as const;
const QUOTA_STRATEGIES: readonly UserPreferences['blobQuotaStrategy'][] = [
  'auto_fifo',
  'manual',
] as const;
const TREE_PATH_ROOTS: readonly UserPreferences['treePathRoot'][] = [
  'jsonpath',
  'none',
  'root',
  'data',
] as const;
const COLD_BOOT_CLIPBOARD_AUTO_PASTE_VALUES: readonly UserPreferences['coldBootClipboardAutoPaste'][] =
  ['ask', 'always', 'never'] as const;
const ANNOTATION_UNIT_KEYS: readonly (keyof TreeDateAnnotationUnits)[] = [
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'second',
] as const;

/**
 * Whitelist of accepted preference keys on the wire. Stored docs may
 * still contain legacy keys (`historyTrackingMode`, `defaultRuleSetIds`,
 * `defaultRuleSetId`) from before M5a v1-narrowing / issue #83;
 * `normalizeStoredPreferences` strips them on read so they never
 * round-trip through this validator. See DESIGN_SPEC.md -> Versioning
 * -> Schema evolution.
 */
const TOP_LEVEL_KEYS: readonly (keyof UserPreferences)[] = [
  'theme',
  'editorFontSize',
  'editorTabSize',
  'defaultTreeExpansionDepth',
  'activeRuleSetIds',
  'editorWordWrap',
  'layoutOrientation',
  'treeFontSize',
  'treeShowTypeLabels',
  'treeShowDateAnnotations',
  'treeShowComments',
  'treeDateAnnotationUnits',
  'treeDateAnnotationFriendlyForms',
  'treeAssumeUtcForIsoDateTime',
  'treeAssumeUtcForIsoDateOnly',
  'recentlyViewedEnabled',
  'treeEditorSelectionSync',
  'treeAutoFitToWindow',
  'searchCaseSensitive',
  'searchMatchMode',
  'searchScope',
  'searchValueType',
  'blobQuotaStrategy',
  'seenBlobQuotaModal',
  'seenClipboardBanner',
  'treePathRoot',
  'coldBootClipboardAutoPaste',
  'treeHighlightColors',
] as const;

const COLOR_SET_KEYS: readonly (keyof ThemeColorSet)[] = [
  'selectionColor',
  'matchingValueColor',
  'ancestorColor',
  'searchHighlightColor',
  'manualHighlightColor',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Lenient read-side coercion for stored user docs. Strips legacy keys
 * (`historyTrackingMode`, `defaultRuleSetIds`, `defaultRuleSetId`) so
 * they never reach the wire, and applies defensive defaults for fields
 * that may be missing on docs written before the field existed.
 *
 * Unlike `normalizePreferences`, this does NOT throw on unknown keys or
 * out-of-range values - stored docs were validated when written, and a
 * read-time validation failure must never break `GET /api/me`. We only
 * patch the fields that need a default and strip the legacy keys.
 *
 * See DESIGN_SPEC.md -> Versioning -> Schema evolution for the playbook.
 */
export function normalizeStoredPreferences(prefs: UserPreferences): UserPreferences {
  // Stored docs may include legacy keys (`historyTrackingMode`,
  // `searchRegexMode`, `defaultRuleSetIds`, `defaultRuleSetId`) that
  // are not part of the current `UserPreferences` shape. Use an
  // extended view to read and then strip them.
  const view: UserPreferences & {
    historyTrackingMode?: unknown;
    searchRegexMode?: unknown;
  } = { ...prefs };
  if (typeof view.recentlyViewedEnabled !== 'boolean') {
    // Both legacy `historyTrackingMode` values, missing values, and any
    // malformed value all fall back to the new default of true. This is
    // strictly less invasive than the legacy modes and the safest default.
    view.recentlyViewedEnabled = true;
  }
  if (typeof view.treeEditorSelectionSync !== 'boolean') {
    // `treeEditorSelectionSync` was added after the initial preference
    // schema. Stored docs from before its introduction default to true
    // (sync on) - matches DEFAULT_PREFERENCES.
    view.treeEditorSelectionSync = true;
  }
  if (typeof view.treeDateAnnotationFriendlyForms !== 'boolean') {
    view.treeDateAnnotationFriendlyForms = true;
  }
  if (typeof view.treeShowComments !== 'boolean') {
    // `treeShowComments` was added in M7k. Stored docs from before its
    // introduction default to true (the named feature ships visible) -
    // matches DEFAULT_PREFERENCES.
    view.treeShowComments = true;
  }
  if (
    typeof view.coldBootClipboardAutoPaste !== 'string' ||
    !(['ask', 'always', 'never'] as readonly string[]).includes(view.coldBootClipboardAutoPaste)
  ) {
    // `coldBootClipboardAutoPaste` was added in 0.x for the cold-boot
    // clipboard auto-paste feature. Stored docs from before its
    // introduction (or with an invalid value) default to 'ask' - the
    // safest fallback matches DEFAULT_PREFERENCES, surfaces the
    // banner once, and lets the user pick.
    view.coldBootClipboardAutoPaste = 'ask';
  }
  view.treeDateAnnotationUnits = normalizeStoredAnnotationUnits(view.treeDateAnnotationUnits);
  view.treeHighlightColors = normalizeStoredHighlightColors(view.treeHighlightColors);
  // searchMatchMode fold: rename + reshape from the legacy boolean
  // `searchRegexMode`. Precedence: if `searchMatchMode` is already a
  // valid enum value, take it as-is (covers the both-keys-present case
  // where a buggy or partial write left both fields). Otherwise fold
  // from `searchRegexMode === true` (strict bool check so a stringly
  // legacy value like `"true"` falls back to `'contains'`, the safest
  // default).
  if (
    typeof view.searchMatchMode !== 'string' ||
    !(SEARCH_MATCH_MODES as readonly string[]).includes(view.searchMatchMode)
  ) {
    view.searchMatchMode = view.searchRegexMode === true ? 'regex' : 'contains';
  }
  delete view.searchRegexMode;
  delete view.historyTrackingMode;
  // Stored docs written before issue #83 may carry `defaultRuleSetIds`
  // (the M6f-5 name) or, even earlier, the singular `defaultRuleSetId`.
  // We no longer synthesize `activeRuleSetIds` from those - stale shapes
  // default to `[]` and the user re-selects rule sets on next visit.
  // The legacy keys are still stripped so they cannot round-trip back
  // into a PUT.
  const legacyView = view as UserPreferences & {
    defaultRuleSetIds?: unknown;
    defaultRuleSetId?: unknown;
  };
  if (!Array.isArray(legacyView.activeRuleSetIds)) {
    legacyView.activeRuleSetIds = [];
  }
  delete legacyView.defaultRuleSetIds;
  delete legacyView.defaultRuleSetId;
  return view;
}

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new PreferenceValidationError(`${field} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function assertInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new PreferenceValidationError(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function assertBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new PreferenceValidationError(`${field} must be a boolean`);
  }
  return value;
}

function assertHex(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
    throw new PreferenceValidationError(`${field} must be a #RRGGBB hex color`);
  }
  return value.toLowerCase();
}

function normalizeStoredAnnotationUnits(input: unknown): TreeDateAnnotationUnits {
  if (!isRecord(input)) {
    return defaultTreeDateAnnotationUnits();
  }
  return {
    year: typeof input['year'] === 'boolean' ? input['year'] : true,
    month: typeof input['month'] === 'boolean' ? input['month'] : true,
    day: typeof input['day'] === 'boolean' ? input['day'] : true,
    hour: typeof input['hour'] === 'boolean' ? input['hour'] : true,
    minute: typeof input['minute'] === 'boolean' ? input['minute'] : true,
    second: typeof input['second'] === 'boolean' ? input['second'] : true,
  };
}

function normalizeStoredHex(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : fallback;
}

function normalizeStoredColorSet(input: unknown, defaults: ThemeColorSet): ThemeColorSet {
  if (!isRecord(input)) {
    return { ...defaults };
  }
  return {
    selectionColor: normalizeStoredHex(input['selectionColor'], defaults.selectionColor),
    matchingValueColor: normalizeStoredHex(
      input['matchingValueColor'],
      defaults.matchingValueColor,
    ),
    ancestorColor: normalizeStoredHex(input['ancestorColor'], defaults.ancestorColor),
    searchHighlightColor: normalizeStoredHex(
      input['searchHighlightColor'],
      defaults.searchHighlightColor,
    ),
    manualHighlightColor: normalizeStoredHex(
      input['manualHighlightColor'],
      defaults.manualHighlightColor,
    ),
  };
}

function normalizeStoredHighlightColors(input: unknown): TreeHighlightColors {
  const colors = isRecord(input) ? input : {};
  return {
    dark: normalizeStoredColorSet(colors['dark'], DEFAULT_PREFERENCES.treeHighlightColors.dark),
    light: normalizeStoredColorSet(colors['light'], DEFAULT_PREFERENCES.treeHighlightColors.light),
  };
}

function normalizeAnnotationUnits(input: unknown, field: string): TreeDateAnnotationUnits {
  if (!isRecord(input)) {
    throw new PreferenceValidationError(`${field} must be an object`);
  }
  for (const key of Object.keys(input)) {
    if (!(ANNOTATION_UNIT_KEYS as readonly string[]).includes(key)) {
      throw new PreferenceValidationError(`${field} has unknown field "${key}"`);
    }
  }
  return {
    year: assertBool(input['year'], `${field}.year`),
    month: assertBool(input['month'], `${field}.month`),
    day: assertBool(input['day'], `${field}.day`),
    hour: assertBool(input['hour'], `${field}.hour`),
    minute: assertBool(input['minute'], `${field}.minute`),
    second: assertBool(input['second'], `${field}.second`),
  };
}

function normalizeColorSet(input: unknown, field: string, defaults: ThemeColorSet): ThemeColorSet {
  if (!isRecord(input)) {
    throw new PreferenceValidationError(`${field} must be an object`);
  }
  for (const key of Object.keys(input)) {
    if (!(COLOR_SET_KEYS as readonly string[]).includes(key)) {
      throw new PreferenceValidationError(`${field} has unknown field "${key}"`);
    }
  }
  return {
    selectionColor: assertHex(input['selectionColor'], `${field}.selectionColor`),
    matchingValueColor: assertHex(input['matchingValueColor'], `${field}.matchingValueColor`),
    ancestorColor: assertHex(input['ancestorColor'], `${field}.ancestorColor`),
    searchHighlightColor: assertHex(input['searchHighlightColor'], `${field}.searchHighlightColor`),
    manualHighlightColor:
      input['manualHighlightColor'] !== undefined
        ? assertHex(input['manualHighlightColor'], `${field}.manualHighlightColor`)
        : defaults.manualHighlightColor,
  };
}

/**
 * Accepts a fully-populated UserPreferences payload from the client and
 * returns a normalized copy. Rejects unknown keys, out-of-range numbers,
 * invalid enum values, and malformed hex colors.
 *
 * We deliberately require the full object (not a partial) - per the M3c
 * rubber-duck review, accepting partial updates on nested fields like
 * `treeHighlightColors` invites clobbers.
 */
export function normalizePreferences(raw: unknown): UserPreferences {
  if (!isRecord(raw)) {
    throw new PreferenceValidationError('Preferences payload must be an object');
  }

  for (const key of Object.keys(raw)) {
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      throw new PreferenceValidationError(`Unknown preference key "${key}"`);
    }
  }

  const colors = raw['treeHighlightColors'];
  if (!isRecord(colors)) {
    throw new PreferenceValidationError('treeHighlightColors must be an object');
  }
  for (const key of Object.keys(colors)) {
    if (key !== 'dark' && key !== 'light') {
      throw new PreferenceValidationError(`treeHighlightColors has unknown field "${key}"`);
    }
  }

  const normalized: UserPreferences = {
    theme: assertEnum(raw['theme'], THEMES, 'theme'),
    editorFontSize: assertInt(raw['editorFontSize'], 'editorFontSize', 8, 32),
    editorTabSize: (assertEnum(
      String(raw['editorTabSize']),
      ['2', '4'] as const,
      'editorTabSize',
    ) === '2'
      ? 2
      : 4) as UserPreferences['editorTabSize'],
    defaultTreeExpansionDepth: assertInt(
      raw['defaultTreeExpansionDepth'],
      'defaultTreeExpansionDepth',
      0,
      10,
    ),
    editorWordWrap: assertBool(raw['editorWordWrap'], 'editorWordWrap'),
    layoutOrientation: assertEnum(raw['layoutOrientation'], LAYOUTS, 'layoutOrientation'),
    treeFontSize: assertInt(raw['treeFontSize'], 'treeFontSize', 8, 32),
    treeShowTypeLabels: assertBool(raw['treeShowTypeLabels'], 'treeShowTypeLabels'),
    treeShowDateAnnotations: assertBool(raw['treeShowDateAnnotations'], 'treeShowDateAnnotations'),
    treeShowComments: assertBool(raw['treeShowComments'], 'treeShowComments'),
    treeDateAnnotationUnits: normalizeAnnotationUnits(
      raw['treeDateAnnotationUnits'],
      'treeDateAnnotationUnits',
    ),
    treeDateAnnotationFriendlyForms: assertBool(
      raw['treeDateAnnotationFriendlyForms'],
      'treeDateAnnotationFriendlyForms',
    ),
    treeAssumeUtcForIsoDateTime: assertBool(
      raw['treeAssumeUtcForIsoDateTime'],
      'treeAssumeUtcForIsoDateTime',
    ),
    treeAssumeUtcForIsoDateOnly: assertBool(
      raw['treeAssumeUtcForIsoDateOnly'],
      'treeAssumeUtcForIsoDateOnly',
    ),
    recentlyViewedEnabled: assertBool(raw['recentlyViewedEnabled'], 'recentlyViewedEnabled'),
    treeEditorSelectionSync: assertBool(raw['treeEditorSelectionSync'], 'treeEditorSelectionSync'),
    treeAutoFitToWindow:
      raw['treeAutoFitToWindow'] !== undefined
        ? assertBool(raw['treeAutoFitToWindow'], 'treeAutoFitToWindow')
        : DEFAULT_PREFERENCES.treeAutoFitToWindow,
    searchCaseSensitive: assertBool(raw['searchCaseSensitive'], 'searchCaseSensitive'),
    searchMatchMode: assertEnum(raw['searchMatchMode'], SEARCH_MATCH_MODES, 'searchMatchMode'),
    searchScope: assertEnum(raw['searchScope'], SEARCH_SCOPES, 'searchScope'),
    searchValueType: assertEnum(raw['searchValueType'], SEARCH_VALUE_TYPES, 'searchValueType'),
    blobQuotaStrategy: assertEnum(raw['blobQuotaStrategy'], QUOTA_STRATEGIES, 'blobQuotaStrategy'),
    seenBlobQuotaModal: assertBool(raw['seenBlobQuotaModal'], 'seenBlobQuotaModal'),
    seenClipboardBanner: assertBool(raw['seenClipboardBanner'], 'seenClipboardBanner'),
    treePathRoot: assertEnum(raw['treePathRoot'], TREE_PATH_ROOTS, 'treePathRoot'),
    coldBootClipboardAutoPaste:
      raw['coldBootClipboardAutoPaste'] !== undefined
        ? assertEnum(
            raw['coldBootClipboardAutoPaste'],
            COLD_BOOT_CLIPBOARD_AUTO_PASTE_VALUES,
            'coldBootClipboardAutoPaste',
          )
        : DEFAULT_PREFERENCES.coldBootClipboardAutoPaste,
    treeHighlightColors: {
      dark: normalizeColorSet(
        colors['dark'],
        'treeHighlightColors.dark',
        DEFAULT_PREFERENCES.treeHighlightColors.dark,
      ),
      light: normalizeColorSet(
        colors['light'],
        'treeHighlightColors.light',
        DEFAULT_PREFERENCES.treeHighlightColors.light,
      ),
    },
    activeRuleSetIds: normalizeActiveRuleSetIds(raw),
  };

  return normalized;
}

/**
 * `activeRuleSetIds` is the user's persisted list of "currently
 * applied" formatting rule sets. It must be a flat array of
 * non-empty strings each <= 64 chars; we cap the array at 32
 * entries (well above the 20-rule-sets-per-user limit) to bound
 * payload size and dedupe while preserving order.
 *
 * On the wire we accept only `activeRuleSetIds`. Stored docs with
 * the legacy `defaultRuleSetIds` (post-M6f-5, pre-issue #83) or
 * the ancient singular `defaultRuleSetId` shape are stripped on
 * read by `normalizeStoredPreferences`; stale stored docs missing
 * the canonical key default to `[]`. See DESIGN_SPEC.md ->
 * Versioning -> Schema evolution.
 */
function normalizeActiveRuleSetIds(raw: Record<string, unknown>): string[] {
  const source = raw['activeRuleSetIds'] ?? [];
  if (!Array.isArray(source)) {
    throw new PreferenceValidationError('activeRuleSetIds must be an array of strings');
  }
  if (source.length > 32) {
    throw new PreferenceValidationError('activeRuleSetIds has too many entries');
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of source) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new PreferenceValidationError('activeRuleSetIds entries must be non-empty strings');
    }
    if (entry.length > 64) {
      throw new PreferenceValidationError('activeRuleSetIds entry is too long');
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      result.push(entry);
    }
  }
  return result;
}
