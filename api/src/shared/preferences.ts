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

export interface UserPreferences {
  theme: 'dark' | 'light' | 'system';
  editorFontSize: number;
  editorTabSize: 2 | 4;
  defaultTreeExpansionDepth: number;
  /**
   * Rule sets applied by default when the user views JSON. The set
   * is mirrored as toggleable chips in the tree-view formatting
   * toolbar and as checkboxes on the Profile page. Persisted
   * server-side so the selection survives across sessions and
   * devices. IDs that no longer resolve to an owned rule set are
   * filtered out at read time. See DESIGN_SPEC.md §Features 7.
   *
   * Renamed from `activeRuleSetIds` in M6f-5; the legacy key (and
   * the legacy single-value `defaultRuleSetId`) are folded into
   * this array on read for one release of stale-client tolerance.
   */
  defaultRuleSetIds: string[];
  editorWordWrap: boolean;
  layoutOrientation: 'horizontal' | 'vertical';
  treeFontSize: number;
  treeShowTypeLabels: boolean;
  treeShowDateAnnotations: boolean;
  treeAssumeUtcForIsoDateTime: boolean;
  treeAssumeUtcForIsoDateOnly: boolean;
  /**
   * When true, JotJSON records a `viewed` history entry each time the
   * user opens a shared blob they don't own (debounced 5 minutes per
   * (user, blob) server-side). Default true.
   *
   * Replaces the legacy `historyTrackingMode: 'save_only' | 'all_actions'`
   * preference. Both legacy values coerce to `true` on read - the
   * narrowed feature is strictly less invasive than either old mode.
   */
  recentlyViewedEnabled: boolean;
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
  treeAssumeUtcForIsoDateTime: true,
  treeAssumeUtcForIsoDateOnly: true,
  defaultRuleSetIds: [],
  recentlyViewedEnabled: true,
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
/**
 * Legacy history tracking mode values. Accepted on the wire for one
 * release of stale-client tolerance and coerced to
 * `recentlyViewedEnabled: true` (both old modes map to true since the
 * narrowed feature is strictly less invasive than either).
 *
 * TODO(remove next release): drop legacy acceptance once stale clients
 * have refreshed.
 */
const LEGACY_HISTORY_MODES = ['save_only', 'all_actions'] as const;
type LegacyHistoryMode = (typeof LEGACY_HISTORY_MODES)[number];
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

/**
 * Whitelist of accepted preference keys on the wire.
 *
 * Includes `historyTrackingMode` for one-release legacy tolerance even
 * though it is no longer part of `UserPreferences`. The string literal
 * union is widened accordingly. TODO(remove next release): drop
 * `'historyTrackingMode'` once stale clients have refreshed.
 */
const TOP_LEVEL_KEYS: readonly (
  | keyof UserPreferences
  | 'historyTrackingMode'
  | 'defaultRuleSetId'
  | 'activeRuleSetIds'
)[] = [
  'theme',
  'editorFontSize',
  'editorTabSize',
  'defaultTreeExpansionDepth',
  // Legacy fields accepted on the wire and folded into
  // `defaultRuleSetIds` for one release of stale-client tolerance.
  // TODO(remove next release).
  'defaultRuleSetId',
  'activeRuleSetIds',
  'defaultRuleSetIds',
  'editorWordWrap',
  'layoutOrientation',
  'treeFontSize',
  'treeShowTypeLabels',
  'treeShowDateAnnotations',
  'treeAssumeUtcForIsoDateTime',
  'treeAssumeUtcForIsoDateOnly',
  'recentlyViewedEnabled',
  // Legacy field accepted on the wire and coerced to `recentlyViewedEnabled`
  // for one release of stale-client tolerance. TODO(remove next release).
  'historyTrackingMode',
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
 * Accept either `recentlyViewedEnabled` (new) or `historyTrackingMode`
 * (legacy) on the wire and return the boolean value. New field wins
 * when both are present. Both legacy values map to `true` since the
 * narrowed feature is strictly less invasive than either old mode.
 *
 * TODO(remove next release): drop legacy acceptance once stale clients
 * have refreshed.
 */
function coerceRecentlyViewedEnabled(raw: Record<string, unknown>): boolean {
  if (raw['recentlyViewedEnabled'] !== undefined) {
    return assertBool(raw['recentlyViewedEnabled'], 'recentlyViewedEnabled');
  }
  if (raw['historyTrackingMode'] !== undefined) {
    const legacy = raw['historyTrackingMode'];
    if (
      typeof legacy !== 'string' ||
      !(LEGACY_HISTORY_MODES as readonly string[]).includes(legacy)
    ) {
      throw new PreferenceValidationError(
        `historyTrackingMode must be one of ${LEGACY_HISTORY_MODES.join(', ')}`
      );
    }
    return true;
  }
  throw new PreferenceValidationError('recentlyViewedEnabled is required');
}

/**
 * Lenient read-side coercion for stored user docs. Accepts a possibly
 * legacy `preferences` blob (one with `historyTrackingMode` instead of
 * `recentlyViewedEnabled`) and returns a normalized copy with only the
 * new field.
 *
 * Unlike `normalizePreferences`, this does NOT throw on unknown keys or
 * out-of-range values - stored docs were validated when written, and a
 * read-time validation failure must never break `GET /api/me`. We only
 * patch the one field that changed shape.
 */
export function normalizeStoredPreferences(
  prefs: UserPreferences
): UserPreferences {
  // Stored docs may include a legacy `historyTrackingMode` key that's
  // not part of the current `UserPreferences` shape. Use an extended
  // view to read and then strip it.
  const view: UserPreferences & { historyTrackingMode?: unknown } = { ...prefs };
  if (typeof view.recentlyViewedEnabled !== 'boolean') {
    const legacy = view.historyTrackingMode;
    // Both legacy values coerce to true. Anything else (missing or
    // malformed) falls back to the new default of true.
    view.recentlyViewedEnabled =
      typeof legacy !== 'string' ||
      (LEGACY_HISTORY_MODES as readonly string[]).includes(legacy);
  }
  delete view.historyTrackingMode;
  // Stored docs written before M6f-5 had `activeRuleSetIds` (or even
  // earlier, `defaultRuleSetId`). Fold both legacy shapes into
  // `defaultRuleSetIds`. The DEFAULT_PREFERENCES merge in the
  // frontend handles the missing field on the wire, but
  // normalizeStoredPreferences may be called on its own on the API
  // side - migrate here so the next PUT round-trip succeeds without
  // the client having to know about the legacy gap.
  const legacyView = view as UserPreferences & {
    activeRuleSetIds?: unknown;
    defaultRuleSetId?: unknown;
  };
  if (!Array.isArray(legacyView.defaultRuleSetIds)) {
    const fromLegacyArray = Array.isArray(legacyView.activeRuleSetIds)
      ? (legacyView.activeRuleSetIds.filter((x) => typeof x === 'string') as string[])
      : [];
    const next = [...fromLegacyArray];
    if (typeof legacyView.defaultRuleSetId === 'string' && legacyView.defaultRuleSetId.length > 0) {
      if (!next.includes(legacyView.defaultRuleSetId)) {
        next.unshift(legacyView.defaultRuleSetId);
      }
    }
    legacyView.defaultRuleSetIds = next;
  }
  delete legacyView.activeRuleSetIds;
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
    treeAssumeUtcForIsoDateTime: assertBool(
      raw['treeAssumeUtcForIsoDateTime'],
      'treeAssumeUtcForIsoDateTime'
    ),
    treeAssumeUtcForIsoDateOnly: assertBool(
      raw['treeAssumeUtcForIsoDateOnly'],
      'treeAssumeUtcForIsoDateOnly'
    ),
    recentlyViewedEnabled: coerceRecentlyViewedEnabled(raw),
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
    defaultRuleSetIds: normalizeDefaultRuleSetIds(raw)
  };

  return normalized;
}

/**
 * `defaultRuleSetIds` is the user's persisted "apply by default"
 * selection of formatting rule sets. It must be a flat array of
 * non-empty strings each <= 64 chars; we cap the array at 32
 * entries (well above the 20-rule-sets-per-user limit) to bound
 * payload size and dedupe while preserving order.
 *
 * Migration (M6f-5): renamed from `activeRuleSetIds`, and absorbs
 * the now-removed single-value `defaultRuleSetId`. When the new
 * key is missing on the wire, fall back to the legacy array, and
 * if a legacy `defaultRuleSetId` string is present prepend it
 * (dedup-safe). One release of stale-client tolerance, then drop.
 * TODO(remove next release): drop the legacy fallbacks once stale
 * clients have refreshed.
 */
function normalizeDefaultRuleSetIds(raw: Record<string, unknown>): string[] {
  let source: unknown;
  if (raw['defaultRuleSetIds'] !== undefined) {
    source = raw['defaultRuleSetIds'];
  } else if (raw['activeRuleSetIds'] !== undefined) {
    source = raw['activeRuleSetIds'];
  } else {
    source = [];
  }
  if (!Array.isArray(source)) {
    throw new PreferenceValidationError(
      'defaultRuleSetIds must be an array of strings'
    );
  }
  if (source.length > 32) {
    throw new PreferenceValidationError('defaultRuleSetIds has too many entries');
  }
  const seen = new Set<string>();
  const result: string[] = [];
  // Legacy single-default folds in first so it keeps "default-most"
  // priority when both legacy fields are present on stale clients.
  const legacySingle = raw['defaultRuleSetId'];
  if (typeof legacySingle === 'string' && legacySingle.length > 0) {
    if (legacySingle.length > 64) {
      throw new PreferenceValidationError('defaultRuleSetId is too long');
    }
    seen.add(legacySingle);
    result.push(legacySingle);
  } else if (legacySingle !== undefined && legacySingle !== null && typeof legacySingle !== 'string') {
    throw new PreferenceValidationError('defaultRuleSetId must be a string or null');
  }
  for (const entry of source) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new PreferenceValidationError(
        'defaultRuleSetIds entries must be non-empty strings'
      );
    }
    if (entry.length > 64) {
      throw new PreferenceValidationError('defaultRuleSetIds entry is too long');
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      result.push(entry);
    }
  }
  return result;
}
