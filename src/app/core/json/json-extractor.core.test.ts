import type { ParseError } from 'jsonc-parser';
import { parse } from 'jsonc-parser';
import type { ExtractedJson, IndentSize, ParseJsonCandidate } from './json-extractor.core';
import { extractFromMixedText } from './json-extractor.core';

const parseJsonCandidate: ParseJsonCandidate = (candidateText: string) => {
  const errors: ParseError[] = [];
  const value: unknown = parse(candidateText, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  return { value, errors };
};

describe('extractFromMixedText core', () => {
  it('returns the bare value for one block without prose', () => {
    const extracted = extractRequired('{"a":1}');

    expect(extracted.blockCount).toBe(1);
    expect(extracted.preservesComments).toBe(true);
    expect(extracted.proseSegments).toBe(0);
    expect(parseJsoncText(extracted.text)).toEqual({ a: 1 });
  });

  it('returns the bare array for multiple blocks without prose', () => {
    const extracted = extractRequired('{"a":1}{"b":2}');

    expect(extracted.blockCount).toBe(2);
    expect(extracted.preservesComments).toBe(false);
    expect(extracted.proseSegments).toBe(0);
    expect(parseJsoncText(extracted.text)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('wraps prefix-only prose with prefix and json keys', () => {
    const extracted = extractRequired('before {"a":1}');
    const wrapper = expectJsoncRecord(extracted.text);

    expect(Object.keys(wrapper)).toEqual(['prefix', 'json']);
    expect(wrapper['prefix']).toBe('before ');
    expect(wrapper['json']).toEqual({ a: 1 });
    expect(extracted.proseSegments).toBe(1);
    expect(extracted.preservesComments).toBe(true);
  });

  it('wraps suffix-only prose with json and suffix keys', () => {
    const extracted = extractRequired('{"a":1} after');
    const wrapper = expectJsoncRecord(extracted.text);

    expect(Object.keys(wrapper)).toEqual(['json', 'suffix']);
    expect(wrapper['json']).toEqual({ a: 1 });
    expect(wrapper['suffix']).toBe(' after');
    expect(extracted.proseSegments).toBe(1);
  });

  it('wraps prefix and suffix prose around one block', () => {
    const extracted = extractRequired('before {"a":1} after');
    const wrapper = expectJsoncRecord(extracted.text);

    expect(Object.keys(wrapper)).toEqual(['prefix', 'json', 'suffix']);
    expect(wrapper['prefix']).toBe('before ');
    expect(wrapper['json']).toEqual({ a: 1 });
    expect(wrapper['suffix']).toBe(' after');
    expect(extracted.proseSegments).toBe(2);
  });

  it('omits whitespace-only prose and returns the bare value', () => {
    const extracted = extractRequired('   {"a":1}\n');

    expect(extracted.proseSegments).toBe(0);
    expect(parseJsoncText(extracted.text)).toEqual({ a: 1 });
  });

  it('preserves a leading BOM in the prefix when prose is present', () => {
    const extracted = extractRequired('\uFEFFhello {"a":1}');
    const wrapper = expectJsoncRecord(extracted.text);

    expect(extracted.text).toContain('\\uFEFF');
    expect(wrapper['prefix']).toBe('\uFEFFhello ');
    expect(wrapper['json']).toEqual({ a: 1 });
    expect(extracted.proseSegments).toBe(1);
  });

  it('treats a bare BOM prefix as whitespace and returns the bare value', () => {
    const extracted = extractRequired('\uFEFF{"a":1}');

    expect(extracted.proseSegments).toBe(0);
    expect(parseJsoncText(extracted.text)).toEqual({ a: 1 });
  });

  it('preserves comments inside one prose-wrapped JSON block', () => {
    const extracted = extractRequired('hi { /* json comment */ "a":1 // line comment\n}');
    const wrapper = expectJsoncRecord(extracted.text);

    expect(extracted.preservesComments).toBe(true);
    expect(extracted.hasComments).toBe(true);
    expect(extracted.text).toContain('/* json comment */');
    expect(extracted.text).toContain('// line comment');
    expect(wrapper['json']).toEqual({ a: 1 });
  });

  it('keeps trailing-comma JSONC parseable inside one prose wrapper', () => {
    const extracted = extractRequired('hi {"a":1,}');
    const wrapper = expectJsoncRecord(extracted.text);

    expect(wrapper['json']).toEqual({ a: 1 });
    expect(extracted.preservesComments).toBe(true);
  });

  it('omits whitespace-only prose between multiple blocks', () => {
    const extracted = extractRequired('{"a":1}\n  {"b":2}');

    expect(extracted.proseSegments).toBe(0);
    expect(parseJsoncText(extracted.text)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('wraps between-only prose for two blocks', () => {
    const extracted = extractRequired('{"a":1} sep {"b":2}');
    const wrapper = expectJsoncRecord(extracted.text);

    expect(Object.keys(wrapper)).toEqual(['json1', 'between_1_and_2', 'json2']);
    expect(wrapper['json1']).toEqual({ a: 1 });
    expect(wrapper['between_1_and_2']).toBe(' sep ');
    expect(wrapper['json2']).toEqual({ b: 2 });
    expect(extracted.preservesComments).toBe(false);
    expect(extracted.proseSegments).toBe(1);
  });

  it('wraps prefix, between, and suffix prose for two blocks', () => {
    const extracted = extractRequired('pre {"a":1} mid {"b":2} post');
    const wrapper = expectJsoncRecord(extracted.text);

    expect(Object.keys(wrapper)).toEqual(['prefix', 'json1', 'between_1_and_2', 'json2', 'suffix']);
    expect(wrapper['prefix']).toBe('pre ');
    expect(wrapper['json1']).toEqual({ a: 1 });
    expect(wrapper['between_1_and_2']).toBe(' mid ');
    expect(wrapper['json2']).toEqual({ b: 2 });
    expect(wrapper['suffix']).toBe(' post');
    expect(extracted.proseSegments).toBe(3);
  });

  it('escapes quotes, backslashes, and newlines in prose segments', () => {
    const extracted = extractRequired('a"b\\c\n {"x":1}');
    const wrapper = expectJsoncRecord(extracted.text);

    expect(extracted.text).toContain('a\\"b\\\\c\\n ');
    expect(wrapper['prefix']).toBe('a"b\\c\n ');
    expect(wrapper['json']).toEqual({ x: 1 });
  });

  it('escapes line and paragraph separators while preserving their parsed values', () => {
    const extracted = extractRequired('line\u2028paragraph\u2029 {"x":1}');
    const wrapper = expectJsoncRecord(extracted.text);

    expect(extracted.text).toContain('\\u2028');
    expect(extracted.text).toContain('\\u2029');
    expect(wrapper['prefix']).toBe('line\u2028paragraph\u2029 ');
  });

  it('emits valid JSONC for prose wrappers', () => {
    const extracted = extractRequired('pre {"a":1} post');
    const wrapper = expectJsoncRecord(extracted.text);

    expect(wrapper).toEqual({ prefix: 'pre ', json: { a: 1 }, suffix: ' post' });
  });

  it('uses one-indexed json and between keys for three blocks', () => {
    const extracted = extractRequired('pre {"a":1} first {"b":2} second {"c":3} post');
    const wrapper = expectJsoncRecord(extracted.text);

    expect(Object.keys(wrapper)).toEqual([
      'prefix',
      'json1',
      'between_1_and_2',
      'json2',
      'between_2_and_3',
      'json3',
      'suffix',
    ]);
    expect(wrapper['prefix']).toBe('pre ');
    expect(wrapper['json1']).toEqual({ a: 1 });
    expect(wrapper['between_1_and_2']).toBe(' first ');
    expect(wrapper['json2']).toEqual({ b: 2 });
    expect(wrapper['between_2_and_3']).toBe(' second ');
    expect(wrapper['json3']).toEqual({ c: 3 });
    expect(wrapper['suffix']).toBe(' post');
    expect(extracted.proseSegments).toBe(4);
  });

  // Issue #253: `editorTabSize` is honored across all four output shapes.
  describe('honors tabSize parameter', () => {
    it('formats a bare single block at tabSize 4', () => {
      const extracted = extractRequired('{"a":1,"b":{"c":2}}', 4);
      expect(extracted.proseSegments).toBe(0);
      expect(extracted.blockCount).toBe(1);
      // 4-space indent on the nested key.
      expect(extracted.text).toContain('\n    "a"');
      expect(extracted.text).toContain('\n    "b"');
      // No 2-space-only indentation should leak through.
      expect(extracted.text).not.toMatch(/\n  "[ab]"/);
    });

    it('formats a bare multi-block array at tabSize 4', () => {
      const extracted = extractRequired('{"a":1}{"b":2}', 4);
      expect(extracted.proseSegments).toBe(0);
      expect(extracted.blockCount).toBe(2);
      expect(parseJsoncText(extracted.text)).toEqual([{ a: 1 }, { b: 2 }]);
      // JSON.stringify with indent 4 -> 4-space indent on array elements.
      expect(extracted.text).toContain('\n    {');
    });

    it('formats a single-block prose wrapper at tabSize 4', () => {
      const extracted = extractRequired('before {"a":1} after', 4);
      const wrapper = expectJsoncRecord(extracted.text);

      expect(wrapper['prefix']).toBe('before ');
      expect(wrapper['json']).toEqual({ a: 1 });
      expect(wrapper['suffix']).toBe(' after');
      // 4-space indent on top-level wrapper keys.
      expect(extracted.text).toContain('\n    "prefix"');
      expect(extracted.text).toContain('\n    "json"');
    });

    it('formats a multi-block prose wrapper at tabSize 4', () => {
      const extracted = extractRequired('pre {"a":1} mid {"b":2} post', 4);
      const wrapper = expectJsoncRecord(extracted.text);

      expect(wrapper['prefix']).toBe('pre ');
      expect(wrapper['json1']).toEqual({ a: 1 });
      expect(wrapper['between_1_and_2']).toBe(' mid ');
      expect(wrapper['json2']).toEqual({ b: 2 });
      expect(wrapper['suffix']).toBe(' post');
      // 4-space indent on top-level wrapper keys.
      expect(extracted.text).toContain('\n    "prefix"');
      expect(extracted.text).toContain('\n    "json1"');
    });

    it('defaults to 2-space indent when extractRequired is called without tabSize', () => {
      const extracted = extractRequired('{"a":1,"b":2}');
      // 2-space indent on top-level keys.
      expect(extracted.text).toContain('\n  "a"');
      // No 4-space indent should appear.
      expect(extracted.text).not.toContain('\n    "a"');
    });
  });
});

function extractRequired(input: string, tabSize: IndentSize = 2): ExtractedJson {
  const extracted = extractFromMixedText(input, parseJsonCandidate, tabSize);
  if (extracted === null) {
    throw new Error(`Expected extraction for ${input}`);
  }
  return extracted;
}

function parseJsoncText(text: string): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  expect(errors).toEqual([]);
  return value;
}

function expectJsoncRecord(text: string): Record<string, unknown> {
  const value = parseJsoncText(text);
  if (!isRecord(value)) {
    throw new Error('Expected JSONC text to parse to an object');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
