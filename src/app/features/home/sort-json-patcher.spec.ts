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

  it('preserves inter-property comments inside the targeted object', () => {
    const text = '{\n  "b": 2,\n  /* stays */\n  "a": 1\n}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{\n  /* stays */\n  "a": 1,\n  "b": 2\n}');
    expect(result.patched).toContain('/* stays */');
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

  it('preserves a multi-line block comment between properties', () => {
    const text = '{\n  "b": 2, /* multi\nline */\n  "a": 1\n}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{\n  "a": 1,\n  "b": 2 /* multi\nline */\n}');
    expect(result.patched).toContain('/* multi\nline */');
  });

  it('preserves a value-trailing block comment before the comma without double-comma', () => {
    const text = '{\n  "b": 2 /* before */,\n  "a": 1\n}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{\n  "a": 1,\n  "b": 2 /* before */\n}');
    expect(result.patched).not.toContain(',,');
  });

  it('preserves a same-line trailing block comment about the source-last property', () => {
    const text = '{"b":2,"a":1 /* about a */}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{"a":1, /* about a */"b":2}');
    expect(result.patched).toContain('/* about a */');
  });

  it('preserves a same-line leading block comment about the source-first property', () => {
    const text = '{ /* about b */ "b":1,"a":2}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{"a":2, /* about b */ "b":1}');
    expect(result.patched).toContain('/* about b */');
  });

  it('preserves comments through blank-line separated properties (blank line may drift)', () => {
    // Documented limitation #8: the blank line between properties is
    // attributed to the second property and travels with it under sort.
    // The contract this test locks is: every comment / non-whitespace
    // byte survives; visual blank-line position may shift.
    const text = '{\n  "b": 2,\n\n  "a": 1\n}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{\n\n  "a": 1,\n  "b": 2\n}');
  });

  it('produces a stable result under repeated sort', () => {
    const text = `{  // A?\n  "b": 2,  // B?\n  "a": 1\n}`;

    const once = patchSortKeysAtPath(text, []).patched;
    const twice = patchSortKeysAtPath(once, []).patched;

    expect(twice).toBe(once);
  });

  it('preserves all comments in the user 9-comment example via row-level sort on root', () => {
    const text =
      '{  // what about A?\n' +
      '  "b": /* this comment stays */ 2,  // what about B?\n' +
      '  "a": [ // what about C?\n' +
      '    1,  // what about D?\n' +
      '    // this stays too\n' +
      '    2 // what about E?\n' +
      '  ]  // what about F?\n' +
      '}  // what about G?';
    const expected =
      '{  // what about A?\n' +
      '  "a": [ // what about C?\n' +
      '    1,  // what about D?\n' +
      '    // this stays too\n' +
      '    2 // what about E?\n' +
      '  ],  // what about F?\n' +
      '  "b": /* this comment stays */ 2  // what about B?\n' +
      '}  // what about G?';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe(expected);
  });

  it('does not reorder nested object keys when row-level sorting', () => {
    const text = '{"outer":{"b":2,"a":1},"z":0}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{"outer":{"b":2,"a":1},"z":0}');
  });

  it('keeps duplicate keys stable in source order while sorting around them', () => {
    const text = '{"b":2,"a":1,"b":3}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{"a":1,"b":2,"b":3}');
  });

  it('preserves trailing whitespace-only indent before } on sort', () => {
    const text = '{\n  "b":2,\n  "a":1\n  }';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{\n  "a":1,\n  "b":2\n  }');
  });

  it('preserves a floating comment after the last property without trailing comma', () => {
    const text = '{\n  "b":2,\n  "a":1\n  // tail comment\n}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{\n  "a":1,\n  "b":2\n  // tail comment\n}');
    expect(result.patched).toContain('// tail comment');
  });

  it('treats CR inside a block comment as comment content, not a structural newline', () => {
    const text = '{ "b": 1, /* foo\r*/\n"a": 2 }';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toContain('/* foo\r*/');
    expect(result.patched).toContain('"a": 2');
    expect(result.patched).toContain('"b": 1');
    // structural sort succeeded -- a now sorts before b
    expect(result.patched.indexOf('"a"')).toBeLessThan(result.patched.indexOf('"b"'));
  });

  it('terminates // comments on bare CR to match jsonc-parser', () => {
    const text = '{\n  "b": 1, // skip\r  "a": 2\n}';

    const result = patchSortKeysAtPath(text, []);

    // The `// skip` line comment ends at the bare CR (jsonc-parser
    // accepts the same terminator set), so the gap between "b" and
    // "a" has a structural comma and the sort succeeds.
    expect(result.patched).toContain('// skip');
    expect(result.patched).toContain('"a": 2');
    expect(result.patched).toContain('"b": 1');
    expect(result.patched.indexOf('"a"')).toBeLessThan(result.patched.indexOf('"b"'));
  });

  it('locks the trailing-comma + same-line line comment migration behavior', () => {
    // Documented limitation #6: a `// tail` after the source-last
    // property's trailing comma migrates between properties when its
    // owning property is no longer sorted-last. All comments survive;
    // visual position shifts.
    const text = '{\n  "b":2,\n  "a":1, // tail\n}';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toBe('{\n  "a":1, // tail\n  "b":2,\n}');
    expect(result.patched).toContain('// tail');
  });

  it('treats bare CR as inter-property newline (classic Mac line endings)', () => {
    const text = '{ "b":2,\r  "a":1 }';

    const result = patchSortKeysAtPath(text, []);

    expect(result.patched).toContain('"a":1');
    expect(result.patched).toContain('"b":2');
    expect(result.patched.indexOf('"a"')).toBeLessThan(result.patched.indexOf('"b"'));
  });

  it('preserves source order under a comparator that returns 0 for distinct keys', () => {
    // Array.sort is stable (ES2019+), so a comparator that always
    // returns 0 leaves the source order intact.
    const text = '{"b":2,"a":1,"c":3}';

    const result = patchSortKeysAtPath(text, [], () => 0);

    expect(result.patched).toBe('{"b":2,"a":1,"c":3}');
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

  it('preserves all 9 comments in the user nested example via deep sort', () => {
    const text =
      '{  // what about A?\n' +
      '  "b": /* this comment stays */ 2,  // what about B?\n' +
      '  "a": [ // what about C?\n' +
      '    1,  // what about D?\n' +
      '    // this stays too\n' +
      '    2 // what about E?\n' +
      '  ]  // what about F?\n' +
      '}  // what about G?';
    const expected =
      '{  // what about A?\n' +
      '  "a": [ // what about C?\n' +
      '    1,  // what about D?\n' +
      '    // this stays too\n' +
      '    2 // what about E?\n' +
      '  ],  // what about F?\n' +
      '  "b": /* this comment stays */ 2  // what about B?\n' +
      '}  // what about G?';

    const result = patchSortKeysDeep(text);

    expect(result.patched).toBe(expected);
    expect(result.changed).toBe(true);
  });

  it('sorts nested objects even when the root is single-key', () => {
    const text = '{"only":{"y":2,"x":1}}';

    const result = patchSortKeysDeep(text);

    expect(result.patched).toBe('{"only":{"x":1,"y":2}}');
    expect(result.changed).toBe(true);
  });

  it('preserves comments inside an empty object body during deep sort', () => {
    const text = '{"outer":{ /* only */ },"a":1}';

    const result = patchSortKeysDeep(text);

    expect(result.patched).toBe('{"a":1,"outer":{ /* only */ }}');
    expect(result.patched).toContain('/* only */');
  });

  it('preserves inter-property comments inside an array of multi-key objects', () => {
    const text = '[{"b":2 /* x */,"a":1}]';

    const result = patchSortKeysDeep(text);

    expect(result.patched).toBe('[{"a":1,"b":2 /* x */}]');
    expect(result.patched).toContain('/* x */');
  });
});
