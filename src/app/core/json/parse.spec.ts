import { locationAt, offsetToPosition, parse, pathToString, type JsonParseResult } from './parse';

/**
 * Unit tests for the import-isolated pure-function `parse` module.
 *
 * The companion `parse.parity.spec.ts` proves the
 * `JsonParserService.parse` wrapper delegates correctly. The legacy
 * `json-parser.service.spec.ts` continues to exercise the service
 * surface end-to-end through DI.
 *
 * Tests below focus on the surface guarantees that matter for the
 * Layer-1 perf bench (`perf/bench/parse.bench.ts`): zero DI, no
 * `inject()`, no @Injectable, no repo-internal imports. The module is
 * `new`-able from a Node ESM bench harness.
 */
describe('parse (pure)', () => {
  describe('empty input', () => {
    it('returns the empty sentinel for empty string', () => {
      const result: JsonParseResult = parse('');
      expect(result.empty).toBe(true);
      expect(result.value).toBeUndefined();
      expect(result.errors).toEqual([]);
      expect(result.commentCount).toBe(0);
    });

    it('returns the empty sentinel for whitespace-only', () => {
      const result = parse('   \n\t  ');
      expect(result.empty).toBe(true);
    });
  });

  describe('happy path - JSON', () => {
    it('parses primitives at root', () => {
      expect(parse('null').value).toBeNull();
      expect(parse('true').value).toBe(true);
      expect(parse('42').value).toBe(42);
      expect(parse('"hi"').value).toBe('hi');
    });

    it('parses arrays and nested objects', () => {
      const result = parse('{"a":[1,2,{"b":true}]}');
      expect(result.empty).toBe(false);
      expect(result.errors).toEqual([]);
      expect(result.value).toEqual({ a: [1, 2, { b: true }] });
    });

    it('strips a leading BOM without surfacing an error', () => {
      const result = parse('\uFEFF{"a":1}');
      expect(result.errors).toEqual([]);
      expect(result.value).toEqual({ a: 1 });
    });
  });

  describe('JSONC extensions', () => {
    it('accepts // and /* */ comments and surfaces commentCount', () => {
      const result = parse(`{
        // first
        "a": 1, /* trailing */
        "b": 2
      }`);
      expect(result.errors).toEqual([]);
      expect(result.value).toEqual({ a: 1, b: 2 });
      expect(result.commentCount).toBe(2);
      expect(result.commentsByPath.size).toBeGreaterThan(0);
    });

    it('accepts trailing commas', () => {
      const result = parse('[1, 2, 3,]');
      expect(result.errors).toEqual([]);
      expect(result.value).toEqual([1, 2, 3]);
    });

    it('takes the no-comment fast path when no delimiter substring present', () => {
      const result = parse('{"a": 1}');
      expect(result.commentCount).toBe(0);
      expect(result.commentsByPath.size).toBe(0);
    });
  });

  describe('error reporting', () => {
    it('reports structured errors with line/column', () => {
      const result = parse('{"a"');
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].line).toBeGreaterThanOrEqual(1);
      expect(result.errors[0].column).toBeGreaterThanOrEqual(1);
    });
  });

  describe('offsetToPosition', () => {
    it('returns 1/1 for offset 0', () => {
      expect(offsetToPosition('abc', 0)).toEqual({ line: 1, column: 1 });
    });

    it('advances line on \\n', () => {
      expect(offsetToPosition('a\nb', 2)).toEqual({ line: 2, column: 1 });
    });

    it('clamps offset out of range', () => {
      expect(offsetToPosition('abc', 999)).toEqual({ line: 1, column: 4 });
    });
  });

  describe('pathToString', () => {
    it('renders $ for empty path', () => {
      expect(pathToString([])).toBe('$');
    });

    it('uses dot for identifier keys', () => {
      expect(pathToString(['foo', 'bar'])).toBe('$.foo.bar');
    });

    it('uses bracket for numeric indices', () => {
      expect(pathToString(['arr', 0])).toBe('$.arr[0]');
    });

    it('uses bracket + JSON string for non-identifier keys', () => {
      expect(pathToString(['a.b'])).toBe('$["a.b"]');
    });
  });

  describe('locationAt', () => {
    it('returns the canonical path at a given offset', () => {
      const text = '{"a": 1}';
      // offset on the value `1`
      const offsetOnValue = text.indexOf('1');
      expect(locationAt(text, offsetOnValue)).toEqual(['a']);
    });
  });
});
