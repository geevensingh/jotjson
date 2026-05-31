import { JsonTypePipe, jsonTypeOf } from './json-type.pipe';

describe('jsonTypeOf', () => {
  it('detects null before object', () => {
    expect(jsonTypeOf(null)).toBe('null');
  });

  it('detects undefined', () => {
    expect(jsonTypeOf(undefined)).toBe('undefined');
  });

  it('detects arrays before generic objects', () => {
    expect(jsonTypeOf([])).toBe('array');
    expect(jsonTypeOf([1, 2])).toBe('array');
  });

  it('detects plain objects', () => {
    expect(jsonTypeOf({})).toBe('object');
    expect(jsonTypeOf({ a: 1 })).toBe('object');
  });

  it('detects primitives', () => {
    expect(jsonTypeOf('hi')).toBe('string');
    expect(jsonTypeOf(0)).toBe('number');
    expect(jsonTypeOf(NaN)).toBe('number');
    expect(jsonTypeOf(true)).toBe('boolean');
  });
});

describe('JsonTypePipe', () => {
  it('delegates to jsonTypeOf', () => {
    const pipe = new JsonTypePipe();
    expect(pipe.transform(42)).toBe('number');
    expect(pipe.transform(null)).toBe('null');
    expect(pipe.transform([1])).toBe('array');
  });
});
