import type { BlobHighlight, JsonBlob } from '../api/models';

/**
 * The home-page editor document can be backed by one of three persistence
 * targets. This discriminated union is the single source of truth for which
 * one is active and the per-target metadata needed to compute dirty / save.
 *
 * - **`'draft'`**: anonymous or signed-in user editing with no persistence
 *   target. Save (when signed-in) creates a new blob.
 *
 * - **`'blob'`**: a saved server blob is loaded into the editor. `blob`
 *   holds the canonical document; `savedSnapshot` captures the
 *   content/title/highlights at load (or last successful save) time so the
 *   `dirty` computed can decide whether Save is meaningful. Save updates if
 *   `blob.ownerId === currentUser.id`; otherwise forks to a new blob.
 *
 * - **`'file'`**: a local file is bound to the editor via the File System
 *   Access API. `handle` is the writable `FileSystemFileHandle`; `filename`
 *   is its display name at attach time; `lastModifiedKnown` is the most
 *   recent `.lastModified` value we have observed for the file -- stamped
 *   at attach time and refreshed on every successful Save / Save as new
 *   file. It is a rolling "last-known on-disk timestamp", NOT a fixed
 *   attach-time baseline: comparing `await handle.getFile().lastModified`
 *   against it is the foundation for a future "file changed on disk by
 *   another editor" check, which only fires when the on-disk value
 *   exceeds the last value we wrote. `savedSnapshot` captures
 *   content/title/highlights at attach (or last successful save) time.
 *
 *   File-backed dirty is **content-only** by convention: highlight or
 *   title edits do not flip `dirty` and do not trigger Save writes,
 *   because the on-disk JSON file has no representation for them. This is
 *   enforced by `HomeComponent.dirty` reading only `savedSnapshot.content`
 *   when `kind === 'file'`. The `savedSnapshot.highlights` field on the
 *   `'file'` variant is the empty list at attach time and gets refreshed
 *   on save for shape uniformity with the other variants; it is not the
 *   source of truth for "what's persisted".
 *
 * Modeling these as a discriminated union (vs three nullable sibling
 * signals on HomeComponent + a fourth on LaunchQueueController) means
 * invalid combinations like "file-backed AND blob-loaded" are
 * unrepresentable at compile time; consumers exhaust on `kind` instead of
 * remembering to gate on `loadedBlob() === null && handle() === null`.
 */
export type DocumentBacking =
  | { readonly kind: 'draft' }
  | {
      readonly kind: 'blob';
      readonly blob: JsonBlob;
      readonly savedSnapshot: LoadedSnapshot;
    }
  | {
      readonly kind: 'file';
      readonly handle: FileSystemFileHandle;
      readonly filename: string;
      readonly lastModifiedKnown: number;
      readonly savedSnapshot: LoadedSnapshot;
    };

/**
 * Snapshot of the saved/last-known-clean editor state for `'blob'` and
 * `'file'` backings. Used by `HomeComponent.dirty` to detect divergence
 * from the persisted document. Hoisted here from `home.component.ts` so
 * the union (which references it) can live in `core/upload/` alongside the
 * services that produce backings.
 */
export interface LoadedSnapshot {
  readonly content: string;
  readonly title: string;
  readonly highlights: readonly BlobHighlight[];
}

/**
 * Shared instance for the draft variant. Construction is allocation-free
 * (the object literal is interned at module load), and callers can compare
 * by reference if they want a fast-path for "is this a fresh draft?".
 */
export const DRAFT_BACKING: DocumentBacking = { kind: 'draft' };

/** Narrow `DocumentBacking` to the `'draft'` variant. */
export function isDraftBacking(
  backing: DocumentBacking,
): backing is Extract<DocumentBacking, { kind: 'draft' }> {
  return backing.kind === 'draft';
}

/** Narrow `DocumentBacking` to the `'blob'` variant. */
export function isBlobBacking(
  backing: DocumentBacking,
): backing is Extract<DocumentBacking, { kind: 'blob' }> {
  return backing.kind === 'blob';
}

/** Narrow `DocumentBacking` to the `'file'` variant. */
export function isFileBacking(
  backing: DocumentBacking,
): backing is Extract<DocumentBacking, { kind: 'file' }> {
  return backing.kind === 'file';
}

/**
 * Returns the saved snapshot for any non-draft backing, or `null` for
 * `'draft'`. Centralizes the "do we have a baseline to compare against
 * for dirty?" check so consumers don't repeat the `kind` switch.
 */
export function getSavedSnapshot(backing: DocumentBacking): LoadedSnapshot | null {
  switch (backing.kind) {
    case 'draft':
      return null;
    case 'blob':
    case 'file':
      return backing.savedSnapshot;
  }
}
