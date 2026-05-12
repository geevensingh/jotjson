import { pathToString } from './json-path';

describe('pathToString', () => {
  it('renders the empty root as $', () => {
    expect(pathToString([])).toBe('$');
  });

  it('renders bare identifiers as dot segments', () => {
    expect(pathToString(['foo', 'bar'])).toBe('$.foo.bar');
    expect(pathToString(['_x', '$y', 'a1'])).toBe('$._x.$y.a1');
  });

  it('renders numeric segments as array indices', () => {
    expect(pathToString(['arr', 0])).toBe('$.arr[0]');
    expect(pathToString(['arr', 0, 'x'])).toBe('$.arr[0].x');
  });

  it('renders non-identifier keys as JSON-quoted brackets', () => {
    expect(pathToString(['a.b'])).toBe('$["a.b"]');
    expect(pathToString(['weird key'])).toBe('$["weird key"]');
    expect(pathToString(['has"quote'])).toBe('$["has\\"quote"]');
    expect(pathToString(['1leading'])).toBe('$["1leading"]');
  });
});
