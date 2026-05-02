import type { BlobHighlight } from '../../../core/api/models';

export interface ResolvedHighlight {
  color: string;
  sourcePath: string;
  cascade: boolean;
  inherited: boolean;
}

/**
 * Build an O(1) lookup index from a highlights array. Call this
 * once when highlights changes, not per tree row.
 */
export function indexHighlights(highlights: readonly BlobHighlight[]): Map<string, BlobHighlight> {
  const index = new Map<string, BlobHighlight>();
  for (const highlight of highlights) {
    index.set(highlight.path, highlight);
  }
  return index;
}

/**
 * Resolve a single row's path against the index. Walks the ancestor
 * chain only if no own entry exists.
 */
export function resolveManualHighlight(
  path: string,
  index: ReadonlyMap<string, BlobHighlight>,
): ResolvedHighlight | undefined {
  const ownHighlight = index.get(path);
  if (ownHighlight) {
    return {
      color: ownHighlight.color,
      sourcePath: path,
      cascade: ownHighlight.cascade,
      inherited: false,
    };
  }

  for (const ancestorPath of ancestorPaths(path)) {
    const ancestorHighlight = index.get(ancestorPath);
    if (ancestorHighlight?.cascade === true) {
      return {
        color: ancestorHighlight.color,
        sourcePath: ancestorPath,
        cascade: true,
        inherited: true,
      };
    }
  }

  return undefined;
}

/**
 * Find the nearest cascade self-or-ancestor for menu visibility and
 * removal, even when a non-cascade own entry wins row rendering.
 */
export function findNearestCascade(
  path: string,
  index: ReadonlyMap<string, BlobHighlight>,
): { path: string; color: string } | undefined {
  const ownHighlight = index.get(path);
  if (ownHighlight?.cascade === true) {
    return { path, color: ownHighlight.color };
  }

  for (const ancestorPath of ancestorPaths(path)) {
    const ancestorHighlight = index.get(ancestorPath);
    if (ancestorHighlight?.cascade === true) {
      return { path: ancestorPath, color: ancestorHighlight.color };
    }
  }

  return undefined;
}

function ancestorPaths(path: string): string[] {
  if (path === '$') {
    return [];
  }

  const segmentEnds = canonicalSegmentEndIndexes(path);
  if (segmentEnds.length === 0) {
    return [];
  }

  const ancestors: string[] = [];
  for (let index = segmentEnds.length - 2; index >= 0; index -= 1) {
    ancestors.push(path.slice(0, segmentEnds[index]));
  }
  ancestors.push('$');
  return ancestors;
}

function canonicalSegmentEndIndexes(path: string): number[] {
  if (!path.startsWith('$')) {
    return [];
  }

  const segmentEnds: number[] = [];
  let cursor = 1;
  while (cursor < path.length) {
    const segmentStart = path[cursor];
    if (segmentStart === '.') {
      cursor = scanDotSegment(path, cursor + 1);
      segmentEnds.push(cursor);
      continue;
    }
    if (segmentStart === '[') {
      cursor = scanBracketSegment(path, cursor + 1);
      segmentEnds.push(cursor);
      continue;
    }
    break;
  }
  return segmentEnds;
}

function scanDotSegment(path: string, cursor: number): number {
  while (cursor < path.length && path[cursor] !== '.' && path[cursor] !== '[') {
    cursor += 1;
  }
  return cursor;
}

function scanBracketSegment(path: string, cursor: number): number {
  let insideString = false;
  let escaped = false;

  while (cursor < path.length) {
    const character = path[cursor];
    if (insideString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        insideString = false;
      }
    } else if (character === '"') {
      insideString = true;
    } else if (character === ']') {
      return cursor + 1;
    }
    cursor += 1;
  }

  return path.length;
}
