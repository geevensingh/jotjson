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
}

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
   * `activeRuleSetIds` (issue #83). The wire surface accepts the
   * legacy `defaultRuleSetIds` and ancient singular
   * `defaultRuleSetId` and folds both into this array on read by
   * `normalizeStoredPreferences`. New writes only emit
   * `activeRuleSetIds`.
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
   * stored docs that still carry `historyTrackingMode` are coerced to
   * `recentlyViewedEnabled: true` by `normalizeStoredPreferences`
   * (both legacy values map to true since the narrowed feature is
   * strictly less invasive than either old mode).
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
  searchRegexMode: boolean;
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
  treeHighlightColors: TreeHighlightColors;
}

const DEFAULT_TREE_DATE_ANNOTATION_UNITS: TreeDateAnnotationUnits = {
  year: true,
  month: true,
  day: true,
  hour: true,
  minute: true,
  second: true
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
  searchRegexMode: false,
  searchScope: 'both',
  searchValueType: 'all',
  blobQuotaStrategy: 'auto_fifo',
  seenBlobQuotaModal: false,
  seenClipboardBanner: false,
  treePathRoot: 'jsonpath',
  treeHighlightColors: {
    dark: {
      selectionColor: '#264f78',
      matchingValueColor: '#3e3d32',
      ancestorColor: '#2a2d2e',
      searchHighlightColor: '#6a4c00'
    },
    light: {
      selectionColor: '#cce4f7',
      matchingValueColor: '#fff4cc',
      ancestorColor: '#ececec',
      searchHighlightColor: '#ffe082'
    }
  }
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
const LAYOUTS: readonly UserPreferences['layoutOrientation'][] = ['horizontal', 'vertical'] as const;
const SEARCH_SCOPES: readonly UserPreferences['searchScope'][] = ['keys', 'values', 'both'] as const;
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
  'object'
] as const;
const QUOTA_STRATEGIES: readonly UserPreferences['blobQuotaStrategy'][] = [
  'auto_fifo',
  'manual'
] as const;
const TREE_PATH_ROOTS: readonly UserPreferences['treePathRoot'][] = [
  'jsonpath',
  'none',
  'root',
  'data'
] as const;
const ANNOTATION_UNIT_KEYS: readonly (keyof TreeDateAnnotationUnits)[] = [
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'second'
] as const;

/**
 * Whitelist of accepted preference keys on the wire. Stored docs may
 * still contain legacy keys (`historyTrackingMode`, `defaultRuleSetIds`,
 * `defaultRuleSetId`) from before M5a v1-narrowing / issue #83; those
 * are folded into the new shape by `normalizeStoredPreferences` on
 * read and never round-trip through this validator.
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
  'searchRegexMode',
  'searchScope',
  'searchValueType',
  'blobQuotaStrategy',
  'seenBlobQuotaModal',
  'seenClipboardBanner',
  'treePathRoot',
  'treeHighlightColors'
] as const;

const COLOR_SET_KEYS: readonly (keyof ThemeColorSet)[] = [
  'selectionColor',
  'matchingValueColor',
  'ancestorColor',
  'searchHighlightColor'
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Lenient read-side coercion for stored user docs. Accepts a possibly
 * legacy `preferences` blob (one with `historyTrackingMode` instead of
 * `recentlyViewedEnabled`, or `defaultRuleSetIds` / `defaultRuleSetId`
 * instead of `activeRuleSetIds`) and returns a normalized copy with
 * only the new fields.
 *
 * Unlike `normalizePreferences`, this does NOT throw on unknown keys or
 * out-of-range values - stored docs were validated when written, and a
 * read-time validation failure must never break `GET /api/me`. We only
 * patch the fields that changed shape.
 */
export function normalizeStoredPreferences(
  prefs: UserPreferences
): UserPreferences {
  // Stored docs may include a legacy `historyTrackingMode` key that's
  // not part of the current `UserPreferences` shape. Use an extended
  // view to read and then strip it.
  const view: UserPreferences & { historyTrackingMode?: unknown } = { ...prefs };
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
  view.treeDateAnnotationUnits = normalizeStoredAnnotationUnits(
    view.treeDateAnnotationUnits
  );
  delete view.historyTrackingMode;
  // Stored docs written before issue #83 had `defaultRuleSetIds` (the
  // M6f-5 name) or, even earlier, the singular `defaultRuleSetId`.
  // Fold both legacy shapes into `activeRuleSetIds` while preserving
  // the canonical key if it is already present (a doc that already
  // has `activeRuleSetIds` should not be clobbered).
  const legacyView = view as UserPreferences & {
    defaultRuleSetIds?: unknown;
    defaultRuleSetId?: unknown;
  };
  if (!Array.isArray(legacyView.activeRuleSetIds)) {
    const fromLegacyArray = Array.isArray(legacyView.defaultRuleSetIds)
      ? (legacyView.defaultRuleSetIds.filter((x) => typeof x === 'string') as string[])
      : [];
    const next = [...fromLegacyArray];
    if (
      typeof legacyView.defaultRuleSetId === 'string' &&
      legacyView.defaultRuleSetId.length > 0 &&
      !next.includes(legacyView.defaultRuleSetId)
    ) {
      next.unshift(legacyView.defaultRuleSetId);
    }
    legacyView.activeRuleSetIds = next;
  }
  // Always strip the legacy keys so they cannot round-trip back into
  // a PUT. `activeRuleSetIds` is canonical and is preserved.
  delete legacyView.defaultRuleSetIds;
  delete legacyView.defaultRuleSetId;
  return view;
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new PreferenceValidationError(
      `${field} must be one of ${allowed.join(', ')}`
    );
  }
  return value as T;
}

function assertInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new PreferenceValidationError(
      `${field} must be an integer between ${min} and ${max}`
    );
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
    second: typeof input['second'] === 'boolean' ? input['second'] : true
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
    second: assertBool(input['second'], `${field}.second`)
  };
}

function normalizeColorSet(input: unknown, field: string): ThemeColorSet {
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
    searchHighlightColor: assertHex(input['searchHighlightColor'], `${field}.searchHighlightColor`)
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
      throw new PreferenceValidationError(
        `treeHighlightColors has unknown field "${key}"`
      );
    }
  }

  const normalized: UserPreferences = {
    theme: assertEnum(raw['theme'], THEMES, 'theme'),
    editorFontSize: assertInt(raw['editorFontSize'], 'editorFontSize', 8, 32),
    editorTabSize: (assertEnum(
      String(raw['editorTabSize']),
      ['2', '4'] as const,
      'editorTabSize'
    ) === '2'
      ? 2
      : 4) as UserPreferences['editorTabSize'],
    defaultTreeExpansionDepth: assertInt(
      raw['defaultTreeExpansionDepth'],
      'defaultTreeExpansionDepth',
      0,
      10
    ),
    editorWordWrap: assertBool(raw['editorWordWrap'], 'editorWordWrap'),
    layoutOrientation: assertEnum(raw['layoutOrientation'], LAYOUTS, 'layoutOrientation'),
    treeFontSize: assertInt(raw['treeFontSize'], 'treeFontSize', 8, 32),
    treeShowTypeLabels: assertBool(raw['treeShowTypeLabels'], 'treeShowTypeLabels'),
    treeShowDateAnnotations: assertBool(raw['treeShowDateAnnotations'], 'treeShowDateAnnotations'),
    treeShowComments: assertBool(raw['treeShowComments'], 'treeShowComments'),
    treeDateAnnotationUnits: normalizeAnnotationUnits(
      raw['treeDateAnnotationUnits'],
      'treeDateAnnotationUnits'
    ),
    treeDateAnnotationFriendlyForms: assertBool(
      raw['treeDateAnnotationFriendlyForms'],
      'treeDateAnnotationFriendlyForms'
    ),
    treeAssumeUtcForIsoDateTime: assertBool(
      raw['treeAssumeUtcForIsoDateTime'],
      'treeAssumeUtcForIsoDateTime'
    ),
    treeAssumeUtcForIsoDateOnly: assertBool(
      raw['treeAssumeUtcForIsoDateOnly'],
      'treeAssumeUtcForIsoDateOnly'
    ),
    recentlyViewedEnabled: assertBool(
      raw['recentlyViewedEnabled'],
      'recentlyViewedEnabled'
    ),
    treeEditorSelectionSync: assertBool(
      raw['treeEditorSelectionSync'],
      'treeEditorSelectionSync'
    ),
    treeAutoFitToWindow:
      raw['treeAutoFitToWindow'] !== undefined
        ? assertBool(raw['treeAutoFitToWindow'], 'treeAutoFitToWindow')
        : DEFAULT_PREFERENCES.treeAutoFitToWindow,
    searchCaseSensitive: assertBool(raw['searchCaseSensitive'], 'searchCaseSensitive'),
    searchRegexMode: assertBool(raw['searchRegexMode'], 'searchRegexMode'),
    searchScope: assertEnum(raw['searchScope'], SEARCH_SCOPES, 'searchScope'),
    searchValueType: assertEnum(
      raw['searchValueType'],
      SEARCH_VALUE_TYPES,
      'searchValueType'
    ),
    blobQuotaStrategy: assertEnum(
      raw['blobQuotaStrategy'],
      QUOTA_STRATEGIES,
      'blobQuotaStrategy'
    ),
    seenBlobQuotaModal: assertBool(raw['seenBlobQuotaModal'], 'seenBlobQuotaModal'),
    seenClipboardBanner: assertBool(raw['seenClipboardBanner'], 'seenClipboardBanner'),
    treePathRoot: assertEnum(raw['treePathRoot'], TREE_PATH_ROOTS, 'treePathRoot'),
    treeHighlightColors: {
      dark: normalizeColorSet(colors['dark'], 'treeHighlightColors.dark'),
      light: normalizeColorSet(colors['light'], 'treeHighlightColors.light')
    },
    activeRuleSetIds: normalizeActiveRuleSetIds(raw)
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
 * the ancient singular `defaultRuleSetId` shape are folded into
 * `activeRuleSetIds` by `normalizeStoredPreferences` on read.
 */
function normalizeActiveRuleSetIds(raw: Record<string, unknown>): string[] {
  const source = raw['activeRuleSetIds'] ?? [];
  if (!Array.isArray(source)) {
    throw new PreferenceValidationError(
      'activeRuleSetIds must be an array of strings'
    );
  }
  if (source.length > 32) {
    throw new PreferenceValidationError('activeRuleSetIds has too many entries');
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of source) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new PreferenceValidationError(
        'activeRuleSetIds entries must be non-empty strings'
      );
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
