import { formatText } from './format-text';

describe('formatText (pure)', () => {
  it('returns empty input unchanged', () => {
    expect(formatText('', 2)).toBe('');
  });

  it('returns already-formatted input unchanged', () => {
    const text = '{\n  "a": 1\n}';
    expect(formatText(text, 2)).toBe(text);
  });

  it('pretty-prints compact input', () => {
    expect(formatText('{"a":1}', 2)).toBe('{\n  "a": 1\n}');
  });

  it('preserves JSONC line comments when formatting', () => {
    const output = formatText('{ // x\n"a":1}', 2);

    expect(output).toContain('// x');
    expect(output).toBe('{ // x\n  "a": 1\n}');
  });

  it('respects the tab size parameter', () => {
    const text = '{"a":{"b":1}}';

    expect(formatText(text, 2)).toBe('{\n  "a": {\n    "b": 1\n  }\n}');
    expect(formatText(text, 4)).toBe('{\n    "a": {\n        "b": 1\n    }\n}');
  });
});
