import { compareKeysCodeunit, sortKeysDeep } from './sort-keys';

describe('compareKeysCodeunit', () => {
  it('orders ASCII punctuation, digits, uppercase, and lowercase by code unit', () => {
    const orderedPairs: ReadonlyArray<readonly [string, string]> = [
      [' ', '0'],
      ['0', '9'],
      ['9', 'A'],
      ['A', 'Z'],
      ['Z', 'a'],
      ['a', 'z'],
    ];

    for (const [left, right] of orderedPairs) {
      expect(compareKeysCodeunit(left, right)).toBe(-1);
      expect(compareKeysCodeunit(right, left)).toBe(1);
    }
  });

  it('returns 0 for equal strings', () => {
    expect(compareKeysCodeunit('same', 'same')).toBe(0);
  });

  it('orders paired surrogates deterministically against another emoji', () => {
    const thumbsUp = '\uD83D\uDC4D';
    const grinningFace = '\uD83D\uDE00';

    expect(compareKeysCodeunit(thumbsUp, grinningFace)).toBe(-1);
    expect(compareKeysCodeunit(thumbsUp, grinningFace)).toBe(-1);
    expect(compareKeysCodeunit(grinningFace, thumbsUp)).toBe(1);
  });

  it('orders lone surrogates deterministically without throwing or returning NaN', () => {
    const first = '\uD800';
    const second = '\uD801';
    const result = compareKeysCodeunit(first, second);

    expect(result).toBe(-1);
    expect(compareKeysCodeunit(first, second)).toBe(-1);
    expect(Number.isNaN(result)).toBeFalse();
  });
});

describe('sortKeysDeep', () => {
  it('returns an empty object with no own keys', () => {
    const input = {};
    const result = sortKeysDeep(input);

    expect(result).not.toBe(input);
    expect(result).toEqual({});
    expect(Object.keys(result)).toEqual([]);
  });

  it('returns a new single-key object with the same key and value', () => {
    const input = { a: 1 };
    const result = sortKeysDeep(input);

    expect(result).not.toBe(input);
    expect(result).toEqual({ a: 1 });
    expect(Object.keys(result)).toEqual(['a']);
  });

  it('returns a new already-sorted object with the same key order', () => {
    const input = { a: 1, b: 2 };
    const result = sortKeysDeep(input);

    expect(result).not.toBe(input);
    expect(result).toEqual({ a: 1, b: 2 });
    expect(Object.keys(result)).toEqual(['a', 'b']);
  });

  it('reorders object keys and keeps the matching values', () => {
    const input = { b: 1, a: 2 };
    const result = sortKeysDeep(input);

    expect(Object.keys(result)).toEqual(['a', 'b']);
    expect([result.a, result.b]).toEqual([2, 1]);
  });

  it('sorts nested objects recursively', () => {
    const input = { z: { y: 1, x: 2 }, a: 3 };
    const result = sortKeysDeep(input);

    expect(Object.keys(result)).toEqual(['a', 'z']);
    expect(Object.keys(result.z)).toEqual(['x', 'y']);
    expect(result).toEqual({ a: 3, z: { x: 2, y: 1 } });
  });

  it('returns a new array, preserves element order, and sorts objects inside it', () => {
    const input = [
      { b: 1, a: 2 },
      { d: 3, c: 4 },
    ];
    const result = sortKeysDeep(input);

    expect(result).not.toBe(input);
    expect(result.length).toBe(2);
    expect(Object.keys(result[0])).toEqual(['a', 'b']);
    expect(Object.keys(result[1])).toEqual(['c', 'd']);
    expect(Object.keys(input[0])).toEqual(['b', 'a']);
    expect(Object.keys(input[1])).toEqual(['d', 'c']);
  });

  it('passes primitives through unchanged', () => {
    expect(sortKeysDeep(123)).toBe(123);
    expect(sortKeysDeep('text')).toBe('text');
    expect(sortKeysDeep(true)).toBeTrue();
    expect(sortKeysDeep(null)).toBeNull();
  });

  it('preserves an own __proto__ key as data on the sorted result', () => {
    const input = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(input, '__proto__', {
      value: 1,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    input['a'] = 2;

    const result = sortKeysDeep(input);

    expect(Object.getOwnPropertyNames(result)).toEqual(['__proto__', 'a']);
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBeTrue();
    expect(result['__proto__']).toBe(1);
    expect(result['a']).toBe(2);
  });

  it('uses the provided comparator when sorting keys', () => {
    const input = { a: 1, c: 3, b: 2 };
    const reverseComparator = (left: string, right: string): number =>
      compareKeysCodeunit(right, left);

    const result = sortKeysDeep(input, reverseComparator);

    expect(Object.keys(result)).toEqual(['c', 'b', 'a']);
    expect([result.c, result.b, result.a]).toEqual([3, 2, 1]);
  });
});
