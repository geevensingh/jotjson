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
export type DropHandler = (files: readonly File[]) => void;

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
          'previous owner did not dispose.'
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
    const handler = this.activeHandler;
    this.ngZone.run(() => {
      this.dropActiveSignal.set(false);
      if (handler) {
        handler(files);
      } else {
        this.showOffEditorSnackbar();
      }
    });
  };

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
      { duration: 5000 }
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
