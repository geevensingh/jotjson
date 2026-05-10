import { classifyJsonValue, isJsonValueEmpty, type ValueKind } from './formatting-value-kind';

// Formatting predicates must stay independent of user preferences. Keep this
// spec and the helper free of imports from core/preferences or similar modules.

describe('formatting-value-kind', () => {
  function expectValuesToHaveKind(values: readonly unknown[], expectedKind: ValueKind): void {
    for (const value of values) {
      expect(classifyJsonValue(value)).toBe(expectedKind);
    }
  }

  describe('classifyJsonValue', () => {
    it('classifies strings as string', () => {
      expectValuesToHaveKind(['', 'a', 'null', '42', '   ', 'true'], 'string');
    });

    it('classifies non-integer numbers as number', () => {
      expectValuesToHaveKind([1.5, -0.1, Math.PI, Number.EPSILON], 'number');
    });

    it('classifies integers as integer', () => {
      // Number.MAX_VALUE has no fractional part in JavaScript, so the
      // locked Number.isInteger contract classifies it as an integer.
      expectValuesToHaveKind([0, 1, -1, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE], 'integer');
    });

    it('classifies booleans as boolean', () => {
      expectValuesToHaveKind([true, false], 'boolean');
    });

    it('classifies null as null', () => {
      expectValuesToHaveKind([null], 'null');
    });

    it('classifies arrays as array', () => {
      expectValuesToHaveKind([[], [1], [null], [[]]], 'array');
    });

    it('classifies objects as object', () => {
      expectValuesToHaveKind([{}, { a: 1 }, { a: null }], 'object');
    });

    it('returns the same kind for repeated calls with the same input', () => {
      const values: readonly unknown[] = [
        '',
        'null',
        1.5,
        1,
        true,
        false,
        null,
        [],
        [null],
        {},
        { a: null },
      ];

      for (const value of values) {
        const firstKind = classifyJsonValue(value);
        const secondKind = classifyJsonValue(value);
        expect(secondKind).toBe(firstKind);
      }
    });
  });

  describe('isJsonValueEmpty', () => {
    it('returns true only for empty strings, arrays, and objects', () => {
      for (const value of ['', [], {}]) {
        expect(isJsonValueEmpty(value)).toBeTrue();
      }
    });

    it('returns false for non-empty and scalar values', () => {
      const values: readonly unknown[] = [
        'a',
        '   ',
        ' ',
        '\n',
        'null',
        null,
        0,
        false,
        [null],
        [undefined],
        { a: 1 },
        { a: null },
        true,
        false,
      ];

      for (const value of values) {
        expect(isJsonValueEmpty(value)).toBeFalse();
      }
    });

    it('returns the same emptiness for repeated calls with the same input', () => {
      const values: readonly unknown[] = [
        '',
        ' ',
        'null',
        null,
        0,
        false,
        [],
        [null],
        {},
        { a: null },
      ];

      for (const value of values) {
        const firstResult = isJsonValueEmpty(value);
        const secondResult = isJsonValueEmpty(value);
        expect(secondResult).toBe(firstResult);
      }
    });
  });
});
