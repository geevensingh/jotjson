import { TestBed } from '@angular/core/testing';
import { type Mocked } from 'vitest';
import { bucketBytes } from '../telemetry/buckets';
import { __resetColdFlagsForTesting } from '../telemetry/cold-flag';
import { LoggerService } from '../telemetry/logger.service';
import { JsonParserService } from './json-parser.service';

describe('JsonParserService', () => {
  let svc: JsonParserService;
  let loggerSpy: Mocked<LoggerService>;

  beforeEach(() => {
    __resetColdFlagsForTesting();
    loggerSpy = { event: vi.fn() } as Mocked<LoggerService>;
    TestBed.configureTestingModule({
      providers: [{ provide: LoggerService, useValue: loggerSpy }],
    });
    svc = TestBed.inject(JsonParserService);
  });

  afterEach(() => {
    __resetColdFlagsForTesting();
  });

  describe('parse - empty inputs', () => {
    it('treats empty string as empty', () => {
      const r = svc.parse('');
      expect(r.empty).toBe(true);
      expect(r.value).toBeUndefined();
      expect(r.errors).toEqual([]);
    });

    it('treats whitespace-only as empty', () => {
      const r = svc.parse('   \n\t  ');
      expect(r.empty).toBe(true);
      expect(r.value).toBeUndefined();
    });
  });

  describe('parse - strict JSON', () => {
    it('parses primitives at root', () => {
      expect(svc.parse('42').value).toBe(42);
      expect(svc.parse('"hi"').value).toBe('hi');
      expect(svc.parse('true').value).toBe(true);
      expect(svc.parse('null').value).toBeNull();
    });

    it('parses arrays and nested objects', () => {
      const r = svc.parse('{"a":[1,2,{"b":true}]}');
      expect(r.value).toEqual({ a: [1, 2, { b: true }] });
      expect(r.errors).toEqual([]);
    });
  });

  describe('parse - slow telemetry', () => {
    it('does not emit parse.slow for a fast parse', () => {
      vi.spyOn(performance, 'now').and.returnValues(0, 1);

      svc.parse('{"a":1}');

      expect(loggerSpy.event).not.toHaveBeenCalled();
    });

    it('emits parse.slow with cold=true on the first slow parse', () => {
      vi.spyOn(performance, 'now').and.returnValues(0, 51);
      const text = '{"a":1}';
      const sizeBytes = new Blob([text]).size;

      svc.parse(text);

      expect(loggerSpy.event).toHaveBeenCalledTimes(1);
      const [messageId, props, measurements] = loggerSpy.event.mock.lastCall;
      expect(messageId).toBe('parse.slow');
      expect(props).toEqual({
        cold: true,
        sizeBytesBucket: bucketBytes(sizeBytes),
      });
      expect(measurements).toBeDefined();
      if (!measurements) {
        expect.fail('Expected parse.slow measurements');
        return;
      }
      expect(measurements['timeMs']).toBeGreaterThan(50);
      expect(measurements['sizeBytes']).toBe(sizeBytes);
    });

    it('emits parse.slow with cold=false on the second slow parse', () => {
      vi.spyOn(performance, 'now').and.returnValues(0, 51, 100, 151);
      const text = '{"a":1}';
      const sizeBytes = new Blob([text]).size;

      svc.parse(text);
      svc.parse(text);

      expect(loggerSpy.event).toHaveBeenCalledTimes(2);
      const [messageId, props, measurements] = loggerSpy.event.mock.calls[1];
      expect(messageId).toBe('parse.slow');
      expect(props).toEqual({
        cold: false,
        sizeBytesBucket: bucketBytes(sizeBytes),
      });
      expect(measurements).toBeDefined();
      if (!measurements) {
        expect.fail('Expected parse.slow measurements');
        return;
      }
      expect(measurements['timeMs']).toBeGreaterThan(50);
      expect(measurements['sizeBytes']).toBe(sizeBytes);
    });

    it('does not emit parse.slow when elapsed time is exactly 50ms', () => {
      vi.spyOn(performance, 'now').and.returnValues(0, 50);

      svc.parse('{"a":1}');

      expect(loggerSpy.event).not.toHaveBeenCalled();
    });

    it('reports UTF-8 byte length instead of UTF-16 character count', () => {
      vi.spyOn(performance, 'now').and.returnValues(0, 51);
      const chineseText = String.fromCharCode(0x4e2d, 0x6587);
      const text = '{"name":"' + chineseText + '"}';
      const sizeBytes = new Blob([text]).size;

      svc.parse(text);

      expect(sizeBytes).toBeGreaterThan(text.length);
      expect(loggerSpy.event).toHaveBeenCalledTimes(1);
      const [, props, measurements] = loggerSpy.event.mock.lastCall;
      expect(props).toEqual({
        cold: true,
        sizeBytesBucket: bucketBytes(sizeBytes),
      });
      expect(measurements).toBeDefined();
      if (!measurements) {
        expect.fail('Expected parse.slow measurements');
        return;
      }
      expect(measurements['sizeBytes']).toBe(sizeBytes);
      expect(measurements['sizeBytes']).not.toBe(text.length);
    });
  });

  describe('parse - JSONC tolerance', () => {
    it('accepts // line comments', () => {
      const r = svc.parse('// top\n{"a":1}');
      expect(r.value).toEqual({ a: 1 });
      expect(r.errors).toEqual([]);
    });

    it('accepts /* block */ comments', () => {
      const r = svc.parse('/* hi */ {"a":1 /* inline */}');
      expect(r.value).toEqual({ a: 1 });
      expect(r.errors).toEqual([]);
    });

    it('accepts trailing commas', () => {
      const r = svc.parse('{"a":1,}');
      expect(r.value).toEqual({ a: 1 });
      expect(r.errors).toEqual([]);
    });
  });

  describe('parse - commentsByPath', () => {
    it('returns an empty map when input has no comments (fast path)', () => {
      const r = svc.parse('{"a":1,"b":[2,3]}');
      expect(r.commentsByPath.size).toBe(0);
    });

    it('returns an empty map for empty input', () => {
      const r = svc.parse('');
      expect(r.commentsByPath.size).toBe(0);
    });

    it('never emits empty comment arrays when input has no comments', () => {
      const r = svc.parse('{}');
      expect(r.commentsByPath.get('$')).toBeUndefined();
      expect(r.commentsByPath.size).toBe(0);
    });

    it('attaches a same-line trailing line comment to the value path', () => {
      const r = svc.parse('{\n  "x": 1 // primary\n}');
      expect(r.commentsByPath.get('$.x')).toEqual({ trailing: ['primary'] });
    });

    it('attaches a same-line trailing block comment to the value path', () => {
      const r = svc.parse('{"x": 1 /* primary */}');
      expect(r.commentsByPath.get('$.x')).toEqual({ trailing: ['primary'] });
    });

    it('attaches a leading comment to the next value', () => {
      const r = svc.parse('{\n  // legal name\n  "name": "Alice"\n}');
      expect(r.commentsByPath.get('$.name')).toEqual({ leading: ['legal name'] });
    });

    it('handles a top-of-document leading comment on the root', () => {
      const r = svc.parse('// header\n{"x": 1}');
      expect(r.commentsByPath.get('$')).toEqual({ leading: ['header'] });
    });

    it('emits a length-2 leading array for stacked root comments', () => {
      const r = svc.parse('// h1\n// h2\n{}');
      expect(r.commentsByPath.get('$')?.leading).toEqual(['h1', 'h2']);
      expect(r.commentsByPath.get('$')?.leading?.length).toBe(2);
    });

    it('renders a same-line trailing comment after the close as a container close-trailing', () => {
      const r = svc.parse('{\n  "foo": {\n    "x": 1\n  } // end of foo\n}');
      expect(r.commentsByPath.get('$.foo')).toEqual({ closeTrailing: ['end of foo'] });
      expect(r.commentsByPath.get('$.foo.x')).toBeUndefined();
    });

    it('attributes a comment-only container to the close row as closeLeading (rule 4)', () => {
      const r = svc.parse('{\n  "tags": [\n    // populated at runtime\n  ]\n}');
      expect(r.commentsByPath.get('$.tags')).toEqual({
        closeLeading: ['populated at runtime'],
      });
    });

    it('preserves source order in nested arrays and uses canonical paths', () => {
      const r = svc.parse('{\n  "foo": [\n    1, // first\n    2  /* second */\n  ]\n}');
      expect(r.commentsByPath.get('$.foo[0]')).toEqual({ trailing: ['first'] });
      expect(r.commentsByPath.get('$.foo[1]')).toEqual({ trailing: ['second'] });
    });

    it('attaches a comment between two properties to the next property as leading', () => {
      const r = svc.parse('{\n  "a": 1,\n  // pre-b\n  "b": 2\n}');
      expect(r.commentsByPath.get('$.b')).toEqual({ leading: ['pre-b'] });
      expect(r.commentsByPath.get('$.a')).toBeUndefined();
    });

    it('stacks multiple leading comments as separate array elements', () => {
      const r = svc.parse('{\n  // line 1\n  // line 2\n  "x": 1\n}');
      expect(r.commentsByPath.get('$.x')).toEqual({
        leading: ['line 1', 'line 2'],
      });
    });

    it('emits a length-2 leading array for stacked leading comments', () => {
      const r = svc.parse('{\n  // first\n  // second\n  "x": 1\n}');
      expect(r.commentsByPath.get('$.x')?.leading).toEqual(['first', 'second']);
      expect(r.commentsByPath.get('$.x')?.leading?.length).toBe(2);
    });

    it('emits a length-3 leading array for stacked leading comments', () => {
      const r = svc.parse('{\n  // first\n  // second\n  // third\n  "x": 1\n}');
      expect(r.commentsByPath.get('$.x')?.leading).toEqual(['first', 'second', 'third']);
      expect(r.commentsByPath.get('$.x')?.leading?.length).toBe(3);
    });

    it('emits a length-1 leading array for a multi-line block comment', () => {
      const r = svc.parse('{\n  /* line 1\n     line 2 */\n  "x": 1\n}');
      expect(r.commentsByPath.get('$.x')?.leading).toEqual(['line 1\n     line 2']);
      expect(r.commentsByPath.get('$.x')?.leading?.length).toBe(1);
    });

    it('preserves multi-line block comment body and attaches by start line', () => {
      const r = svc.parse('{"x": 1 /* multi\n  line */}');
      const bundle = r.commentsByPath.get('$.x');
      expect(bundle?.trailing).toEqual(['multi\n  line']);
    });

    it('skips empty comments (// alone and /**/ alone)', () => {
      const r = svc.parse('{\n  //\n  "x": 1, /**/\n  "y": 2\n}');
      expect(r.commentsByPath.size).toBe(0);
    });

    it('attaches both a leading and a trailing comment to the same value', () => {
      const r = svc.parse('{\n  // before x\n  "x": 1 // after x\n}');
      expect(r.commentsByPath.get('$.x')).toEqual({
        leading: ['before x'],
        trailing: ['after x'],
      });
    });

    it('emits length-2 leading and trailing arrays on the same value', () => {
      const r = svc.parse(
        '{\n  // before x 1\n  // before x 2\n  "x": 1 /* after x 1 */ /* after x 2 */\n}',
      );
      expect(r.commentsByPath.get('$.x')).toEqual({
        leading: ['before x 1', 'before x 2'],
        trailing: ['after x 1', 'after x 2'],
      });
      expect(r.commentsByPath.get('$.x')?.leading?.length).toBe(2);
      expect(r.commentsByPath.get('$.x')?.trailing?.length).toBe(2);
    });

    it('emits a length-2 trailing array for stacked trailing comments', () => {
      const r = svc.parse('{"x": 1 /* after x 1 */ /* after x 2 */}');
      expect(r.commentsByPath.get('$.x')?.trailing).toEqual(['after x 1', 'after x 2']);
      expect(r.commentsByPath.get('$.x')?.trailing?.length).toBe(2);
    });

    it('attaches a comment after the root close to the root path as close-trailing', () => {
      const r = svc.parse('{"x":1} // tail');
      expect(r.commentsByPath.get('$')).toEqual({ closeTrailing: ['tail'] });
    });

    it('uses canonical paths for keys that need bracket quoting', () => {
      const r = svc.parse('{"a.b": 1 // dotted\n}');
      expect(r.commentsByPath.get('$["a.b"]')).toEqual({ trailing: ['dotted'] });
    });

    it('does not invoke the harvest pass when text has no comment delimiters', () => {
      // Sanity guard for the fast-path bail. A string-literal that
      // looks like a path (no // or /*) must not trigger the harvest.
      const r = svc.parse('{"path":"a/b/c"}');
      expect(r.commentsByPath.size).toBe(0);
    });

    it('attaches a comment on the same line as a container open brace as the container trailing', () => {
      const r = svc.parse('{\n  "foo": { // about foo\n    "x": 1\n  }\n}');
      expect(r.commentsByPath.get('$.foo')).toEqual({ trailing: ['about foo'] });
      expect(r.commentsByPath.get('$.foo.x')).toBeUndefined();
    });

    it('attaches a block comment on the open-brace line with whitespace tail as container trailing', () => {
      const r = svc.parse('{\n  "foo": [ /* about foo */\n    1\n  ]\n}');
      expect(r.commentsByPath.get('$.foo')).toEqual({ trailing: ['about foo'] });
    });

    it('treats a one-line block comment followed by content on the same line as leading on the next value', () => {
      // The tail after `*/` is `  "bar": 1 }`, NOT whitespace -- so this
      // falls through to leading-on-next-value, NOT open-row trailing.
      const r = svc.parse('{ "foo": { /* before bar */ "bar": 1 } }');
      expect(r.commentsByPath.get('$.foo.bar')).toEqual({ leading: ['before bar'] });
      expect(r.commentsByPath.get('$.foo')?.trailing).toBeUndefined();
    });

    it('treats a multi-line block comment in an open-brace position as leading on the next value', () => {
      // The comment itself contains a `\n`, so rule 3a is disqualified
      // even if the line tail after `*/` is whitespace.
      const r = svc.parse('{\n  "foo": { /* multi\nline */\n    "bar": 1\n  }\n}');
      expect(r.commentsByPath.get('$.foo.bar')?.leading).toEqual(['multi\nline']);
      expect(r.commentsByPath.get('$.foo')?.trailing).toBeUndefined();
    });

    it('attributes the user-reported foo/bar/section-header case correctly', () => {
      // Regression for the bug reported 2026-05-01: the open-brace
      // line comment and a between-siblings comment were both queued
      // in pendingLeading and merged onto the next sibling's leading
      // slot, hiding the second comment behind commentFirstLine().
      const r = svc.parse(
        '{\n  "foo": { // explaination of foo\n    /*section header for bar*/\n    "bar": {} // value of bar\n  }\n}',
      );
      expect(r.commentsByPath.get('$.foo')).toEqual({
        trailing: ['explaination of foo'],
      });
      expect(r.commentsByPath.get('$.foo.bar')).toEqual({
        leading: ['section header for bar'],
        closeTrailing: ['value of bar'],
      });
    });

    it('separates closeLeading and closeTrailing on the same container when both are present', () => {
      // Regression for the bug reported 2026-05-01 (second test case):
      // an orphan comment between the last child and the close brace,
      // plus a same-line trailing on the close brace, were both being
      // routed to closeTrailing and merged with `\n`, hiding the
      // second comment behind commentFirstLine().
      const r = svc.parse(
        '{\n  "foo": { // explaination of foo\n    /*section header for bar*/\n    "bar": {} // value of bar\n    /*end of section for bar */\n  } // closing comment of foo\n}',
      );
      expect(r.commentsByPath.get('$.foo')).toEqual({
        trailing: ['explaination of foo'],
        closeLeading: ['end of section for bar'],
        closeTrailing: ['closing comment of foo'],
      });
      expect(r.commentsByPath.get('$.foo.bar')).toEqual({
        leading: ['section header for bar'],
        closeTrailing: ['value of bar'],
      });
    });

    it('stacks multiple pre-close orphan comments under closeLeading as separate array elements', () => {
      const r = svc.parse(
        '{\n  "foo": [\n    1,\n    /* first orphan */\n    /* second orphan */\n  ]\n}',
      );
      expect(r.commentsByPath.get('$.foo')).toEqual({
        closeLeading: ['first orphan', 'second orphan'],
      });
    });

    it('emits a length-2 closeLeading array for stacked pre-close comments', () => {
      const r = svc.parse('{\n  "foo": {\n    "x": 1\n    // orphan 1\n    // orphan 2\n  }\n}');
      expect(r.commentsByPath.get('$.foo')?.closeLeading).toEqual(['orphan 1', 'orphan 2']);
      expect(r.commentsByPath.get('$.foo')?.closeLeading?.length).toBe(2);
    });

    it('routes a single pre-close orphan comment to closeLeading even when no closeTrailing is present', () => {
      const r = svc.parse('{\n  "foo": {\n    "x": 1\n    /* trailing orphan */\n  }\n}');
      expect(r.commentsByPath.get('$.foo')).toEqual({
        closeLeading: ['trailing orphan'],
      });
    });
  });

  describe('parse - commentCount', () => {
    it('reports 0 for empty input', () => {
      expect(svc.parse('').commentCount).toBe(0);
    });

    it('reports 0 for whitespace-only input', () => {
      expect(svc.parse('   \n\t  ').commentCount).toBe(0);
    });

    it('reports 0 on the no-comment fast path', () => {
      // Sanity: input without any `//` or `/*` substring must take the
      // fast-path bail in harvestComments and not increment the counter.
      expect(svc.parse('{"a":1,"b":[2,3]}').commentCount).toBe(0);
    });

    it('reports 0 when delimiter substrings appear only inside string literals', () => {
      expect(svc.parse('{"path":"a/b/c"}').commentCount).toBe(0);
      expect(svc.parse('{"x":"// not a comment"}').commentCount).toBe(0);
    });

    it('counts a single line comment as 1', () => {
      expect(svc.parse('// top\n{"a":1}').commentCount).toBe(1);
    });

    it('counts stacked line comments as N', () => {
      expect(svc.parse('{\n  // line 1\n  // line 2\n  "x": 1\n}').commentCount).toBe(2);
    });

    it('counts a single multi-line block comment as 1 (not split on internal newlines)', () => {
      // The harvest stores block-comment bodies with internal `\n`
      // intact (extractCommentBody only `.trim()`s), so naive
      // `split('\n').length` on the joined CommentBundle string would
      // mis-count this as 2. The parser-side counter is the source of
      // truth and must report 1.
      expect(svc.parse('{"x": 1 /* multi\n  line */}').commentCount).toBe(1);
    });

    it('counts mixed multi-line block + stacked line comments correctly', () => {
      const input = '/* multi\n  line */\n' + '{\n  // a\n  // b\n  "x": 1 /* inline */\n}';
      // 1 (multi-line block) + 2 (stacked) + 1 (inline trailing) = 4
      expect(svc.parse(input).commentCount).toBe(4);
    });

    it('skips empty comments (// alone and /**/ alone)', () => {
      expect(svc.parse('{\n  //\n  "x": 1, /**/\n  "y": 2\n}').commentCount).toBe(0);
    });

    it('still counts comments on a parse-failed input', () => {
      // Display-side gating (status bar) suppresses the count when
      // errors.length > 0; the parser's job is to honestly report the
      // comments visit() saw, regardless of structural validity.
      const r = svc.parse('// header\n{"a":}');
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.commentCount).toBe(1);
    });
  });

  describe('parse - error reporting', () => {
    it('reports structured errors with line/column', () => {
      const r = svc.parse('{"a":}');
      expect(r.errors.length).toBeGreaterThan(0);
      const err = r.errors[0];
      expect(typeof err.message).toBe('string');
      expect(err.line).toBe(1);
      expect(err.column).toBeGreaterThan(0);
      expect(err.offset).toBeGreaterThanOrEqual(0);
    });

    it('computes line numbers across newlines', () => {
      const r = svc.parse('{\n  "a":\n  ,\n}');
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors[0].line).toBeGreaterThanOrEqual(2);
    });
  });

  describe('pathToString', () => {
    it('renders root for empty path', () => {
      expect(svc.pathToString([])).toBe('$');
    });

    it('uses dot notation for identifier keys', () => {
      expect(svc.pathToString(['foo', 'bar'])).toBe('$.foo.bar');
      expect(svc.pathToString(['_x', '$y', 'a1'])).toBe('$._x.$y.a1');
    });

    it('uses bracket notation for numeric indices', () => {
      expect(svc.pathToString(['arr', 0, 'x'])).toBe('$.arr[0].x');
    });

    it('uses bracket + JSON-string notation for non-identifier keys', () => {
      expect(svc.pathToString(['weird key'])).toBe('$["weird key"]');
      expect(svc.pathToString(['has"quote'])).toBe('$["has\\"quote"]');
      expect(svc.pathToString(['1leading'])).toBe('$["1leading"]');
    });
  });

  describe('formatPathForClipboard', () => {
    it('returns the canonical form unchanged for jsonpath mode', () => {
      expect(svc.formatPathForClipboard('$', 'jsonpath')).toBe('$');
      expect(svc.formatPathForClipboard('$.foo[0].bar', 'jsonpath')).toBe('$.foo[0].bar');
      expect(svc.formatPathForClipboard('$["a.b"]', 'jsonpath')).toBe('$["a.b"]');
    });

    it('replaces leading $ with root for root mode', () => {
      expect(svc.formatPathForClipboard('$', 'root')).toBe('root');
      expect(svc.formatPathForClipboard('$.foo[0].bar', 'root')).toBe('root.foo[0].bar');
      expect(svc.formatPathForClipboard('$["a.b"]', 'root')).toBe('root["a.b"]');
      expect(svc.formatPathForClipboard('$[0]', 'root')).toBe('root[0]');
    });

    it('replaces leading $ with capitalized Data for data mode', () => {
      expect(svc.formatPathForClipboard('$', 'data')).toBe('Data');
      expect(svc.formatPathForClipboard('$.foo[0].bar', 'data')).toBe('Data.foo[0].bar');
      expect(svc.formatPathForClipboard('$["a.b"]', 'data')).toBe('Data["a.b"]');
    });

    it('strips $ and following dot for none mode (lodash-style)', () => {
      expect(svc.formatPathForClipboard('$', 'none')).toBe('');
      expect(svc.formatPathForClipboard('$.foo', 'none')).toBe('foo');
      expect(svc.formatPathForClipboard('$.foo[0].bar', 'none')).toBe('foo[0].bar');
      expect(svc.formatPathForClipboard('$["a.b"]', 'none')).toBe('["a.b"]');
      expect(svc.formatPathForClipboard('$[0]', 'none')).toBe('[0]');
    });
  });

  describe('offsetToPosition', () => {
    it('returns 1/1 for offset 0', () => {
      expect(svc.offsetToPosition('abc', 0)).toEqual({ line: 1, column: 1 });
    });

    it('advances column within a line', () => {
      expect(svc.offsetToPosition('abc', 2)).toEqual({ line: 1, column: 3 });
    });

    it('advances line on \\n', () => {
      expect(svc.offsetToPosition('ab\ncd', 3)).toEqual({ line: 2, column: 1 });
      expect(svc.offsetToPosition('ab\ncd', 4)).toEqual({ line: 2, column: 2 });
    });

    it('clamps offset out of range', () => {
      expect(svc.offsetToPosition('abc', 9999)).toEqual({ line: 1, column: 4 });
      expect(svc.offsetToPosition('abc', -5)).toEqual({ line: 1, column: 1 });
    });
  });

  describe('locationAt', () => {
    it('returns the path at a given offset', () => {
      const text = '{"a":{"b":42}}';
      const offset = text.indexOf('42');
      expect(svc.locationAt(text, offset)).toEqual(['a', 'b']);
    });
  });

  describe('round-trip', () => {
    it('parses its own JSON output for a variety of values', () => {
      const samples: unknown[] = [
        { a: 1, b: 'two', c: [true, false, null] },
        [1, 2, 3],
        'hello',
        42,
        null,
      ];
      for (const s of samples) {
        const r = svc.parse(JSON.stringify(s));
        expect(r.value).toEqual(s);
      }
    });
  });

  describe('tryUnescape', () => {
    it('leaves valid JSON unchanged', () => {
      const text = '{"a":1,"b":[2,3]}';
      const r = svc.tryUnescape(text);
      expect(r.changed).toBe(false);
      expect(r.unescaped).toBe(text);
    });

    it('leaves valid JSONC (with comments, trailing commas) unchanged', () => {
      const text = '{\n  // hi\n  "a": 1,\n}';
      const r = svc.tryUnescape(text);
      expect(r.changed).toBe(false);
      expect(r.unescaped).toBe(text);
    });

    it('leaves empty and whitespace-only unchanged', () => {
      expect(svc.tryUnescape('').changed).toBe(false);
      expect(svc.tryUnescape('   \n\t').changed).toBe(false);
    });

    it('leaves plain prose containing \\n unchanged', () => {
      const text = 'hello\\nworld';
      const r = svc.tryUnescape(text);
      expect(r.changed).toBe(false);
      expect(r.unescaped).toBe(text);
    });

    it('unescapes the exact payload from issue #38', () => {
      const text =
        '{\\r\\n    \\"created_timestamp\\": \\"2026-04-15T22:39:31.3752771Z\\",\\r\\n    \\"updated_timestamp\\": \\"2026-04-15T22:39:34.828969Z\\",\\r\\n    \\"total_request_charge_amount\\": 200.0,\\r\\n    \\"total_customer_charge_amount\\": 200.0,\\r\\n    \\"balance_owing\\": 200.0\\r\\n }';
      const r = svc.tryUnescape(text);
      expect(r.changed).toBe(true);
      expect(svc.parse(r.unescaped).errors).toEqual([]);
      expect(svc.parse(r.unescaped).value).toEqual({
        created_timestamp: '2026-04-15T22:39:31.3752771Z',
        updated_timestamp: '2026-04-15T22:39:34.828969Z',
        total_request_charge_amount: 200.0,
        total_customer_charge_amount: 200.0,
        balance_owing: 200.0,
      });
    });

    it('unescapes a quoted JSON string literal', () => {
      const text = '"{\\"a\\":1,\\"b\\":2}"';
      const r = svc.tryUnescape(text);
      expect(r.changed).toBe(true);
      expect(svc.parse(r.unescaped).value).toEqual({ a: 1, b: 2 });
    });

    it('rejects top-level primitives after unescape', () => {
      // A bare escaped string like '\"hello\"' would unescape to '"hello"'
      // which parses cleanly - but we only accept object/array unescapes to
      // avoid false positives on ordinary prose.
      const text = '\\"hello\\"';
      const r = svc.tryUnescape(text);
      expect(r.changed).toBe(false);
    });
  });

  describe('escapeAsJsonString', () => {
    it('produces JSON.stringify semantics', () => {
      expect(svc.escapeAsJsonString('{"a":1}')).toBe('"{\\"a\\":1}"');
    });

    it('round-trips through tryUnescape for object payloads', () => {
      const original = '{"a":1,"b":[2,3]}';
      const escaped = svc.escapeAsJsonString(original);
      const r = svc.tryUnescape(escaped);
      expect(r.changed).toBe(true);
      expect(svc.parse(r.unescaped).value).toEqual({ a: 1, b: [2, 3] });
    });
  });
});
