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

  it('preserves optional defaultRuleSetId when set', () => {
    const input = valid() as Record<string, unknown>;
    input['defaultRuleSetId'] = 'rs-123';
    const out = normalizePreferences(input);
    expect(out.defaultRuleSetId).toBe('rs-123');
  });

  it('drops empty-string defaultRuleSetId', () => {
    const input = valid() as Record<string, unknown>;
    input['defaultRuleSetId'] = '';
    const out = normalizePreferences(input);
    expect(out.defaultRuleSetId).toBeUndefined();
  });

  it('rejects non-string defaultRuleSetId', () => {
    const bad = valid() as Record<string, unknown>;
    bad['defaultRuleSetId'] = 123;
    expect(() => normalizePreferences(bad)).toThrow(/defaultRuleSetId/);
  });
});
