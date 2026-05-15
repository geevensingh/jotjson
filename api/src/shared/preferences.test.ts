import {
  DEFAULT_PREFERENCES,
  normalizePreferences,
  normalizeStoredPreferences,
  PreferenceValidationError,
  UserPreferences,
} from './preferences';

function valid(): unknown {
  return structuredClone(DEFAULT_PREFERENCES);
}

function dateAnnotationUnits(enabled: boolean): UserPreferences['treeDateAnnotationUnits'] {
  return {
    year: enabled,
    month: enabled,
    day: enabled,
    hour: enabled,
    minute: enabled,
    second: enabled,
  };
}

function mixedDateAnnotationUnits(): UserPreferences['treeDateAnnotationUnits'] {
  return {
    year: true,
    month: false,
    day: true,
    hour: false,
    minute: true,
    second: false,
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
    expect(() => normalizePreferences(bad)).toThrow(/seenClipboardBanner must be a boolean/);
  });

  it('round-trips seenClipboardBanner=true', () => {
    const input = valid() as Record<string, unknown>;
    input['seenClipboardBanner'] = true;
    expect(normalizePreferences(input).seenClipboardBanner).toBe(true);
  });

  it('rejects a non-boolean treeEditorSelectionSync', () => {
    const bad = valid() as Record<string, unknown>;
    bad['treeEditorSelectionSync'] = 'yes';
    expect(() => normalizePreferences(bad)).toThrow(/treeEditorSelectionSync must be a boolean/);
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
    expect(() => normalizePreferences(bad)).toThrow(/treeDateAnnotationUnits must be an object/);
  });

  it('rejects unknown treeDateAnnotationUnits fields', () => {
    const bad = valid() as Record<string, unknown>;
    bad['treeDateAnnotationUnits'] = {
      ...dateAnnotationUnits(true),
      week: true,
    };
    expect(() => normalizePreferences(bad)).toThrow(
      /treeDateAnnotationUnits has unknown field "week"/,
    );
  });

  it('rejects non-boolean treeDateAnnotationUnits values', () => {
    const bad = valid() as Record<string, unknown>;
    bad['treeDateAnnotationUnits'] = {
      ...dateAnnotationUnits(true),
      month: 'yes',
    };
    expect(() => normalizePreferences(bad)).toThrow(
      /treeDateAnnotationUnits.month must be a boolean/,
    );
  });

  it('rejects missing treeDateAnnotationUnits values', () => {
    const bad = valid() as Record<string, unknown>;
    bad['treeDateAnnotationUnits'] = {
      year: true,
      month: true,
      day: true,
      hour: true,
      minute: true,
    };
    expect(() => normalizePreferences(bad)).toThrow(
      /treeDateAnnotationUnits.second must be a boolean/,
    );
  });

  it('rejects non-boolean treeDateAnnotationFriendlyForms', () => {
    const bad = valid() as Record<string, unknown>;
    bad['treeDateAnnotationFriendlyForms'] = 'yes';
    expect(() => normalizePreferences(bad)).toThrow(
      /treeDateAnnotationFriendlyForms must be a boolean/,
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

  it('accepts each valid coldBootClipboardAutoPaste value', () => {
    for (const mode of ['ask', 'always', 'never'] as const) {
      const input = valid() as Record<string, unknown>;
      input['coldBootClipboardAutoPaste'] = mode;
      expect(normalizePreferences(input).coldBootClipboardAutoPaste).toBe(mode);
    }
  });

  it('rejects an unknown coldBootClipboardAutoPaste value', () => {
    const bad = valid() as Record<string, unknown>;
    bad['coldBootClipboardAutoPaste'] = 'sometimes';
    expect(() => normalizePreferences(bad)).toThrow(/coldBootClipboardAutoPaste must be one of/);
  });

  it('defaults missing coldBootClipboardAutoPaste to ask', () => {
    const input = valid() as Record<string, unknown>;
    delete input['coldBootClipboardAutoPaste'];
    expect(normalizePreferences(input).coldBootClipboardAutoPaste).toBe('ask');
  });

  it('rejects a non-boolean treeAutoFitToWindow', () => {
    const bad = valid() as Record<string, unknown>;
    bad['treeAutoFitToWindow'] = 'yes';
    expect(() => normalizePreferences(bad)).toThrow(/treeAutoFitToWindow must be a boolean/);
  });

  it('round-trips treeAutoFitToWindow=true', () => {
    const input = valid() as Record<string, unknown>;
    input['treeAutoFitToWindow'] = true;
    expect(normalizePreferences(input).treeAutoFitToWindow).toBe(true);
  });

  it('round-trips treeAutoFitToWindow=false', () => {
    const input = valid() as Record<string, unknown>;
    input['treeAutoFitToWindow'] = false;
    expect(normalizePreferences(input).treeAutoFitToWindow).toBe(false);
  });

  it('defaults missing treeAutoFitToWindow to true', () => {
    const input = valid() as Record<string, unknown>;
    delete input['treeAutoFitToWindow'];
    expect(normalizePreferences(input).treeAutoFitToWindow).toBe(true);
  });

  it('rejects bad hex colors', () => {
    const bad = valid() as Record<string, unknown>;
    (bad['treeHighlightColors'] as Record<string, unknown>)['dark'] = {
      selectionColor: 'red',
      matchingValueColor: '#fff',
      ancestorColor: '#000000',
      searchHighlightColor: '#123456',
      manualHighlightColor: '#fff59d',
    };
    expect(() => normalizePreferences(bad)).toThrow(/selectionColor/);
  });

  it('lower-cases hex colors', () => {
    const input = valid() as Record<string, unknown>;
    (input['treeHighlightColors'] as Record<string, Record<string, string>>)['dark'] = {
      selectionColor: '#AABBCC',
      matchingValueColor: '#DEADBE',
      ancestorColor: '#012345',
      searchHighlightColor: '#6A4C00',
      manualHighlightColor: '#7E6500',
    };
    const out = normalizePreferences(input);
    expect(out.treeHighlightColors.dark.selectionColor).toBe('#aabbcc');
    expect(out.treeHighlightColors.dark.manualHighlightColor).toBe('#7e6500');
  });

  it('defaults missing manualHighlightColor to theme defaults for stale clients', () => {
    const input = valid() as Record<string, unknown>;
    const colors = input['treeHighlightColors'] as Record<string, Record<string, unknown>>;
    delete colors['dark']['manualHighlightColor'];
    delete colors['light']['manualHighlightColor'];
    const out = normalizePreferences(input);
    expect(out.treeHighlightColors.dark.manualHighlightColor).toBe(
      DEFAULT_PREFERENCES.treeHighlightColors.dark.manualHighlightColor,
    );
    expect(out.treeHighlightColors.light.manualHighlightColor).toBe(
      DEFAULT_PREFERENCES.treeHighlightColors.light.manualHighlightColor,
    );
  });

  it('rejects malformed manualHighlightColor', () => {
    const bad = valid() as Record<string, unknown>;
    const colors = bad['treeHighlightColors'] as Record<string, Record<string, unknown>>;
    colors['dark']['manualHighlightColor'] = '#fff';
    expect(() => normalizePreferences(bad)).toThrow(/manualHighlightColor/);
  });

  it('rejects unknown color-set fields', () => {
    const bad = valid() as Record<string, unknown>;
    (bad['treeHighlightColors'] as Record<string, Record<string, unknown>>)['dark'] = {
      ...(bad['treeHighlightColors'] as Record<string, Record<string, unknown>>)['dark'],
      extraColor: '#ffffff',
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
      dark: (bad['treeHighlightColors'] as Record<string, unknown>)['dark'],
    };
    expect(() => normalizePreferences(bad)).toThrow();
  });

  it.each(['historyTrackingMode', 'defaultRuleSetIds', 'defaultRuleSetId', 'searchRegexMode'])(
    'rejects legacy preference key %s',
    (key) => {
      const bad = valid() as Record<string, unknown>;
      bad[key] = 'whatever';
      expect(() => normalizePreferences(bad)).toThrow(
        new RegExp(`Unknown preference key "${key}"`),
      );
    },
  );

  it('round-trips searchMatchMode=contains (default)', () => {
    expect(normalizePreferences(valid()).searchMatchMode).toBe('contains');
  });

  it('round-trips a non-default searchMatchMode', () => {
    const input = valid() as Record<string, unknown>;
    input['searchMatchMode'] = 'starts_with';
    expect(normalizePreferences(input).searchMatchMode).toBe('starts_with');
  });

  it('round-trips searchMatchMode=regex', () => {
    const input = valid() as Record<string, unknown>;
    input['searchMatchMode'] = 'regex';
    expect(normalizePreferences(input).searchMatchMode).toBe('regex');
  });

  it('rejects unknown searchMatchMode', () => {
    const bad = valid() as Record<string, unknown>;
    bad['searchMatchMode'] = 'bogus';
    expect(() => normalizePreferences(bad)).toThrow(/searchMatchMode must be one of/);
  });

  it('rejects a missing searchMatchMode', () => {
    const bad = valid() as Record<string, unknown>;
    delete bad['searchMatchMode'];
    expect(() => normalizePreferences(bad)).toThrow(/searchMatchMode/);
  });

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

  it('strips legacy historyTrackingMode and defaults missing recentlyViewedEnabled to true', () => {
    // Stale-shape stored docs may carry the pre-narrowing
    // historyTrackingMode key. We strip it for wire hygiene; the
    // missing recentlyViewedEnabled defaults to the new-feature
    // default of true via the existing missing-field fallback.
    const stored = storedWithoutRecentlyViewed();
    stored['historyTrackingMode'] = 'save_only';
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

  describe('searchRegexMode -> searchMatchMode fold', () => {
    // Schema-evolution rename. Six precedence cases pinned to match
    // the frontend `mergeWithDefaults` fold (preferences.service.ts).
    function storedWithoutSearchMatchMode(): Record<string, unknown> {
      const base = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;
      delete base['searchMatchMode'];
      return base;
    }

    it('legacy searchRegexMode=true alone -> regex', () => {
      const stored = storedWithoutSearchMatchMode();
      stored['searchRegexMode'] = true;
      const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
      expect(result.searchMatchMode).toBe('regex');
      expect((result as { searchRegexMode?: unknown }).searchRegexMode).toBeUndefined();
    });

    it('legacy searchRegexMode=false alone -> contains', () => {
      const stored = storedWithoutSearchMatchMode();
      stored['searchRegexMode'] = false;
      const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
      expect(result.searchMatchMode).toBe('contains');
      expect((result as { searchRegexMode?: unknown }).searchRegexMode).toBeUndefined();
    });

    it('legacy absent -> default contains', () => {
      const stored = storedWithoutSearchMatchMode();
      const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
      expect(result.searchMatchMode).toBe('contains');
    });

    it('new field valid + legacy present -> new wins, legacy stripped', () => {
      const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;
      stored['searchMatchMode'] = 'starts_with';
      stored['searchRegexMode'] = true;
      const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
      expect(result.searchMatchMode).toBe('starts_with');
      expect((result as { searchRegexMode?: unknown }).searchRegexMode).toBeUndefined();
    });

    it('new field invalid + legacy true -> fold to regex', () => {
      const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;
      stored['searchMatchMode'] = 'bogus';
      stored['searchRegexMode'] = true;
      const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
      expect(result.searchMatchMode).toBe('regex');
      expect((result as { searchRegexMode?: unknown }).searchRegexMode).toBeUndefined();
    });

    it('legacy non-boolean (string "true") -> strict bool check -> contains', () => {
      const stored = storedWithoutSearchMatchMode();
      stored['searchRegexMode'] = 'true';
      const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
      expect(result.searchMatchMode).toBe('contains');
      expect((result as { searchRegexMode?: unknown }).searchRegexMode).toBeUndefined();
    });

    it('defensively defaults an invalid stored searchMatchMode to contains', () => {
      const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;
      stored['searchMatchMode'] = 'bogus';
      const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
      expect(result.searchMatchMode).toBe('contains');
    });
  });

  it('defaults missing treeEditorSelectionSync to true', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;
    delete stored['treeEditorSelectionSync'];
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.treeEditorSelectionSync).toBe(true);
  });

  it('defaults non-boolean treeEditorSelectionSync (null) to true', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;
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
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;
    delete stored['treeDateAnnotationUnits'];
    delete stored['treeDateAnnotationFriendlyForms'];
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.treeDateAnnotationUnits).toEqual(dateAnnotationUnits(true));
    expect(result.treeDateAnnotationFriendlyForms).toBe(true);
  });

  it('defaults missing treeShowComments to true', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;
    delete stored['treeShowComments'];
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.treeShowComments).toBe(true);
  });

  it('defaults missing stored manualHighlightColor for both themes', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;
    const colors = stored['treeHighlightColors'] as Record<string, Record<string, unknown>>;
    delete colors['dark']['manualHighlightColor'];
    delete colors['light']['manualHighlightColor'];
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.treeHighlightColors.dark.manualHighlightColor).toBe(
      DEFAULT_PREFERENCES.treeHighlightColors.dark.manualHighlightColor,
    );
    expect(result.treeHighlightColors.light.manualHighlightColor).toBe(
      DEFAULT_PREFERENCES.treeHighlightColors.light.manualHighlightColor,
    );
  });

  it('defaults non-boolean treeShowComments (null) to true', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;
    stored['treeShowComments'] = null;
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.treeShowComments).toBe(true);
  });

  it('preserves an explicit treeShowComments=false', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES);
    stored.treeShowComments = false;
    const result = normalizeStoredPreferences(stored);
    expect(result.treeShowComments).toBe(false);
  });

  it('defaults missing coldBootClipboardAutoPaste to ask', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;
    delete stored['coldBootClipboardAutoPaste'];
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.coldBootClipboardAutoPaste).toBe('ask');
  });

  it('defaults invalid coldBootClipboardAutoPaste value to ask', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;
    stored['coldBootClipboardAutoPaste'] = 'sometimes';
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.coldBootClipboardAutoPaste).toBe('ask');
  });

  it('preserves an explicit coldBootClipboardAutoPaste=always', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES);
    stored.coldBootClipboardAutoPaste = 'always';
    const result = normalizeStoredPreferences(stored);
    expect(result.coldBootClipboardAutoPaste).toBe('always');
  });

  it('preserves an explicit coldBootClipboardAutoPaste=never', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES);
    stored.coldBootClipboardAutoPaste = 'never';
    const result = normalizeStoredPreferences(stored);
    expect(result.coldBootClipboardAutoPaste).toBe('never');
  });

  it('defaults malformed date annotation preferences', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;
    stored['treeDateAnnotationUnits'] = 'all';
    stored['treeDateAnnotationFriendlyForms'] = 'yes';
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.treeDateAnnotationUnits).toEqual(dateAnnotationUnits(true));
    expect(result.treeDateAnnotationFriendlyForms).toBe(true);
  });

  it('backfills partial treeDateAnnotationUnits per key', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;
    stored['treeDateAnnotationUnits'] = {
      year: false,
      month: 'no',
      day: false,
    };
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.treeDateAnnotationUnits).toEqual({
      year: false,
      month: true,
      day: false,
      hour: true,
      minute: true,
      second: true,
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

  it('strips legacy keys when activeRuleSetIds is canonical', () => {
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;
    stored['activeRuleSetIds'] = ['rs-1'];
    stored['defaultRuleSetIds'] = ['stale'];
    stored['defaultRuleSetId'] = 'stale-singular';
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.activeRuleSetIds).toEqual(['rs-1']);
    expect((result as { defaultRuleSetIds?: unknown }).defaultRuleSetIds).toBeUndefined();
    expect((result as { defaultRuleSetId?: unknown }).defaultRuleSetId).toBeUndefined();
  });

  it('defaults activeRuleSetIds to [] and strips legacy keys when canonical is missing', () => {
    // Stale-shape stored docs that pre-date issue #83 may carry the
    // legacy `defaultRuleSetIds` (M6f-5 name) or `defaultRuleSetId`
    // (pre-M6f-5 singular) keys without the canonical
    // `activeRuleSetIds`. We default to [] (the user re-selects on
    // next visit) and strip the legacy keys for wire hygiene rather
    // than synthesizing the canonical key from them. See
    // DESIGN_SPEC.md -> Versioning -> Schema evolution.
    const stored = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;
    delete stored['activeRuleSetIds'];
    stored['defaultRuleSetIds'] = ['rs-1', 'rs-2'];
    stored['defaultRuleSetId'] = 'rs-3';
    const result = normalizeStoredPreferences(stored as unknown as UserPreferences);
    expect(result.activeRuleSetIds).toEqual([]);
    expect((result as { defaultRuleSetIds?: unknown }).defaultRuleSetIds).toBeUndefined();
    expect((result as { defaultRuleSetId?: unknown }).defaultRuleSetId).toBeUndefined();
  });
});
