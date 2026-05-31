import type { ExtractedJson } from '../../core/json/json-extractor.service';
import { patchExtractedValue } from './extract-json-patcher';

function replacement(text: string): ExtractedJson {
  return {
    text,
    blockCount: 1,
    preservesComments: true,
    proseSegments: 0,
    hasComments: text.includes('//') || text.includes('/*'),
  };
}

describe('patchExtractedValue', () => {
  it('splices a single-line replacement while preserving surrounding text', () => {
    const text = '{\n  "payload": "INFO {\\"a\\":1}",\n  "keep": true\n}';

    const result = patchExtractedValue(text, ['payload'], replacement('{"a":1}'));

    expect(result.patched).toBe('{\n  "payload": {"a":1},\n  "keep": true\n}');
    expect(result.targetOffset).toBe(text.indexOf('"INFO'));
    expect(result.targetLength).toBe('"INFO {\\"a\\":1}"'.length);
    expect(result.replacementText).toBe('{"a":1}');
    expect(
      result.patched.substring(
        result.targetOffset,
        result.targetOffset + result.replacementText.length,
      ),
    ).toBe(result.replacementText);
  });

  it('reindents a multi-line replacement to the target column', () => {
    const text = '{\n  "payload": "INFO {\\"a\\":1}",\n  "keep": true\n}';
    const replacementText = '{\n  "a": 1,\n  "b": true\n}';
    const expectedReplacementText =
      '{\n               "a": 1,\n               "b": true\n             }';

    const result = patchExtractedValue(text, ['payload'], replacement(replacementText));

    expect(result.patched).toBe(
      '{\n  "payload": {\n               "a": 1,\n               "b": true\n             },\n  "keep": true\n}',
    );
    expect(result.replacementText).toBe(expectedReplacementText);
    expect(
      result.patched.substring(
        result.targetOffset,
        result.targetOffset + result.replacementText.length,
      ),
    ).toBe(result.replacementText);
  });

  it('reindents a multi-line wrapper replacement in a nested object', () => {
    const text = '{\n  "foo": {\n    "bar": "prefix {\\"a\\":1} suffix"\n  }\n}';
    const replacementText =
      '{\n  "prefix": "prefix ",\n  "json": {\n    "a": 1\n  },\n  "suffix": " suffix"\n}';
    const valueIndent = ' '.repeat(11);
    const propertyIndent = `${valueIndent}  `;
    const nestedPropertyIndent = `${valueIndent}    `;

    const result = patchExtractedValue(text, ['foo', 'bar'], replacement(replacementText));

    expect(result.patched).toBe(
      '{\n' +
        '  "foo": {\n' +
        '    "bar": {\n' +
        `${propertyIndent}"prefix": "prefix ",\n` +
        `${propertyIndent}"json": {\n` +
        `${nestedPropertyIndent}"a": 1\n` +
        `${propertyIndent}},\n` +
        `${propertyIndent}"suffix": " suffix"\n` +
        `${valueIndent}}\n` +
        '  }\n' +
        '}',
    );
  });

  it('preserves comments outside the replaced target', () => {
    const text =
      '{\n  // leading outside\n  "payload": "INFO {\\"a\\":1}", // trailing outside\n  "keep": true\n}';

    const result = patchExtractedValue(text, ['payload'], replacement('{"a":1}'));

    expect(result.patched).toContain('// leading outside');
    expect(result.patched).toContain('"payload": {"a":1}, // trailing outside');
    expect(result.patched).toContain('"keep": true');
  });

  it('preserves comments inside the extracted replacement text', () => {
    const text = '{\n  "payload": "INFO {\\"a\\":1}"\n}';
    const replacementText = '{\n  // inside extracted payload\n  "a": 1\n}';

    const result = patchExtractedValue(text, ['payload'], replacement(replacementText));

    expect(result.patched).toContain('// inside extracted payload');
    expect(result.patched).toContain('"a": 1');
  });

  it('replaces the root value at an empty path', () => {
    const text = '"INFO {\\"a\\":1}"';

    const result = patchExtractedValue(text, [], replacement('{\n  "a": 1\n}'));

    expect(result.patched).toBe('{\n  "a": 1\n}');
    expect(result.targetOffset).toBe(0);
    expect(result.targetLength).toBe(text.length);
  });

  it('returns the root replacement text as the exact patched slice', () => {
    const text = '"INFO {\\"a\\":1}"';
    const replacementText = '{\n  "a": 1\n}';

    const result = patchExtractedValue(text, [], replacement(replacementText));

    expect(
      result.patched.substring(
        result.targetOffset,
        result.targetOffset + result.replacementText.length,
      ),
    ).toBe(result.replacementText);
  });

  it('replaces a deep value in an array', () => {
    const text = '{\n  "foo": [\n    { "bar": "INFO {\\"nested\\":true}" }\n  ]\n}';

    const result = patchExtractedValue(text, ['foo', 0, 'bar'], replacement('{"nested":true}'));

    expect(result.patched).toBe('{\n  "foo": [\n    { "bar": {"nested":true} }\n  ]\n}');
  });

  it('throws when the path is not found', () => {
    expect(() =>
      patchExtractedValue('{"payload":"INFO {\\"a\\":1}"}', ['missing'], replacement('{"a":1}')),
    ).toThrowError('extract.patch.path-not-found');
  });

  it('throws when the source text cannot be parsed', () => {
    expect(() =>
      patchExtractedValue('{"payload": ', ['payload'], replacement('{"a":1}')),
    ).toThrowError('extract.patch.parse-failed');
  });
});
