import { bomShift, computeColumn, reindentReplacement } from './json-patch-utils';

describe('json-patch-utils', () => {
  describe('bomShift', () => {
    it('returns 0 for an empty string', () => {
      expect(bomShift('')).toBe(0);
    });

    it('returns 0 when the string does not start with a BOM', () => {
      expect(bomShift('{}')).toBe(0);
    });

    it('returns 1 when the string starts with a BOM', () => {
      expect(bomShift('\uFEFF{}')).toBe(1);
    });
  });

  describe('computeColumn', () => {
    it('returns 0 at offset 0', () => {
      expect(computeColumn('abc', 0)).toBe(0);
    });

    it('returns the offset in a single-line string', () => {
      expect(computeColumn('abcdef', 4)).toBe(4);
    });

    it('resets the column after a newline', () => {
      expect(computeColumn('abc\ndef', 5)).toBe(1);
      expect(computeColumn('abc\ndef', 4)).toBe(0);
    });

    it('counts from the last newline only when multiple newlines are present', () => {
      expect(computeColumn('ab\ncd\nef', 8)).toBe(2);
    });
  });

  describe('reindentReplacement', () => {
    it('returns a single-line input unchanged', () => {
      const replacementText = '{"a":1}';

      const result = reindentReplacement(replacementText, 4);

      expect(result).toBe(replacementText);
      expect(result).toEqual('{"a":1}');
    });

    it('returns a zero-column input unchanged regardless of line count', () => {
      const replacementText = '{\n  "a": 1\n}';

      const result = reindentReplacement(replacementText, 0);

      expect(result).toBe(replacementText);
      expect(result).toEqual(replacementText);
    });

    it('prefixes every non-first line when given a multi-line input and non-zero column', () => {
      expect(reindentReplacement('{\n"a": 1\n}', 2)).toBe('{\n  "a": 1\n  }');
    });
  });
});
