import { patchSortKeysAtPath, patchSortKeysDeep } from './sort-json-patcher';

describe('patchSortKeysAtPath', () => {
  it('sorts a compact object', () => {
    const text = '{"b":2,"a":1}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{"a":1,"b":2}');
    expect(result.targetOffset).toBe(0);
    expect(result.targetLength).toBe(text.length);
    expect(result.replacementText).toBe('{"a":1,"b":2}');
    expect(
      result.patched.substring(
        result.targetOffset,
        result.targetOffset + result.replacementText.length,
      ),
    ).toBe(result.replacementText);
  });

  it('sorts a pretty object preserving 2-space indentation', () => {
    const text = '{\n  "b": 2,\n  "a": 1\n}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  it('sorts a pretty object preserving 4-space indentation', () => {
    const text = '{\n    "b": 2,\n    "a": 1\n}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{\n    "a": 1,\n    "b": 2\n}');
  });

  it('preserves number precision while sorting', () => {
    const text = '{"z":0,"big":9007199254740993,"a":1}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{"a":1,"big":9007199254740993,"z":0}');
    expect(result.patched).toContain('9007199254740993');
    expect(result.patched).not.toContain('9007199254740992');
  });

  it('preserves string escape forms', () => {
    const text = '{"z":0,"k":"\\u0041","a":1}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{"a":1,"k":"\\u0041","z":0}');
    expect(result.patched).toContain('"k":"\\u0041"');
    expect(result.patched).not.toContain('"k":"A"');
  });

  it('preserves a trailing comma', () => {
    const text = '{"b":2,"a":1,}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{"a":1,"b":2,}');
  });

  it('preserves comments inside a property value', () => {
    const text = '{\n  "b": /* keep */ 2,\n  "a": 1\n}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{\n  "a": 1,\n  "b": /* keep */ 2\n}');
    expect(result.patched).toContain('/* keep */');
  });

  it('drops inter-property comments inside the targeted object', () => {
    const text = '{\n  "b": 2,\n  /* gone */\n  "a": 1\n}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{\n  "a": 1,\n  "b": 2\n}');
    expect(result.patched).not.toContain('/* gone */');
  });

  it('leaves nested object key order unchanged', () => {
    const text = '{"b":{"y":1,"x":2},"a":1}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{"a":1,"b":{"y":1,"x":2}}');
  });

  it('orders keys by UTF-16 code unit', () => {
    const text = '{"a":1,"A":2,"z":3,"Z":4}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{"A":2,"Z":4,"a":1,"z":3}');
  });

  it('supports a custom comparator override', () => {
    const text = '{"a":1,"b":2,"c":3}';

    const result = patchSortKeysAtPath(text, [], (left, right) =>
      left < right ? 1 : left > right ? -1 : 0,
    );

    expect(result.patched).toBe('{"c":3,"b":2,"a":1}');
  });

  it('sorts only the nested object at the requested path', () => {
    const text = '{"outer":{"b":2,"a":1},"z":0}';

    const result = patchSortKeysAtPath(text, ['outer']);

    expect(result.patched).toBe('{"outer":{"a":1,"b":2},"z":0}');
    expect(result.targetOffset).toBe(text.indexOf('{', text.indexOf('"outer"')));
    expect(result.replacementText).toBe('{"a":1,"b":2}');
  });

  it('throws when the source text cannot be parsed', () => {
    expect(() => patchSortKeysAtPath('{"a":}', [])).toThrowError('sort.patch.parse-failed');
  });

  it('throws when the path does not resolve', () => {
    expect(() => patchSortKeysAtPath('{"a":1}', ['missing'])).toThrowError(
      'sort.patch.path-not-found',
    );
  });

  it('throws when the resolved path is not an object', () => {
    expect(() => patchSortKeysAtPath('{"value":[1,2]}', ['value'])).toThrowError(
      'sort.patch.not-object',
    );
    expect(() => patchSortKeysAtPath('{"value":1}', ['value'])).toThrowError(
      'sort.patch.not-object',
    );
  });

  it('throws for empty and single-property objects', () => {
    expect(() => patchSortKeysAtPath('{}', [])).toThrowError('sort.patch.empty-or-single');
    expect(() => patchSortKeysAtPath('{"only":1}', [])).toThrowError('sort.patch.empty-or-single');
  });

  it('preserves a leading BOM while sorting', () => {
    const text = '\uFEFF{"b":1,"a":2}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('\uFEFF{"a":2,"b":1}');
    expect(result.targetOffset).toBe(1);
    expect(result.replacementText).toBe('{"a":2,"b":1}');
  });

  it('preserves CRLF newlines across a 3-key object', () => {
    const text = '{\r\n  "c": 3,\r\n  "b": 2,\r\n  "a": 1\r\n}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{\r\n  "a": 1,\r\n  "b": 2,\r\n  "c": 3\r\n}');
    expect(result.patched).not.toMatch(/[^\r]\n/);
    expect((result.patched.match(/\r\n/g) ?? []).length).toBe((text.match(/\r\n/g) ?? []).length);
  });

  it('preserves CRLF newlines with a leading BOM', () => {
    const text = '\uFEFF{\r\n  "b": 2,\r\n  "a": 1\r\n}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('\uFEFF{\r\n  "a": 1,\r\n  "b": 2\r\n}');
    expect(result.patched).not.toMatch(/[^\r]\n/);
  });

  it('preserves CRLF newlines with tab indentation', () => {
    const text = '{\r\n\t"b": 2,\r\n\t"a": 1\r\n}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{\r\n\t"a": 1,\r\n\t"b": 2\r\n}');
    expect(result.patched).not.toMatch(/[^\r]\n/);
  });
});

describe('patchSortKeysDeep', () => {
  it('preserves number precision while sorting at the root', () => {
    const text = '{"b":9007199254740993,"a":1}';

    const result = patchSortKeysDeep(text);

    expect(result.changed).toBe(true);
    expect(result.patched).toBe('{"a":1,"b":9007199254740993}');
    expect(result.patched).toContain('9007199254740993');
    expect(result.patched).not.toContain('9007199254740992');
  });

  it('preserves escape forms while sorting at the root', () => {
    const text = '{"b":"\\u0041","a":1}';

    const result = patchSortKeysDeep(text);

    expect(result.patched).toBe('{"a":1,"b":"\\u0041"}');
    expect(result.patched).toContain('"\\u0041"');
    expect(result.patched).not.toContain('"b":"A"');
  });

  it('preserves a trailing comma while sorting at the root', () => {
    const text = '{"b":1,"a":2,}';

    const result = patchSortKeysDeep(text);

    expect(result.patched).toBe('{"a":2,"b":1,}');
  });

  it('preserves a leading-document comment', () => {
    const text = '// header\n{"b":1,"a":2}';

    const result = patchSortKeysDeep(text);

    expect(result.patched).toBe('// header\n{"a":2,"b":1}');
    expect(result.patched).toContain('// header');
  });

  it('preserves a value-internal block comment while sorting', () => {
    const text = '{\n  "b": /* keep */ 2,\n  "a": 1\n}';

    const result = patchSortKeysDeep(text);

    expect(result.patched).toBe('{\n  "a": 1,\n  "b": /* keep */ 2\n}');
    expect(result.patched).toContain('/* keep */');
  });

  it('recurses into nested objects', () => {
    const text = '{"outer":{"y":2,"x":1},"a":1}';

    const result = patchSortKeysDeep(text);

    expect(result.patched).toBe('{"a":1,"outer":{"x":1,"y":2}}');
  });

  it('handles an array root containing an object', () => {
    const text = '[{"b":2,"a":1}]';

    const result = patchSortKeysDeep(text);

    expect(result.patched).toBe('[{"a":1,"b":2}]');
    expect(result.changed).toBe(true);
  });

  it('is a no-op for a scalar root', () => {
    const text = '42';

    const result = patchSortKeysDeep(text);

    expect(result.patched).toBe('42');
    expect(result.changed).toBe(false);
  });

  it('is a no-op for a single-key root object', () => {
    const text = '{"a":1}';

    const result = patchSortKeysDeep(text);

    expect(result.patched).toBe('{"a":1}');
    expect(result.changed).toBe(false);
  });

  it('throws when the source text cannot be parsed', () => {
    expect(() => patchSortKeysDeep('{"a":}')).toThrowError('sort.patch.parse-failed');
  });

  it('sorts sibling objects independently', () => {
    const text = '{"b":{"y":1,"x":2},"a":{"d":3,"c":4}}';

    const result = patchSortKeysDeep(text);

    expect(result.patched).toBe('{"a":{"c":4,"d":3},"b":{"x":2,"y":1}}');
  });

  it('sorts objects nested inside arrays', () => {
    const text = '[{"b":2,"a":1},{"d":4,"c":3}]';

    const result = patchSortKeysDeep(text);

    expect(result.patched).toBe('[{"a":1,"b":2},{"c":3,"d":4}]');
  });

  it('preserves CRLF newlines while recursing', () => {
    const text = '{\r\n  "outer": {\r\n    "y": 2,\r\n    "x": 1\r\n  },\r\n  "a": 1\r\n}';

    const result = patchSortKeysDeep(text);

    expect(result.patched).toBe(
      '{\r\n  "a": 1,\r\n  "outer": {\r\n    "x": 1,\r\n    "y": 2\r\n  }\r\n}',
    );
    expect(result.patched).not.toMatch(/[^\r]\n/);
  });

  it('preserves a leading BOM while recursing', () => {
    const text = '\uFEFF{"b":{"y":2,"x":1},"a":1}';

    const result = patchSortKeysDeep(text);

    expect(result.patched).toBe('\uFEFF{"a":1,"b":{"x":1,"y":2}}');
  });

  it('preserves compact whitespace style (Sort does not re-pretty-print compact input)', () => {
    const text = '{"b":2,"a":1}';

    const result = patchSortKeysDeep(text);

    expect(result.patched).toBe('{"a":1,"b":2}');
    expect(result.patched).not.toContain('\n');
  });

  it('throws parse-failed for a comment-only document with no JSON value', () => {
    expect(() => patchSortKeysDeep('// just a comment\n')).toThrowError('sort.patch.parse-failed');
  });

  it('supports a custom comparator override', () => {
    const text = '{"b":2,"a":1}';

    const result = patchSortKeysDeep(text, (left, right) =>
      left < right ? 1 : left > right ? -1 : 0,
    );

    expect(result.patched).toBe('{"b":2,"a":1}');
    expect(result.changed).toBe(false);
  });
});
