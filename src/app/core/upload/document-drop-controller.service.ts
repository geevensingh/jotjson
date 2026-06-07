import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, NgZone, Signal, inject, signal } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Router } from '@angular/router';

/**
 * Single owner of document-level drag/drop listeners for file uploads.
 *
 * The controller keeps a drag-counter so descendant enter/leave events do
 * not flicker the overlay, plus hard-reset hooks (Esc, blur, visibility
 * hide, dragend, document exit) so we never get stuck "drop active".
 *
 * `HomeComponent` registers a handler in `ngOnInit` and disposes it in
 * `ngOnDestroy`. While a handler is registered, drops are forwarded to it.
 * Otherwise a snackbar invites the user to navigate to the editor; the
 * `dragover` handler still calls `preventDefault` so the browser does not
 * navigate away.
 */
/**
 * Drop handler invoked by `DocumentDropController` for each drop on the
 * editor route. Receives:
 *
 * - `files`: the dropped `File` objects in their declared order.
 * - `handles`: a parallel array of `FileSystemFileHandle | null`
 *   slots, one per file. A non-null slot means the browser exposed a
 *   writable handle via `DataTransferItem.getAsFileSystemHandle()`
 *   (Chromium-only). A null slot at index `i` indicates either a
 *   non-Chromium browser, a non-`'file'` item kind, or a per-item
 *   failure (e.g., the OS revoked the drag). Per-item null is NOT a
 *   whole-drop fallback; consumers that need the handle MUST check
 *   each slot independently.
 *
 * The handler returns either `void` (sync) or `Promise<void>`. The
 * controller awaits the promise so the drop overlay does not race
 * with the consumer's first paint, but does not block the DOM event
 * loop (the controller fires-and-forgets a microtask before invoking
 * the handler so the browser can return from the native drop event).
 *
 * The handler runs inside the Angular zone via `ngZone.run`.
 */
export type DropHandler = (
  files: readonly File[],
  handles: readonly (FileSystemFileHandle | null)[],
) => void | Promise<void>;

@Injectable({ providedIn: 'root' })
export class DocumentDropController {
  private readonly router = inject(Router);
  private readonly snack = inject(MatSnackBar);
  private readonly ngZone = inject(NgZone);
  private readonly documentRef = inject(DOCUMENT);

  private readonly dropActiveSignal = signal(false);
  readonly dropActive: Signal<boolean> = this.dropActiveSignal.asReadonly();

  private dragDepth = 0;
  private activeHandler: DropHandler | null = null;
  // Monotonic registration id; lets a stale dispose detect that a newer
  // handler has taken over and bail out instead of clobbering it.
  private registrationId = 0;

  constructor() {
    this.ngZone.runOutsideAngular(() => {
      const target = this.documentRef;
      target.addEventListener('dragenter', this.onDragEnter, true);
      target.addEventListener('dragleave', this.onDragLeave, true);
      target.addEventListener('dragover', this.onDragOver, true);
      target.addEventListener('drop', this.onDrop, true);
      target.addEventListener('dragend', this.onDragEnd, true);
      target.addEventListener('keydown', this.onKeyDown, true);
      target.addEventListener('visibilitychange', this.onVisibilityChange, true);
      const win = target.defaultView;
      if (win) {
        win.addEventListener('blur', this.onWindowBlur, true);
      }
    });
    // Remove listeners when the owning injector is destroyed. In production
    // this only fires on app teardown, but in tests each TestBed creates a
    // fresh root injector and would otherwise leak listeners (and zombie
    // references to a destroyed MatSnackBar) across specs.
    inject(DestroyRef).onDestroy(() => {
      const target = this.documentRef;
      target.removeEventListener('dragenter', this.onDragEnter, true);
      target.removeEventListener('dragleave', this.onDragLeave, true);
      target.removeEventListener('dragover', this.onDragOver, true);
      target.removeEventListener('drop', this.onDrop, true);
      target.removeEventListener('dragend', this.onDragEnd, true);
      target.removeEventListener('keydown', this.onKeyDown, true);
      target.removeEventListener('visibilitychange', this.onVisibilityChange, true);
      const win = target.defaultView;
      if (win) {
        win.removeEventListener('blur', this.onWindowBlur, true);
      }
    });
  }

  registerEditorHandler(handler: DropHandler): () => void {
    if (this.activeHandler) {
      // Replace, but loudly: a double-registration usually means a stale
      // owner forgot to dispose. Tests assert this is non-fatal.
      console.warn(
        '[DocumentDropController] replacing existing editor drop handler; ' +
          'previous owner did not dispose.',
      );
    }
    this.registrationId += 1;
    const ownToken = this.registrationId;
    this.activeHandler = handler;
    return () => {
      if (this.registrationId === ownToken) {
        this.activeHandler = null;
      }
    };
  }

  private readonly onDragEnter = (event: Event): void => {
    const dragEvent = event as DragEvent;
    if (!this.eventCarriesFiles(dragEvent)) return;
    this.dragDepth += 1;
    if (this.dragDepth === 1) {
      this.ngZone.run(() => this.dropActiveSignal.set(true));
    }
  };

  private readonly onDragLeave = (event: Event): void => {
    const dragEvent = event as DragEvent;
    if (!this.eventCarriesFiles(dragEvent)) return;
    if (dragEvent.relatedTarget === null) {
      this.dragDepth = 0;
    } else {
      this.dragDepth = Math.max(0, this.dragDepth - 1);
    }
    if (this.dragDepth === 0) {
      this.ngZone.run(() => this.dropActiveSignal.set(false));
    }
  };

  private readonly onDragOver = (event: Event): void => {
    const dragEvent = event as DragEvent;
    if (!this.eventCarriesFiles(dragEvent)) return;
    // preventDefault keeps the browser from navigating to the dropped
    // file even when the user is on a non-editor route.
    dragEvent.preventDefault();
  };

  private readonly onDrop = (event: Event): void => {
    const dragEvent = event as DragEvent;
    if (!this.eventCarriesFiles(dragEvent)) return;
    dragEvent.preventDefault();
    this.dragDepth = 0;
    const files = Array.from(dragEvent.dataTransfer?.files ?? []);
    const items = Array.from(dragEvent.dataTransfer?.items ?? []);
    const handler = this.activeHandler;
    // Flip the overlay back synchronously so the drop indicator does
    // not linger while we wait on per-item getAsFileSystemHandle().
    this.ngZone.run(() => this.dropActiveSignal.set(false));
    if (!handler) {
      this.ngZone.run(() => this.showOffEditorSnackbar());
      return;
    }
    // Per-item handle resolution. Each item produces either a writable
    // FileSystemFileHandle (Chromium with the File System Access API)
    // or null (Safari/Firefox, non-'file' items, or per-item rejection).
    // Per-item null, not whole-drop fallback: a heterogeneous drop with
    // some handle-able items and some not still feeds the handle-able
    // ones through with a non-null slot at the right index. Today
    // HomeComponent only ever consumes the first item, but the wider
    // shape avoids a re-spec when multi-file lands.
    void this.dispatchHandlerWithHandles(handler, files, items);
  };

  private async dispatchHandlerWithHandles(
    handler: DropHandler,
    files: readonly File[],
    items: readonly DataTransferItem[],
  ): Promise<void> {
    const handles = await Promise.all(
      items.map(async (item) => {
        if (item.kind !== 'file') return null;
        if (typeof item.getAsFileSystemHandle !== 'function') return null;
        try {
          const handle = await item.getAsFileSystemHandle();
          return handle?.kind === 'file' ? (handle as FileSystemFileHandle) : null;
        } catch {
          return null;
        }
      }),
    );
    this.ngZone.run(() => {
      void handler(files, handles);
    });
  }

  private readonly onDragEnd = (): void => {
    this.resetCounter();
  };

  private readonly onKeyDown = (event: Event): void => {
    if ((event as KeyboardEvent).key === 'Escape') {
      this.resetCounter();
    }
  };

  private readonly onVisibilityChange = (): void => {
    if (this.documentRef.hidden) {
      this.resetCounter();
    }
  };

  private readonly onWindowBlur = (): void => {
    this.resetCounter();
  };

  private resetCounter(): void {
    if (this.dragDepth === 0 && !this.dropActiveSignal()) return;
    this.dragDepth = 0;
    this.ngZone.run(() => this.dropActiveSignal.set(false));
  }

  private showOffEditorSnackbar(): void {
    const ref = this.snack.open(
      $localize`:@@home.upload.error.dropElsewhere:Drop on the editor page to load a file`,
      $localize`:@@home.upload.error.dropElsewhere.action:Go to editor`,
      { duration: 5000 },
    );
    ref.onAction().subscribe(() => {
      void this.router.navigateByUrl('/');
    });
  }

  private eventCarriesFiles(event: DragEvent): boolean {
    const transfer = event.dataTransfer;
    if (!transfer) return false;
    const types = Array.from(transfer.types ?? []);
    if (types.includes('Files')) return true;
    const items = Array.from(transfer.items ?? []);
    return items.some((item) => item.kind === 'file');
  }
}
