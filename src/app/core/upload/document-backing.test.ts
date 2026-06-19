import type { BlobHighlight, JsonBlob } from '../api/models';
import {
  DRAFT_BACKING,
  type DocumentBacking,
  type LoadedSnapshot,
  getSavedSnapshot,
  isBlobBacking,
  isDraftBacking,
  isFileBacking,
} from './document-backing';

function makeBlob(overrides: Partial<JsonBlob> = {}): JsonBlob {
  return {
    id: 'blob-1',
    slug: 'abc123',
    content: '{"k":1}',
    title: 'Example',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ownerId: 'user-1',
    highlights: [],
    version: 1,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<LoadedSnapshot> = {}): LoadedSnapshot {
  const defaults: LoadedSnapshot = {
    content: '{"k":1}',
    title: 'Example',
    highlights: [] as readonly BlobHighlight[],
  };
  return { ...defaults, ...overrides };
}

function makeFileHandle(): FileSystemFileHandle {
  // The unit tests only need the type-system surface; the underlying
  // browser handle's behavior isn't exercised here (see file-access
  // service tests for I/O coverage).
  return {
    kind: 'file' as const,
    name: 'data.json',
  } as unknown as FileSystemFileHandle;
}

describe('DocumentBacking', () => {
  describe('DRAFT_BACKING', () => {
    it('has kind "draft"', () => {
      expect(DRAFT_BACKING.kind).toBe('draft');
    });

    it('is a stable reference across reads', () => {
      const a: DocumentBacking = DRAFT_BACKING;
      const b: DocumentBacking = DRAFT_BACKING;
      expect(a).toBe(b);
    });
  });

  describe('isDraftBacking', () => {
    it('returns true for the draft variant', () => {
      expect(isDraftBacking(DRAFT_BACKING)).toBe(true);
    });

    it('returns false for the blob variant', () => {
      const backing: DocumentBacking = {
        kind: 'blob',
        blob: makeBlob(),
        savedSnapshot: makeSnapshot(),
      };
      expect(isDraftBacking(backing)).toBe(false);
    });

    it('returns false for the file variant', () => {
      const backing: DocumentBacking = {
        kind: 'file',
        handle: makeFileHandle(),
        filename: 'data.json',
        lastModifiedKnown: 1_700_000_000_000,
        savedSnapshot: makeSnapshot(),
      };
      expect(isDraftBacking(backing)).toBe(false);
    });
  });

  describe('isBlobBacking', () => {
    it('returns true for the blob variant', () => {
      const backing: DocumentBacking = {
        kind: 'blob',
        blob: makeBlob(),
        savedSnapshot: makeSnapshot(),
      };
      expect(isBlobBacking(backing)).toBe(true);
    });

    it('returns false for the draft variant', () => {
      expect(isBlobBacking(DRAFT_BACKING)).toBe(false);
    });

    it('returns false for the file variant', () => {
      const backing: DocumentBacking = {
        kind: 'file',
        handle: makeFileHandle(),
        filename: 'data.json',
        lastModifiedKnown: 1_700_000_000_000,
        savedSnapshot: makeSnapshot(),
      };
      expect(isBlobBacking(backing)).toBe(false);
    });
  });

  describe('isFileBacking', () => {
    it('returns true for the file variant', () => {
      const backing: DocumentBacking = {
        kind: 'file',
        handle: makeFileHandle(),
        filename: 'data.json',
        lastModifiedKnown: 1_700_000_000_000,
        savedSnapshot: makeSnapshot(),
      };
      expect(isFileBacking(backing)).toBe(true);
    });

    it('returns false for the draft variant', () => {
      expect(isFileBacking(DRAFT_BACKING)).toBe(false);
    });

    it('returns false for the blob variant', () => {
      const backing: DocumentBacking = {
        kind: 'blob',
        blob: makeBlob(),
        savedSnapshot: makeSnapshot(),
      };
      expect(isFileBacking(backing)).toBe(false);
    });
  });

  describe('getSavedSnapshot', () => {
    it('returns null for the draft variant', () => {
      expect(getSavedSnapshot(DRAFT_BACKING)).toBeNull();
    });

    it('returns the snapshot for the blob variant', () => {
      const snapshot = makeSnapshot({ title: 'Hi' });
      const backing: DocumentBacking = {
        kind: 'blob',
        blob: makeBlob(),
        savedSnapshot: snapshot,
      };
      expect(getSavedSnapshot(backing)).toBe(snapshot);
    });

    it('returns the snapshot for the file variant', () => {
      const snapshot = makeSnapshot({ content: '{"new":true}' });
      const backing: DocumentBacking = {
        kind: 'file',
        handle: makeFileHandle(),
        filename: 'data.json',
        lastModifiedKnown: 1_700_000_000_000,
        savedSnapshot: snapshot,
      };
      expect(getSavedSnapshot(backing)).toBe(snapshot);
    });
  });

  describe('exhaustiveness', () => {
    // Compile-time guard: if a new variant is added to `DocumentBacking`,
    // the `never` fallthrough below stops being assignable and TypeScript
    // surfaces the missing case. The throw makes the runtime trap loud
    // if a future caller manages to construct an unknown shape via
    // `as unknown as DocumentBacking`.
    function exhaustiveSwitch(backing: DocumentBacking): string {
      switch (backing.kind) {
        case 'draft':
          return 'draft';
        case 'blob':
          return 'blob';
        case 'file':
          return 'file';
        default: {
          const unreachable: never = backing;
          throw new Error(`Unhandled DocumentBacking kind: ${JSON.stringify(unreachable)}`);
        }
      }
    }

    it('handles all three kinds', () => {
      expect(exhaustiveSwitch(DRAFT_BACKING)).toBe('draft');
      expect(
        exhaustiveSwitch({
          kind: 'blob',
          blob: makeBlob(),
          savedSnapshot: makeSnapshot(),
        }),
      ).toBe('blob');
      expect(
        exhaustiveSwitch({
          kind: 'file',
          handle: makeFileHandle(),
          filename: 'data.json',
          lastModifiedKnown: 1_700_000_000_000,
          savedSnapshot: makeSnapshot(),
        }),
      ).toBe('file');
    });
  });
});
