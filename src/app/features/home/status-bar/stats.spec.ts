import { parseTree } from 'jsonc-parser';
import { computeMinifiedChars, computeTextStats, computeTreeStats, formatBytes } from './stats';

describe('stats', () => {
  describe('computeTextStats', () => {
    it('treats empty string as all zeros', () => {
      expect(computeTextStats('')).toEqual({ lines: 0, bytes: 0 });
    });

    it('counts a single line', () => {
      expect(computeTextStats('hello')).toEqual({ lines: 1, bytes: 5 });
    });

    it('counts multiple lines (trailing newline counted)', () => {
      expect(computeTextStats('a\nb\nc\n').lines).toBe(4);
      expect(computeTextStats('a\nb\nc').lines).toBe(3);
    });

    it('reports UTF-8 bytes for multi-byte characters', () => {
      // snowman = 3 UTF-8 bytes, 1 UTF-16 code unit
      const snowman = '\u2603';
      const stats = computeTextStats(snowman);
      expect(stats.bytes).toBe(3);
    });
  });

  describe('computeMinifiedChars', () => {
    it('returns 0 for empty input', () => {
      expect(computeMinifiedChars('')).toBe(0);
    });

    it('returns 0 for whitespace-only input', () => {
      expect(computeMinifiedChars('   \n\t  ')).toBe(0);
    });

    it('counts every character in already-minified ASCII JSON', () => {
      const minified = '{"a":1,"b":[true,null]}';
      expect(computeMinifiedChars(minified)).toBe(minified.length);
    });

    it('strips whitespace from pretty-printed JSON, recovering the minified count', () => {
      const minified = '{"a":1,"b":[true,null]}';
      const pretty = '{\n  "a": 1,\n  "b": [true, null]\n}\n';
      expect(computeMinifiedChars(pretty)).toBe(minified.length);
    });

    it('strips line and block comments from JSONC', () => {
      const jsonc = '{\n  // a name\n  "name": "x", /* trailing block */\n  "n": 1\n}';
      expect(computeMinifiedChars(jsonc)).toBe('{"name":"x","n":1}'.length);
    });

    it('preserves scientific-notation source form (1e3 stays 3 chars)', () => {
      // JSON.stringify({n: 1e3}) -> '{"n":1000}' (10 chars).
      // Lexical count must NOT collapse to that.
      expect(computeMinifiedChars('{"n":1e3}')).toBe('{"n":1e3}'.length);
    });

    it('preserves trailing-zero decimal source form (1.0 stays 3 chars)', () => {
      // JSON.stringify({n: 1.0}) -> '{"n":1}' (7 chars). Lexical count is 9.
      expect(computeMinifiedChars('{"n":1.0}')).toBe('{"n":1.0}'.length);
    });

    it('preserves escaped-unicode source form ("\\u0041" stays 8 chars)', () => {
      // JSON.stringify({s: "\u0041"}) -> '{"s":"A"}' (9 chars).
      // Lexical count must reflect the source bytes the user wrote.
      const text = '{"s":"\\u0041"}';
      expect(computeMinifiedChars(text)).toBe(text.length);
    });

    it('counts trailing commas (documented off-by-one in JSONC)', () => {
      // JSONC accepts the trailing comma; minified strict JSON would drop it.
      // The scanner emits CommaToken either way, so the count is +1.
      const jsonc = '{"a":1,}';
      expect(computeMinifiedChars(jsonc)).toBe(jsonc.length);
    });

    it('still produces a count for partial / parse-error input', () => {
      // `{abc` is unparsable but the scanner emits OpenBraceToken + Unknown.
      // Must return a number, not throw.
      const result = computeMinifiedChars('{abc');
      expect(typeof result).toBe('number');
      expect(result).toBe(4);
    });

    it('counts non-ASCII characters as UTF-16 code units (snowman = 1)', () => {
      // The snowman occupies 1 UTF-16 code unit.
      // `{"s":"\u2603"}` -> 9 chars including the snowman:
      // {  "  s  "  :  "  <snowman>  "  }
      const text = '{"s":"\u2603"}';
      expect(text.length).toBe(9);
      expect(computeMinifiedChars(text)).toBe(text.length);
    });
  });

  describe('computeTreeStats', () => {
    function astOf(text: string) {
      return parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
    }

    it('returns undefined when AST is undefined', () => {
      expect(computeTreeStats(undefined)).toBeUndefined();
    });

    it('counts nodes in a flat object', () => {
      const s = computeTreeStats(astOf('{"a":1,"b":2}'))!;
      expect(s.nodes).toBe(3); // object + 2 numbers
      expect(s.objects).toBe(1);
      expect(s.arrays).toBe(0);
      expect(s.depth).toBe(1);
    });

    it('counts objects, arrays, and primitive leaves recursively', () => {
      const s = computeTreeStats(astOf('{"a":[1,2,{"b":true}]}'))!;
      // object + array + 1 + 2 + object + true = 6 nodes
      expect(s.nodes).toBe(6);
      expect(s.objects).toBe(2);
      expect(s.arrays).toBe(1);
      expect(s.depth).toBe(3); // root(0) -> array(1) -> object(2) -> true(3)
    });

    it('treats a top-level primitive as depth 0 with one node', () => {
      const s = computeTreeStats(astOf('42'))!;
      expect(s.nodes).toBe(1);
      expect(s.objects).toBe(0);
      expect(s.arrays).toBe(0);
      expect(s.depth).toBe(0);
    });
  });

  describe('formatBytes', () => {
    it('uses plain bytes below 1 KB', () => {
      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(1)).toBe('1 B');
      expect(formatBytes(999)).toBe('999 B');
    });

    it('uses SI units at and above 1 KB', () => {
      expect(formatBytes(1000)).toBe('1.0 KB');
      expect(formatBytes(1536)).toBe('1.5 KB');
      expect(formatBytes(2_500_000)).toBe('2.5 MB');
      expect(formatBytes(3_000_000_000)).toBe('3.0 GB');
    });

    it('clamps negative/invalid inputs to 0 B', () => {
      expect(formatBytes(-5)).toBe('0 B');
      expect(formatBytes(Number.NaN)).toBe('0 B');
    });
  });
});
