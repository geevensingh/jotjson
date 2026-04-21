import { TestBed } from '@angular/core/testing';
import { JsonParserService } from './json-parser.service';

describe('JsonParserService', () => {
  let svc: JsonParserService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    svc = TestBed.inject(JsonParserService);
  });

  describe('parse - empty inputs', () => {
    it('treats empty string as empty', () => {
      const r = svc.parse('');
      expect(r.empty).toBeTrue();
      expect(r.value).toBeUndefined();
      expect(r.errors).toEqual([]);
    });

    it('treats whitespace-only as empty', () => {
      const r = svc.parse('   \n\t  ');
      expect(r.empty).toBeTrue();
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
        null
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
      expect(r.changed).toBeFalse();
      expect(r.unescaped).toBe(text);
    });

    it('leaves valid JSONC (with comments, trailing commas) unchanged', () => {
      const text = '{\n  // hi\n  "a": 1,\n}';
      const r = svc.tryUnescape(text);
      expect(r.changed).toBeFalse();
      expect(r.unescaped).toBe(text);
    });

    it('leaves empty and whitespace-only unchanged', () => {
      expect(svc.tryUnescape('').changed).toBeFalse();
      expect(svc.tryUnescape('   \n\t').changed).toBeFalse();
    });

    it('leaves plain prose containing \\n unchanged', () => {
      const text = 'hello\\nworld';
      const r = svc.tryUnescape(text);
      expect(r.changed).toBeFalse();
      expect(r.unescaped).toBe(text);
    });

    it('unescapes the exact payload from issue #38', () => {
      const text =
        '{\\r\\n    \\"created_timestamp\\": \\"2026-04-15T22:39:31.3752771Z\\",\\r\\n    \\"updated_timestamp\\": \\"2026-04-15T22:39:34.828969Z\\",\\r\\n    \\"total_request_charge_amount\\": 200.0,\\r\\n    \\"total_customer_charge_amount\\": 200.0,\\r\\n    \\"balance_owing\\": 200.0\\r\\n }';
      const r = svc.tryUnescape(text);
      expect(r.changed).toBeTrue();
      expect(svc.parse(r.unescaped).errors).toEqual([]);
      expect(svc.parse(r.unescaped).value).toEqual({
        created_timestamp: '2026-04-15T22:39:31.3752771Z',
        updated_timestamp: '2026-04-15T22:39:34.828969Z',
        total_request_charge_amount: 200.0,
        total_customer_charge_amount: 200.0,
        balance_owing: 200.0
      });
    });

    it('unescapes a quoted JSON string literal', () => {
      const text = '"{\\"a\\":1,\\"b\\":2}"';
      const r = svc.tryUnescape(text);
      expect(r.changed).toBeTrue();
      expect(svc.parse(r.unescaped).value).toEqual({ a: 1, b: 2 });
    });

    it('rejects top-level primitives after unescape', () => {
      // A bare escaped string like '\"hello\"' would unescape to '"hello"'
      // which parses cleanly - but we only accept object/array unescapes to
      // avoid false positives on ordinary prose.
      const text = '\\"hello\\"';
      const r = svc.tryUnescape(text);
      expect(r.changed).toBeFalse();
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
      expect(r.changed).toBeTrue();
      expect(svc.parse(r.unescaped).value).toEqual({ a: 1, b: [2, 3] });
    });
  });
});
