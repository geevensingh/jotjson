import {
  DEFAULT_PREFERENCES,
  normalizePreferences,
  normalizeStoredPreferences,
  PreferenceValidationError,
  UserPreferences
} from './preferences';

function valid(): unknown {
  return structuredClone(DEFAULT_PREFERENCES);
}

function dateAnnotationUnits(
  enabled: boolean
): UserPreferences['treeDateAnnotationUnits'] {
  return {
    year: enabled,
    month: enabled,
    day: enabled,
    hour: enabled,
    minute: enabled,
    second: enabled
  };
}

function mixedDateAnnotationUnits(): UserPreferences['treeDateAnnotationUnits'] {
  return {
    year: true,
    month: false,
    day: true,
    hour: false,
    minute: true,
    second: false
  };
}

describe('normalizePreferences', () => {
  it('accepts the default preferences unchanged', () => {
    const result = normalizePreferences(valid());
    expect(result).toEqual(DEFAULT_PREFERENCES);
  });

  it('rejects a non-object payload', () => {
    expect(() => normalizePreferences(null)).toThrow(PreferenceValidationError);
    expect(() => normalizePreferences('nope')).toThrow(PreferenceValidationError);
  });

  it('rejects unknown top-level keys', () => {
    const bad = valid() as Record<string, unknown>;
    bad['secret'] = 'leak';
    expect(() => normalizePreferences(bad)).toThrow(/Unknown preference key "secret"/);
  });

  it('rejects invalid enum values', () => {
    const bad = valid() as Record<string, unknown>;
    bad['theme'] = 'neon';
    expect(() => normalizePreferences(bad)).toThrow(/theme must be one of/);
  });

  it('rejects out-of-range numbers', () => {
    const bad = valid() as Record<string, unknown>;
    bad['editorFontSize'] = 99;
    expect(() => normalizePreferences(bad)).toThrow(/editorFontSize/);
  });

  it('rejects non-integer font sizes', () => {
    const bad = valid() as Record<string, unknown>;
    bad['editorFontSize'] = 14.5;
    expect(() => normalizePreferences(bad)).toThrow(/editorFontSize/);
  });

  it('rejects out-of-range treeFontSize', () => {
    const bad = valid() as Record<string, unknown>;
    bad['treeFontSize'] = 99;
    expect(() => normalizePreferences(bad)).toThrow(/treeFontSize/);
  });

  it('rejects non-integer treeFontSize', () => {
    const bad = valid() as Record<string, unknown>;
    bad['treeFontSize'] = 13.5;
    expect(() => normalizePreferences(bad)).toThrow(/treeFontSize/);
  });

  it('rejects non-boolean booleans', () => {
    const bad = valid() as Record<string, unknown>;
    bad['editorWordWrap'] = 'yes';
    expect(() => normalizePreferences(bad)).toThrow(/editorWordWrap must be a boolean/);
  });

  it('rejects a non-boolean seenBlobQuotaModal', () => {
    const bad = valid() as Record<string, unknown>;
    bad['seenBlobQuotaModal'] = 'nope';
    expect(() => normalizePreferences(bad)).toThrow(/seenBlobQuotaModal must be a boolean/);
  });

  it('round-trips seenBlobQuotaModal=true', () => {
    const input = valid() as Record<string, unknown>;
    input['seenBlobQuotaModal'] = true;
    expect(normalizePreferences(input).seenBlobQuotaModal).toBe(true);
  });

  it('rejects a non-boolean seenClipboardBanner', () => {
    const bad = valid() as Record<string, unknown>;
    bad['seenClipboardBanner'] = 'nope';
    expect(() => normalizePreferences(bad)).toThrow(
      /seenClipboardBanner must be a boolean/
    );
  });

  it('round-trips seenClipboardBanner=true', () => {
    const input = valid() as Record<string, unknown>;
    input['seenClipboardBanner'] = true;
    expect(normalizePreferences(input).seenClipboardBanner).toBe(true);
  });

  it('rejects a non-boolean treeEditorSelectionSync', () => {
    const bad = valid() as Record<string, unknown>;
    bad['treeEditorSelectionSync'] = 'yes';
    expect(() => normalizePreferences(bad)).toThrow(
      /treeEditorSelectionSync must be a boolean/
    );
  });

  it('round-trips treeEditorSelectionSync=false', () => {
    const input = valid() as Record<string, unknown>;
    input['treeEditorSelectionSync'] = false;
    expect(normalizePreferences(input).treeEditorSelectionSync).toBe(false);
  });

  it('round-trips treeEditorSelectionSync=true', () => {
    const input = valid() as Record<string, unknown>;
    input['treeEditorSelectionSync'] = true;
    expect(normalizePreferences(input).treeEditorSelectionSync).toBe(true);
  });

  it('rejects treeDateAnnotationUnits that is not an object', () => {
    const bad = valid() as Record<string, unknown>;
    bad['treeDateAnnotationUnits'] = 'all';
    expect(() => normalizePreferences(bad)).toThrow(
      /treeDateAnnotationUnits must be an object/
    );
  });

  it('rejects unknown treeDateAnnotationUnits fields', () => {
    const bad = valid() as Record<string, unknown>;
    bad['treeDateAnnotationUnits'] = {
      ...dateAnnotationUnits(true),
      week: true
    };
    expect(() => normalizePreferences(bad)).toThrow(
      /treeDateAnnotationUnits has unknown field "week"/
    );
  });

  it('rejects non-boolean treeDateAnnotationUnits values', () => {
    const bad = valid() as Record<string, unknown>;
    bad['treeDateAnnotationUnits'] = {
      ...dateAnnotationUnits(true),
      month: 'yes'
    };
    expect(() => normalizePreferences(bad)).toThrow(
      /treeDateAnnotationUnits.month must be a boolean/
    );
  });

  it('rejects missing treeDateAnnotationUnits values', () => {
    const bad = valid() as Record<string, unknown>;
    bad['treeDateAnnotationUnits'] = {
      year: true,
      month: true,
      day: true,
      hour: true,
      minute: true
    };
    expect(() => normalizePreferences(bad)).toThrow(
      /treeDateAnnotationUnits.second must be a boolean/
    );
  });

  it('rejects non-boolean treeDateAnnotationFriendlyForms', () => {
    const bad = valid() as Record<string, unknown>;
    bad['treeDateAnnotationFriendlyForms'] = 'yes';
    expect(() => normalizePreferences(bad)).toThrow(
      /treeDateAnnotationFriendlyForms must be a boolean/
    );
  });

  it('round-trips treeDateAnnotationFriendlyForms=false', () => {
    const input = valid() as Record<string, unknown>;
    input['treeDateAnnotationFriendlyForms'] = false;
    expect(normalizePreferences(input).treeDateAnnotationFriendlyForms).toBe(false);
  });

  it('accepts all treeDateAnnotationUnits enabled', () => {
    const input = valid() as Record<string, unknown>;
    const units = dateAnnotationUnits(true);
    input['treeDateAnnotationUnits'] = units;
    expect(normalizePreferences(input).treeDateAnnotationUnits).toEqual(units);
  });

  it('accepts all treeDateAnnotationUnits disabled', () => {
    const input = valid() as Record<string, unknown>;
    const units = dateAnnotationUnits(false);
    input['treeDateAnnotationUnits'] = units;
    expect(normalizePreferences(input).treeDateAnnotationUnits).toEqual(units);
  });

  it('accepts mixed treeDateAnnotationUnits values', () => {
    const input = valid() as Record<string, unknown>;
    const units = mixedDateAnnotationUnits();
    input['treeDateAnnotationUnits'] = units;
    expect(normalizePreferences(input).treeDateAnnotationUnits).toEqual(units);
  });

  it('accepts each valid treePathRoot value', () => {
    for (const mode of ['jsonpath', 'none', 'root', 'data'] as const) {
      const input = valid() as Record<string, unknown>;
      input['treePathRoot'] = mode;
      expect(normalizePreferences(input).treePathRoot).toBe(mode);
    }
  });

  it('rejects an unknown treePathRoot value', () => {
    const bad = valid() as Record<string, unknown>;
    bad['treePathRoot'] = 'jsonpath2';
    expect(() => normalizePreferences(bad)).toThrow(/treePathRoot must be one of/);
  });

  it('rejects a missing treePathRoot value', () => {
    const bad = valid() as Record<string, unknown>;
    delete bad['treePathRoot'];
    expect(() => normalizePreferences(bad)).toThrow(/treePathRoot must be one of/);
  });
  it('rejects bad hex colors', () => {
    const bad = valid() as Record<string, unknown>;
    (bad['treeHighlightColors'] as Record<string, unknown>)['dark'] = {
      selectionColor: 'red',
      matchingValueColor: '#fff',
      ancestorColor: '#000000',
      searchHighlightColor: '#123456'
    };
    expect(() => normalizePreferences(bad)).toThrow(/selectionColor/);
  });

  it('lower-cases hex colors', () => {
    const input = valid() as Record<string, unknown>;
    (input['treeHighlightColors'] as Record<string, Record<string, string>>)['dark'] = {
      selectionColor: '#AABBCC',
      matchingValueColor: '#DEADBE',
      ancestorColor: '#012345',
      searchHighlightColor: '#6A4C00'
    };
    const out = normalizePreferences(input);
    expect(out.treeHighlightColors.dark.selectionColor).toBe('#aabbcc');
  });

  it('rejects unknown color-set fields', () => {
    const bad = valid() as Record<string, unknown>;
    (bad['treeHighlightColors'] as Record<string, Record<string, unknown>>)['dark'] = {
      ...(bad['treeHighlightColors'] as Record<string, Record<string, unknown>>)['dark'],
      extraColor: '#ffffff'
    };
    expect(() => normalizePreferences(bad)).toThrow(/extraColor/);
  });

  it('rejects unknown theme buckets in treeHighlightColors', () => {
    const bad = valid() as Record<string, unknown>;
    (bad['treeHighlightColors'] as Record<string, unknown>)['sepia'] = (
      bad['treeHighlightColors'] as Record<string, unknown>
    )['dark'];
    expect(() => normalizePreferences(bad)).toThrow(/sepia/);
  });

  it('requires both dark and light color sets', () => {
    const bad = valid() as Record<string, unknown>;
    (bad['treeHighlightColors'] as Record<string, unknown>) = {
      dark: (bad['treeHighlightColors'] as Record<string, unknown>)['dark']
    };
    expect(() => normalizePreferences(bad)).toThrow();
  });

  it.each(['historyTrackingMode', 'defaultRuleSetIds', 'defaultRuleSetId'])(
    'rejects legacy preference key %s',
    (key) => {
      const bad = valid() as Record<string, unknown>;
      bad[key] = 'whatever';
      expect(() => normalizePreferences(bad)).toThrow(
        new RegExp(`Unknown preference key "${key}"`)
      );
    }
  );

  it('defaults activeRuleSetIds to [] when missing on the wire (stale-client tolerance)', () => {
    const input = valid() as Record<string, unknown>;
    delete input['activeRuleSetIds'];
    expect(normalizePreferences(input).activeRuleSetIds).toEqual([]);
  });

  it('preserves activeRuleSetIds when set', () => {
    const input = valid() as Record<string, unknown>;
    input['activeRuleSetIds'] = ['rs-1', 'rs-2'];
    expect(normalizePreferences(input).activeRuleSetIds).toEqual(['rs-1', 'rs-2']);
  });

  it('deduplicates activeRuleSetIds while preserving order', () => {
    const input = valid() as Record<string, unknown>;
    input['activeRuleSetIds'] = ['a', 'b', 'a', 'c', 'b'];
    expect(normalizePreferences(input).activeRuleSetIds).toEqual(['a', 'b', 'c']);
  });

  it('rejects activeRuleSetIds that is not an array', () => {
    const bad = valid() as Record<string, unknown>;
    bad['activeRuleSetIds'] = 'rs-1';
    expect(() => normalizePreferences(bad)).toThrow(/activeRuleSetIds must be an array/);
  });

  it('rejects activeRuleSetIds entries that are not non-empty strings', () => {
    const bad = valid() as Record<string, unknown>;
    bad['activeRuleSetIds'] = ['ok', ''];
    expect(() => normalizePreferences(bad)).toThrow(/non-empty strings/);
  });

  it('rejects activeRuleSetIds entries longer than 64 chars', () => {
    const bad = valid() as Record<string, unknown>;
    bad['activeRuleSetIds'] = ['x'.repeat(65)];
    expect(() => normalizePreferences(bad)).toThrow(/too long/);
  });

  it('rejects activeRuleSetIds with more than 32 entries', () => {
    const bad = valid() as Record<string, unknown>;
    bad['activeRuleSetIds'] = Array.from({ length: 33 }, (_, i) => `rs-${i}`);
    expect(() => normalizePreferences(bad)).toThrow(/too many entries/);
  });

  it('round-trips searchValueType=all (default)', () => {
    expect(normalizePreferences(valid()).searchValueType).toBe('all');
  });

  it('round-trips a non-default searchValueType', () => {
    const input = valid() as Record<string, unknown>;
    input['searchValueType'] = 'date';
    expect(normalizePreferences(input).searchValueType).toBe('date');
  });

  it('round-trips searchValueType=date/time (slash-bearing enum value)', () => {
    const input = valid() as Record<string, unknown>;
    input['searchValueType'] = 'date/time';
    expect(normalizePreferences(input).searchValueType).toBe('date/time');
  });

  it('rejects unknown searchValueType', () => {
    const bad = valid() as Record<string, unknown>;
    bad['searchValueType'] = 'undefined';
    expect(() => normalizePreferences(bad)).toThrow(/searchValueType must be one of/);
  });

  it('rejects a missing searchValueType', () => {
    const bad = valid() as Record<string, unknown>;
    delete bad['searchValueType'];
    expect(() => normalizePreferences(bad)).toThrow(/searchValueType/);
  });
});

describe('normalizeStoredPreferences', () => {
  function storedWithoutRecentlyViewed(): Record<string, unknown> {
    const base = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;
    delete base['recentlyViewedEnabled'];
    return base;
  }

  it('coerces legacy historyTrackingMode="save_only" to recentlyViewedEnabled=true', () => {
    const stored = storedWithoutRecentlyViewed();
    stored['historyTrackingMode'] = 'save_only';
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.recentlyViewedEnabled).toBe(true);
    expect((result as { historyTrackingMode?: unknown }).historyTrackingMode).toBeUndefined();
  });

  it('coerces legacy historyTrackingMode="all_actions" to recentlyViewedEnabled=true', () => {
    const stored = storedWithoutRecentlyViewed();
    stored['historyTrackingMode'] = 'all_actions';
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.recentlyViewedEnabled).toBe(true);
  });

  it('defaults malformed legacy historyTrackingMode strings to recentlyViewedEnabled=true', () => {
    const stored = storedWithoutRecentlyViewed();
    stored['historyTrackingMode'] = 'garbage';
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.recentlyViewedEnabled).toBe(true);
    expect((result as { historyTrackingMode?: unknown }).historyTrackingMode).toBeUndefined();
  });

  it('defaults missing legacy and non-boolean recentlyViewedEnabled (null) to true', () => {
    const stored = storedWithoutRecentlyViewed();
    stored['recentlyViewedEnabled'] = null;
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.recentlyViewedEnabled).toBe(true);
  });

  it('preserves an explicit recentlyViewedEnabled=true', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES);
    stored.recentlyViewedEnabled = true;
    const result = normalizeStoredPreferences(stored);
    expect(result.recentlyViewedEnabled).toBe(true);
  });

  it('preserves an explicit recentlyViewedEnabled=false', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES);
    stored.recentlyViewedEnabled = false;
    const result = normalizeStoredPreferences(stored);
    expect(result.recentlyViewedEnabled).toBe(false);
  });

  it('defaults missing treeEditorSelectionSync to true', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<
      string,
      unknown
    >;
    delete stored['treeEditorSelectionSync'];
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.treeEditorSelectionSync).toBe(true);
  });

  it('defaults non-boolean treeEditorSelectionSync (null) to true', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<
      string,
      unknown
    >;
    stored['treeEditorSelectionSync'] = null;
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.treeEditorSelectionSync).toBe(true);
  });

  it('preserves an explicit treeEditorSelectionSync=false', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES);
    stored.treeEditorSelectionSync = false;
    const result = normalizeStoredPreferences(stored);
    expect(result.treeEditorSelectionSync).toBe(false);
  });

  it('preserves an explicit treeEditorSelectionSync=true', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES);
    stored.treeEditorSelectionSync = true;
    const result = normalizeStoredPreferences(stored);
    expect(result.treeEditorSelectionSync).toBe(true);
  });

  it('defaults missing date annotation preferences', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<
      string,
      unknown
    >;
    delete stored['treeDateAnnotationUnits'];
    delete stored['treeDateAnnotationFriendlyForms'];
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.treeDateAnnotationUnits).toEqual(dateAnnotationUnits(true));
    expect(result.treeDateAnnotationFriendlyForms).toBe(true);
  });

  it('defaults malformed date annotation preferences', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<
      string,
      unknown
    >;
    stored['treeDateAnnotationUnits'] = 'all';
    stored['treeDateAnnotationFriendlyForms'] = 'yes';
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.treeDateAnnotationUnits).toEqual(dateAnnotationUnits(true));
    expect(result.treeDateAnnotationFriendlyForms).toBe(true);
  });

  it('backfills partial treeDateAnnotationUnits per key', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<
      string,
      unknown
    >;
    stored['treeDateAnnotationUnits'] = {
      year: false,
      month: 'no',
      day: false
    };
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.treeDateAnnotationUnits).toEqual({
      year: false,
      month: true,
      day: false,
      hour: true,
      minute: true,
      second: true
    });
  });

  it('preserves valid date annotation preferences', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES);
    const units = mixedDateAnnotationUnits();
    stored.treeDateAnnotationUnits = units;
    stored.treeDateAnnotationFriendlyForms = false;
    const result = normalizeStoredPreferences(stored);
    expect(result.treeDateAnnotationUnits).toEqual(units);
    expect(result.treeDateAnnotationFriendlyForms).toBe(false);
  });

  it('folds legacy defaultRuleSetIds (array) into activeRuleSetIds', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<
      string,
      unknown
    >;
    delete stored['activeRuleSetIds'];
    stored['defaultRuleSetIds'] = ['rs-1', 'rs-2'];
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.activeRuleSetIds).toEqual(['rs-1', 'rs-2']);
    expect((result as { defaultRuleSetIds?: unknown }).defaultRuleSetIds).toBeUndefined();
  });

  it('folds ancient defaultRuleSetId (singular) into activeRuleSetIds', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<
      string,
      unknown
    >;
    delete stored['activeRuleSetIds'];
    stored['defaultRuleSetId'] = 'rs-1';
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.activeRuleSetIds).toEqual(['rs-1']);
    expect((result as { defaultRuleSetId?: unknown }).defaultRuleSetId).toBeUndefined();
  });

  it('canonical activeRuleSetIds wins over legacy defaultRuleSetIds when both are present', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<
      string,
      unknown
    >;
    stored['activeRuleSetIds'] = ['canonical-1'];
    stored['defaultRuleSetIds'] = ['legacy-1', 'legacy-2'];
    stored['defaultRuleSetId'] = 'ancient-1';
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.activeRuleSetIds).toEqual(['canonical-1']);
    expect((result as { defaultRuleSetIds?: unknown }).defaultRuleSetIds).toBeUndefined();
    expect((result as { defaultRuleSetId?: unknown }).defaultRuleSetId).toBeUndefined();
  });

  it('strips legacy keys even when activeRuleSetIds is canonical', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<
      string,
      unknown
    >;
    stored['activeRuleSetIds'] = ['rs-1'];
    stored['defaultRuleSetIds'] = ['stale'];
    stored['defaultRuleSetId'] = 'stale-singular';
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.activeRuleSetIds).toEqual(['rs-1']);
    expect((result as { defaultRuleSetIds?: unknown }).defaultRuleSetIds).toBeUndefined();
    expect((result as { defaultRuleSetId?: unknown }).defaultRuleSetId).toBeUndefined();
  });

  it('combines both legacy shapes when canonical is missing (singular leads, then array)', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<
      string,
      unknown
    >;
    delete stored['activeRuleSetIds'];
    stored['defaultRuleSetIds'] = ['rs-2'];
    stored['defaultRuleSetId'] = 'rs-1';
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.activeRuleSetIds).toEqual(['rs-1', 'rs-2']);
  });

  it('does not duplicate when singular legacy id already appears in legacy array', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<
      string,
      unknown
    >;
    delete stored['activeRuleSetIds'];
    stored['defaultRuleSetIds'] = ['rs-1', 'rs-2'];
    stored['defaultRuleSetId'] = 'rs-1';
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.activeRuleSetIds).toEqual(['rs-1', 'rs-2']);
  });
});
