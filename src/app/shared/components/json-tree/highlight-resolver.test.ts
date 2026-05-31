import type { BlobHighlight } from '../../../core/api/models';
import { findNearestCascade, indexHighlights, resolveManualHighlight } from './highlight-resolver';

describe('highlight resolver', () => {
  const rootCascade: BlobHighlight = { path: '$', color: '#111111', cascade: true };
  const parentCascade: BlobHighlight = { path: '$.foo', color: '#222222', cascade: true };
  const childCascade: BlobHighlight = { path: '$.foo.bar', color: '#333333', cascade: true };

  it('builds an empty index and resolves nothing for empty highlights', () => {
    const index = indexHighlights([]);

    expect(index.size).toBe(0);
    expect(resolveManualHighlight('$.foo', index)).toBeUndefined();
    expect(findNearestCascade('$.foo', index)).toBeUndefined();
  });

  it('returns a direct non-cascade hit as the winning row highlight', () => {
    const index = indexHighlights([{ path: '$.foo', color: '#abcdef', cascade: false }]);

    expect(resolveManualHighlight('$.foo', index)).toEqual({
      color: '#abcdef',
      sourcePath: '$.foo',
      cascade: false,
      inherited: false,
    });
  });

  it('returns a direct cascade hit as the winning row highlight', () => {
    const index = indexHighlights([{ path: '$.foo', color: '#fedcba', cascade: true }]);

    expect(resolveManualHighlight('$.foo', index)).toEqual({
      color: '#fedcba',
      sourcePath: '$.foo',
      cascade: true,
      inherited: false,
    });
    expect(findNearestCascade('$.foo', index)).toEqual({ path: '$.foo', color: '#fedcba' });
  });

  it('inherits the nearest ancestor cascade when there is no own entry', () => {
    const index = indexHighlights([parentCascade]);

    expect(resolveManualHighlight('$.foo.bar[3].baz', index)).toEqual({
      color: '#222222',
      sourcePath: '$.foo',
      cascade: true,
      inherited: true,
    });
  });

  it('lets an own non-cascade entry beat an inherited cascade', () => {
    const index = indexHighlights([
      parentCascade,
      { path: '$.foo.bar', color: '#444444', cascade: false },
    ]);

    expect(resolveManualHighlight('$.foo.bar', index)).toEqual({
      color: '#444444',
      sourcePath: '$.foo.bar',
      cascade: false,
      inherited: false,
    });
    expect(findNearestCascade('$.foo.bar', index)).toEqual({ path: '$.foo', color: '#222222' });
  });

  it('uses the nearest cascade when multiple ancestors cascade', () => {
    const index = indexHighlights([rootCascade, parentCascade, childCascade]);

    expect(resolveManualHighlight('$.foo.bar[3].baz', index)).toEqual({
      color: '#333333',
      sourcePath: '$.foo.bar',
      cascade: true,
      inherited: true,
    });
    expect(findNearestCascade('$.foo.bar[3].baz', index)).toEqual({
      path: '$.foo.bar',
      color: '#333333',
    });
  });

  it('applies a root cascade to a leaf with no own entry', () => {
    const index = indexHighlights([rootCascade]);

    expect(resolveManualHighlight('$.foo.bar[3].baz', index)).toEqual({
      color: '#111111',
      sourcePath: '$',
      cascade: true,
      inherited: true,
    });
  });

  it('returns undefined when no own or cascade highlight applies', () => {
    const index = indexHighlights([{ path: '$.foo', color: '#222222', cascade: false }]);

    expect(resolveManualHighlight('$.foo.bar', index)).toBeUndefined();
    expect(findNearestCascade('$.foo.bar', index)).toBeUndefined();
  });

  it('walks bracket-quoted key ancestors without splitting internal dots or brackets', () => {
    const cascadePath = '$["a.b"][0]["c]d"]';
    const index = indexHighlights([{ path: cascadePath, color: '#123456', cascade: true }]);

    expect(resolveManualHighlight(`${cascadePath}.leaf`, index)).toEqual({
      color: '#123456',
      sourcePath: cascadePath,
      cascade: true,
      inherited: true,
    });
  });

  it('resolves 1000 rows against 100 highlights under the render budget', () => {
    const paths: string[] = [];
    for (let rowIndex = 0; rowIndex < 1000; rowIndex += 1) {
      paths.push(`$.items[${rowIndex}].level0.level1.level2.level3.level4.value`);
    }
    const highlights: BlobHighlight[] = [];
    for (let rowIndex = 0; rowIndex < 100; rowIndex += 1) {
      highlights.push({
        path: `$.items[${rowIndex}].level0`,
        color: `#${(rowIndex + 1).toString(16).padStart(6, '0')}`,
        cascade: true,
      });
    }

    const runResolutionPass = (): number => {
      const start = performance.now();
      const index = indexHighlights(highlights);
      for (const path of paths) {
        resolveManualHighlight(path, index);
      }
      return performance.now() - start;
    };

    runResolutionPass();

    for (let iteration = 1; iteration <= 3; iteration += 1) {
      const timeMs = runResolutionPass();
      expect(timeMs, `iteration ${iteration}`).toBeLessThan(50);
    }
  });
});
