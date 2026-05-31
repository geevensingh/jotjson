import { jsonTypeOf, type JsonValueType } from './json-value-type';

describe('jsonTypeOf', () => {
  it('classifies null and undefined distinctly', () => {
    expect(jsonTypeOf(null)).toBe('null');
    expect(jsonTypeOf(undefined)).toBe('undefined');
  });

  it('classifies arrays as array (not object)', () => {
    expect(jsonTypeOf([])).toBe('array');
    expect(jsonTypeOf([1, 2, 3])).toBe('array');
  });

  it('classifies plain objects as object', () => {
    expect(jsonTypeOf({})).toBe('object');
    expect(jsonTypeOf({ a: 1 })).toBe('object');
  });

  it('classifies primitive values by typeof', () => {
    expect(jsonTypeOf('hi')).toBe('string');
    expect(jsonTypeOf(0)).toBe('number');
    expect(jsonTypeOf(NaN)).toBe('number');
    expect(jsonTypeOf(true)).toBe('boolean');
  });

  it('exposes the canonical JsonValueType union', () => {
    const allowed: JsonValueType[] = [
      'object',
      'array',
      'string',
      'number',
      'boolean',
      'null',
      'undefined',
    ];
    expect(allowed).toContain(jsonTypeOf(null));
    expect(allowed).toContain(jsonTypeOf({}));
  });
});
