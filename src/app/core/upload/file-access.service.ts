import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, inject } from '@angular/core';

/**
 * Closed-enum failure causes thrown by {@link FileAccessService}. Each
 * value maps to a distinct user-visible snackbar message and a distinct
 * `file.save.failed` telemetry bucket (see DESIGN_SPEC.md telemetry).
 *
 * - **`'permissionDeniedInitial'`**: the user denied the first
 *   `requestPermission({mode:'readwrite'})` prompt for a handle that
 *   previously held no permission. Distinct from `Revoked` so we can
 *   tell "the user said no when we asked" from "the user said no
 *   later via the lock icon".
 * - **`'permissionDeniedRevoked'`**: a write attempt threw
 *   `NotAllowedError` after the user had previously granted
 *   permission. Either the browser auto-expired the grant or the user
 *   revoked via the lock icon.
 * - **`'aborted'`**: distinguishes a non-cancel `AbortError` thrown
 *   during the write operation (rare; e.g., the underlying writable
 *   stream was aborted). The user-cancel path on
 *   `showOpenFilePicker` / `showSaveFilePicker` resolves to `null`
 *   instead, since cancel is not an error condition.
 * - **`'notFound'`**: the underlying file no longer exists on disk
 *   (renamed, deleted, or unmounted between open and write). Maps to
 *   `NotFoundError`.
 * - **`'diskFull'`**: out-of-space write. Maps to
 *   `QuotaExceededError`.
 * - **`'writeError'`**: catch-all for any other failure during write.
 *   The original cause is preserved on the standard `Error.cause`
 *   field (set via the Error constructor's options bag) for log
 *   inspection but not surfaced to the user.
 * - **`'noHandle'`**: defensive bucket for a caller that asks to save
 *   without first attaching a handle. Should never fire in production
 *   if `HomeComponent.onSave` correctly gates on
 *   `documentBacking().kind === 'file'`.
 * - **`'unsupportedBrowser'`**: a picker entry point was requested on
 *   a browser without `showOpenFilePicker` / `showSaveFilePicker`
 *   (Safari, Firefox). Caller should fall back to the
 *   `<input type="file">` / `<a download>` paths.
 */
export type FileAccessFailureCause =
  | 'permissionDeniedInitial'
  | 'permissionDeniedRevoked'
  | 'aborted'
  | 'notFound'
  | 'diskFull'
  | 'writeError'
  | 'noHandle'
  | 'unsupportedBrowser';

/**
 * Typed error thrown by {@link FileAccessService} for all non-cancel
 * failures. Consumers (e.g., `HomeComponent.onSave`) `instanceof`-check
 * + switch on `kind` to map to user-facing snackbars and telemetry.
 *
 * The discriminator field is named `kind` to avoid shadowing
 * `Error.cause` (ES2022), which carries the underlying error chain
 * passed via the constructor's options bag.
 *
 * User-cancel on the file pickers does NOT throw this error -- the
 * relevant methods resolve to `null` instead, so the cancel case can
 * be distinguished from a real failure without a try/catch around an
 * `AbortError` check.
 */
export class FileAccessError extends Error {
  constructor(
    public readonly kind: FileAccessFailureCause,
    message?: string,
    cause?: unknown,
  ) {
    super(message ?? kind, cause !== undefined ? { cause } : undefined);
    this.name = 'FileAccessError';
  }
}

/**
 * Result of a successful local-file open via {@link FileAccessService.openLocalFile}.
 * Mirrors the `(file, handle)` shape that `LaunchQueueController`
 * delivers via `LaunchEvent.entries[i]`, so the three adoption paths
 * (osLaunch / picker / drag-drop) feed into one uniform consumer
 * pipeline (the new `kind: 'file'` `DocumentBacking` variant).
 */
export interface OpenLocalFileResult {
  readonly file: File;
  readonly handle: FileSystemFileHandle;
}

/**
 * Result of a successful Save-As via {@link FileAccessService.saveAsNewFile}.
 * Carries the freshly-created handle plus the post-write `lastModified`
 * stamp so callers can persist both onto a fresh `kind: 'file'` backing
 * variant.
 */
export interface SaveAsNewFileResult {
  readonly file: File;
  readonly handle: FileSystemFileHandle;
  readonly lastModified: number;
}

/**
 * Result of a successful in-place save via {@link FileAccessService.saveToFile}.
 * Callers refresh `documentBacking.savedSnapshot` after this resolves to
 * mark the document clean.
 */
export interface SaveToFileResult {
  readonly lastModified: number;
}

/**
 * The MIME + extension dict the JotJSON file pickers accept.
 *
 * Mirrors `public/manifest.webmanifest`'s `file_handlers[0].accept`
 * key-for-key (PR #389 + Phase 5 of M-PWA-write-back): same MIME
 * assignments for `.json`, `.jsonc`, `.json5`, `.webmanifest` so the
 * Chromium in-app picker filter offers the same extension set as
 * the OS file-association launch path. A user reaching for "the JSON
 * file I just edited via Open With" should not see a different
 * extension list in the toolbar Upload picker.
 *
 * `.jsonc` is registered under `text/plain` (matching the manifest)
 * rather than `application/json` because `application/json` strictly
 * disallows comments per RFC 8259; modern Chromium honors the MIME
 * key when filtering picker results, and folding `.jsonc` into the
 * `application/json` entry would cause the picker UI to list `.jsonc`
 * inconsistently with the OS-level file-type description.
 *
 * `description` is provided per accept entry so the picker's "file
 * type" selector reads as a human label rather than the bare MIME.
 *
 * Extension lists are typed as mutable arrays because the
 * `FilePickerAcceptType.accept` ambient signature accepts either a
 * single string or a string array, and a `readonly` array trips its
 * variance check.
 */
const ACCEPT_TYPES: readonly FilePickerAcceptType[] = [
  {
    description: 'JSON',
    accept: {
      'application/json': ['.json'],
      'text/plain': ['.jsonc'],
      'application/json5': ['.json5'],
      'application/manifest+json': ['.webmanifest'],
    },
  },
];

/**
 * Stateless wrapper around the W3C File System Access API write surface.
 *
 * The handle is **never** stored on the service. Methods take the handle
 * as a parameter; the canonical home for the writable handle is
 * `HomeComponent.documentBacking().kind === 'file'.handle` (see
 * `core/upload/document-backing.ts`). This avoids the parallel-tracking
 * smell where the union variant's `handle` field would coexist with a
 * service-side `currentHandle()` signal as two sources of the same
 * truth.
 *
 * Permission UX policy (see `DESIGN_SPEC.md` PWA Local file editing
 * write-back section, post-M-PWA-write-back):
 *
 * - **Picker / drag-drop adoption** (`openLocalFile`,
 *   `saveAsNewFile`): proactively call `requestPermission({mode:
 *   'readwrite'})` while the user's gesture (click on Upload, click
 *   in Save-As picker, drop event) is still fresh. The prompt fires
 *   once at open; subsequent Save is silent.
 * - **osLaunch adoption**: the OS click gesture is consumed by the
 *   browser before our consumer fires; we cannot call
 *   `requestPermission` inside it. The caller defers via
 *   {@link requestWritePermission} which `HomeComponent.onSave`
 *   invokes inside the Save-click handler.
 *
 * In all paths, `createWritable()` itself enforces the permission
 * gate: it throws `NotAllowedError` when readwrite has not been
 * granted, which `saveToFile` maps to the closed-enum
 * `'permissionDeniedRevoked'` cause. We deliberately do NOT
 * pre-query permission on the save path -- the spec-defined throw
 * is sufficient and skipping the query keeps a successful save to
 * one round-trip. A revoked grant therefore surfaces at the moment
 * of write rather than as a separate pre-check.
 *
 * Server-platform safety: the constructor performs NO `window.*`,
 * `navigator.*`, or DOM access. Feature-detect predicates live in
 * lazily-called methods. Verified by an explicit
 * `PLATFORM_ID: 'server'` injection test.
 */
@Injectable({ providedIn: 'root' })
export class FileAccessService {
  private readonly platformId = inject(PLATFORM_ID);

  /**
   * Feature-detect: returns `true` only on a browser platform with both
   * `showOpenFilePicker` and `showSaveFilePicker` available
   * (Chromium-derived browsers when the PWA is installed or running in
   * a regular tab over HTTPS). Returns `false` on the server platform,
   * on Safari/Firefox, and on Chromium with the API disabled (e.g.,
   * cross-origin iframe).
   */
  hasFileSystemAccess(): boolean {
    if (!isPlatformBrowser(this.platformId)) return false;
    if (typeof window === 'undefined') return false;
    return (
      typeof window.showOpenFilePicker === 'function' &&
      typeof window.showSaveFilePicker === 'function'
    );
  }

  /**
   * Opens the OS file picker for a `.json` / `.jsonc` / `.json5` /
   * `.webmanifest` file. The W3C `OpenFilePickerOptions` does NOT
   * carry a `mode` member (that's `showSaveFilePicker`'s surface);
   * `showOpenFilePicker` always resolves with read-permission
   * handles, and we upgrade to readwrite immediately after by
   * calling `handle.requestPermission({mode: 'readwrite'})` inside
   * the same user gesture so the first Save is silent. See
   * {@link adoptHandleWithWritePermission} for the post-pick step.
   *
   * Resolves `null` if the user cancels the picker (`AbortError`).
   * Throws `FileAccessError`:
   * - `'unsupportedBrowser'` if {@link hasFileSystemAccess} is false.
   * - `'permissionDeniedInitial'` if the user denies the
   *   `requestPermission` prompt.
   * - `'writeError'` for any other failure (with the original cause
   *   on `Error.cause`).
   */
  async openLocalFile(): Promise<OpenLocalFileResult | null> {
    if (!this.hasFileSystemAccess()) {
      throw new FileAccessError(
        'unsupportedBrowser',
        'File System Access API unavailable in this browser',
      );
    }
    let handle: FileSystemFileHandle;
    try {
      const handles = await window.showOpenFilePicker!({
        types: ACCEPT_TYPES,
        multiple: false,
      });
      const first = handles[0];
      if (first === undefined) {
        return null;
      }
      handle = first;
    } catch (cause) {
      if (isAbortError(cause)) return null;
      throw new FileAccessError('writeError', undefined, cause);
    }
    return await this.adoptHandleWithWritePermission(handle);
  }

  /**
   * Queries the handle's current write permission and, if not granted,
   * issues `requestPermission({mode: 'readwrite'})`. Resolves with the
   * final permission state. Callers in the deferred-at-save path
   * (osLaunch) invoke this inside the Save-click gesture so the prompt
   * can fire.
   *
   * Does NOT throw. The caller maps the resolved state to a snackbar
   * (`'denied'` -> show "permission denied + Save as new file..."
   * action button; `'prompt'` should not occur after `requestPermission`
   * resolves but is handled defensively).
   */
  async requestWritePermission(handle: FileSystemFileHandle): Promise<PermissionState> {
    const queried = await handle.queryPermission({ mode: 'readwrite' });
    if (queried === 'granted') return 'granted';
    return await handle.requestPermission({ mode: 'readwrite' });
  }

  /**
   * Writes `text` to the file behind `handle`. The write is atomic via
   * the browser's `createWritable` -> temp file -> `close` rename
   * pipeline; a crash mid-write does not corrupt the original.
   *
   * Resolves `{ lastModified }` for the post-write `File.lastModified`
   * stamp; the caller refreshes `documentBacking.savedSnapshot` so the
   * `dirty` computed flips to `false`.
   *
   * Throws `FileAccessError` for any failure:
   * - `'permissionDeniedRevoked'` on `NotAllowedError`
   * - `'notFound'` on `NotFoundError`
   * - `'diskFull'` on `QuotaExceededError`
   * - `'aborted'` on `AbortError`
   * - `'writeError'` otherwise (original cause on `Error.cause`)
   *
   * Does NOT proactively call `requestPermission`. Callers in the
   * deferred path are expected to call {@link requestWritePermission}
   * first (HomeComponent.onSave does this for `kind: 'file'` backings
   * adopted via osLaunch); the proactive path
   * ({@link openLocalFile}, {@link saveAsNewFile}) requested at
   * adoption time, so the permission is already granted here.
   */
  async saveToFile(handle: FileSystemFileHandle, text: string): Promise<SaveToFileResult> {
    let writable: FileSystemWritableFileStream;
    try {
      writable = await handle.createWritable();
    } catch (cause) {
      throw this.mapDomError(cause);
    }
    try {
      await writable.write(text);
      await writable.close();
    } catch (cause) {
      // The writable may already be closed by the browser when an error
      // fires from write/close; abort() is best-effort.
      try {
        await writable.abort();
      } catch {
        // ignore
      }
      throw this.mapDomError(cause);
    }
    let file: File;
    try {
      file = await handle.getFile();
    } catch (cause) {
      // We successfully closed the write, so the file was written. We
      // just couldn't re-read its metadata. Fall back to `Date.now()`
      // for the returned timestamp; the dirty flip is more important
      // than a precise lastModified.
      void cause;
      return { lastModified: Date.now() };
    }
    return { lastModified: file.lastModified };
  }

  /**
   * Opens the OS Save-As picker with `suggestedName`, then immediately
   * writes `text` to the new handle. Proactively requests write
   * permission inside the picker gesture so the first save is silent.
   *
   * Resolves `null` if the user cancels the picker. Throws
   * `FileAccessError` with the same cause set as {@link saveToFile}
   * for any other failure.
   */
  async saveAsNewFile(text: string, suggestedName: string): Promise<SaveAsNewFileResult | null> {
    if (!this.hasFileSystemAccess()) {
      throw new FileAccessError(
        'unsupportedBrowser',
        'File System Access API unavailable in this browser',
      );
    }
    let handle: FileSystemFileHandle;
    try {
      handle = await window.showSaveFilePicker!({
        types: ACCEPT_TYPES,
        suggestedName,
      });
    } catch (cause) {
      if (isAbortError(cause)) return null;
      throw new FileAccessError('writeError', undefined, cause);
    }
    // The save picker grants readwrite as part of the gesture; verify
    // and request defensively (the spec allows the UA to defer the
    // grant in some edge cases).
    const permission = await this.requestWritePermission(handle);
    if (permission !== 'granted') {
      throw new FileAccessError(
        'permissionDeniedInitial',
        'User denied write permission for the newly chosen file',
      );
    }
    const { lastModified } = await this.saveToFile(handle, text);
    let file: File;
    try {
      file = await handle.getFile();
    } catch (cause) {
      throw this.mapDomError(cause);
    }
    return { file, handle, lastModified };
  }

  private async adoptHandleWithWritePermission(
    handle: FileSystemFileHandle,
  ): Promise<OpenLocalFileResult> {
    const permission = await this.requestWritePermission(handle);
    if (permission !== 'granted') {
      throw new FileAccessError(
        'permissionDeniedInitial',
        'User denied write permission for the chosen file',
      );
    }
    let file: File;
    try {
      file = await handle.getFile();
    } catch (cause) {
      throw this.mapDomError(cause);
    }
    return { file, handle };
  }

  private mapDomError(cause: unknown): FileAccessError {
    if (cause instanceof DOMException) {
      switch (cause.name) {
        case 'NotAllowedError':
          return new FileAccessError('permissionDeniedRevoked', cause.message, cause);
        case 'NotFoundError':
          return new FileAccessError('notFound', cause.message, cause);
        case 'QuotaExceededError':
          return new FileAccessError('diskFull', cause.message, cause);
        case 'AbortError':
          return new FileAccessError('aborted', cause.message, cause);
      }
    }
    return new FileAccessError('writeError', undefined, cause);
  }
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError';
}
