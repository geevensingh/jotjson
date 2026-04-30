import { parseTree } from 'jsonc-parser';
import {
  computeTextStats,
  computeTreeStats,
  formatBytes
} from './stats';

describe('stats', () => {
  describe('computeTextStats', () => {
    it('treats empty string as all zeros', () => {
      expect(computeTextStats('')).toEqual({ chars: 0, lines: 0, bytes: 0 });
    });

    it('counts a single line', () => {
      expect(computeTextStats('hello')).toEqual({ chars: 5, lines: 1, bytes: 5 });
    });

    it('counts multiple lines (trailing newline counted)', () => {
      expect(computeTextStats('a\nb\nc\n').lines).toBe(4);
      expect(computeTextStats('a\nb\nc').lines).toBe(3);
    });

    it('reports UTF-8 bytes for multi-byte characters', () => {
      // snowman = 3 UTF-8 bytes, 1 UTF-16 code unit
      const snowman = '\u2603';
      const stats = computeTextStats(snowman);
      expect(stats.chars).toBe(1);
      expect(stats.bytes).toBe(3);
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
