/**
 * Ambient declarations for the writable subset of the W3C File System
 * Access API used by `FileAccessService` (`core/upload/file-access.service.ts`):
 * `Window.showOpenFilePicker`, `Window.showSaveFilePicker`, and the
 * `queryPermission` / `requestPermission` methods on `FileSystemHandle`.
 *
 * `FileSystemFileHandle` and `createWritable()` are already in
 * `lib.dom.d.ts` so they aren't re-declared here. The picker entry
 * points and the permission-query/request methods are NOT in stable
 * lib.dom.d.ts (TS 5.x), so the surface is declared here as the single
 * source of truth, avoiding inline `Window` / `FileSystemHandle` casts
 * in service code.
 *
 * Spec: https://wicg.github.io/file-system-access/
 * MDN:  https://developer.mozilla.org/docs/Web/API/Window/showOpenFilePicker
 *       https://developer.mozilla.org/docs/Web/API/Window/showSaveFilePicker
 *       https://developer.mozilla.org/docs/Web/API/FileSystemHandle/queryPermission
 *       https://developer.mozilla.org/docs/Web/API/FileSystemHandle/requestPermission
 *
 * Chromium-only. Firefox and Safari leave the picker entry points
 * undefined and do not implement permission query/request on handles.
 * `FileAccessService.hasFileSystemAccess()` checks for the picker
 * entry points before invoking any of the surface declared here.
 */

interface FilePickerAcceptType {
  readonly description?: string;
  readonly accept: Readonly<Record<string, readonly string[] | string>>;
}

interface FilePickerOptions {
  readonly types?: readonly FilePickerAcceptType[];
  readonly excludeAcceptAllOption?: boolean;
  readonly id?: string;
  readonly startIn?:
    | FileSystemHandle
    | 'desktop'
    | 'documents'
    | 'downloads'
    | 'music'
    | 'pictures'
    | 'videos';
}

interface OpenFilePickerOptions extends FilePickerOptions {
  readonly multiple?: boolean;
}

interface SaveFilePickerOptions extends FilePickerOptions {
  readonly suggestedName?: string;
}

interface FileSystemHandlePermissionDescriptor {
  readonly mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface Window {
  showOpenFilePicker?(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
}
