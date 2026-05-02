import { collectStringLeaves } from './string-leaf-collector';

describe('collectStringLeaves', () => {
  it('collects string leaves from nested objects', () => {
    const value = {
      id: 'root',
      child: {
        name: 'child',
        meta: {
          description: 'nested',
        },
      },
    };

    expect(collectStringLeaves(value)).toEqual(['root', 'child', 'nested']);
  });

  it('collects arrays of strings in order', () => {
    expect(collectStringLeaves(['first', 'second', 'third'])).toEqual(['first', 'second', 'third']);
  });

  it('collects string leaves through mixed arrays and objects', () => {
    const value = {
      items: ['alpha', { beta: 'bravo' }, [false, 'charlie']],
      count: 3,
      enabled: true,
    };

    expect(collectStringLeaves(value)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('ignores null and undefined', () => {
    expect(collectStringLeaves(null)).toEqual([]);
    expect(collectStringLeaves(undefined)).toEqual([]);
  });

  it('ignores non-string primitives', () => {
    expect(collectStringLeaves(42)).toEqual([]);
    expect(collectStringLeaves(true)).toEqual([]);
    expect(collectStringLeaves(false)).toEqual([]);
  });

  it('collects a primitive string value', () => {
    expect(collectStringLeaves('solo')).toEqual(['solo']);
  });

  it('collects deeply nested string leaves', () => {
    const value = {
      level1: [
        {
          level2: {
            level3: [
              {
                level4: {
                  value: 'deep',
                },
              },
            ],
          },
        },
      ],
    };

    expect(collectStringLeaves(value)).toEqual(['deep']);
  });

  it('appends to an existing accumulator', () => {
    const accumulator = ['existing'];

    expect(collectStringLeaves({ next: 'leaf' }, accumulator)).toBe(accumulator);
    expect(accumulator).toEqual(['existing', 'leaf']);
  });
});
