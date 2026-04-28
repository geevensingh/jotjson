import { DEFAULT_PREFERENCES, normalizePreferences, PreferenceValidationError } from './preferences';

function valid(): unknown {
  return structuredClone(DEFAULT_PREFERENCES);
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

  it('migrates legacy defaultRuleSetId into defaultRuleSetIds', () => {
    const input = valid() as Record<string, unknown>;
    delete input['defaultRuleSetIds'];
    input['defaultRuleSetId'] = 'rs-123';
    const out = normalizePreferences(input);
    expect(out.defaultRuleSetIds).toEqual(['rs-123']);
    expect((out as unknown as Record<string, unknown>)['defaultRuleSetId']).toBeUndefined();
  });

  it('drops empty-string legacy defaultRuleSetId', () => {
    const input = valid() as Record<string, unknown>;
    delete input['defaultRuleSetIds'];
    input['defaultRuleSetId'] = '';
    const out = normalizePreferences(input);
    expect(out.defaultRuleSetIds).toEqual([]);
  });

  it('rejects non-string legacy defaultRuleSetId', () => {
    const bad = valid() as Record<string, unknown>;
    bad['defaultRuleSetId'] = 123;
    expect(() => normalizePreferences(bad)).toThrow(/defaultRuleSetId/);
  });

  it('migrates legacy activeRuleSetIds into defaultRuleSetIds', () => {
    const input = valid() as Record<string, unknown>;
    delete input['defaultRuleSetIds'];
    input['activeRuleSetIds'] = ['rs-1', 'rs-2'];
    const out = normalizePreferences(input);
    expect(out.defaultRuleSetIds).toEqual(['rs-1', 'rs-2']);
    expect((out as unknown as Record<string, unknown>)['activeRuleSetIds']).toBeUndefined();
  });

  it('combines legacy defaultRuleSetId and activeRuleSetIds, single first, dedup-safe', () => {
    const input = valid() as Record<string, unknown>;
    delete input['defaultRuleSetIds'];
    input['defaultRuleSetId'] = 'rs-x';
    input['activeRuleSetIds'] = ['rs-a', 'rs-x', 'rs-b'];
    const out = normalizePreferences(input);
    expect(out.defaultRuleSetIds).toEqual(['rs-x', 'rs-a', 'rs-b']);
  });

  it('prefers new defaultRuleSetIds over legacy activeRuleSetIds when both present', () => {
    const input = valid() as Record<string, unknown>;
    input['defaultRuleSetIds'] = ['new-1'];
    input['activeRuleSetIds'] = ['legacy-1'];
    const out = normalizePreferences(input);
    expect(out.defaultRuleSetIds).toEqual(['new-1']);
  });

  it('defaults defaultRuleSetIds to [] when missing on the wire (stale-client tolerance)', () => {
    const input = valid() as Record<string, unknown>;
    delete input['defaultRuleSetIds'];
    expect(normalizePreferences(input).defaultRuleSetIds).toEqual([]);
  });

  it('preserves defaultRuleSetIds when set', () => {
    const input = valid() as Record<string, unknown>;
    input['defaultRuleSetIds'] = ['rs-1', 'rs-2'];
    expect(normalizePreferences(input).defaultRuleSetIds).toEqual(['rs-1', 'rs-2']);
  });

  it('deduplicates defaultRuleSetIds while preserving order', () => {
    const input = valid() as Record<string, unknown>;
    input['defaultRuleSetIds'] = ['a', 'b', 'a', 'c', 'b'];
    expect(normalizePreferences(input).defaultRuleSetIds).toEqual(['a', 'b', 'c']);
  });

  it('rejects defaultRuleSetIds that is not an array', () => {
    const bad = valid() as Record<string, unknown>;
    bad['defaultRuleSetIds'] = 'rs-1';
    expect(() => normalizePreferences(bad)).toThrow(/defaultRuleSetIds must be an array/);
  });

  it('rejects defaultRuleSetIds entries that are not non-empty strings', () => {
    const bad = valid() as Record<string, unknown>;
    bad['defaultRuleSetIds'] = ['ok', ''];
    expect(() => normalizePreferences(bad)).toThrow(/non-empty strings/);
  });

  it('rejects defaultRuleSetIds entries longer than 64 chars', () => {
    const bad = valid() as Record<string, unknown>;
    bad['defaultRuleSetIds'] = ['x'.repeat(65)];
    expect(() => normalizePreferences(bad)).toThrow(/too long/);
  });

  it('rejects defaultRuleSetIds with more than 32 entries', () => {
    const bad = valid() as Record<string, unknown>;
    bad['defaultRuleSetIds'] = Array.from({ length: 33 }, (_, i) => `rs-${i}`);
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
