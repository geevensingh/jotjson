import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { LoggerService } from '../telemetry/logger.service';

/**
 * Singleton consumer of the W3C Web App Manifest "Launch Handler" API.
 * Set-once at app boot under an `isPlatformBrowser` guard so the
 * `window.launchQueue.setConsumer(...)` registration cannot race with
 * component lifecycle (skeptic F3 in the M-PWA plan): if HomeComponent
 * is destroyed and re-created across `client_mode: 'navigate-new'`
 * tabs or during HMR, the launch consumer outlives the component and
 * always delivers to whichever handler is currently registered.
 *
 * Mirrors the `DocumentDropController` pattern. HomeComponent registers
 * a handler in `ngOnInit` and disposes it in `ngOnDestroy`. While a
 * handler is registered, OS launches are forwarded to it as
 * `LaunchEvent` tuples. While no handler is registered, launches are
 * dropped silently (the toolbar Upload / drag-drop entry points are
 * still available and don't depend on this controller).
 *
 * Prerender safety: the constructor's `isPlatformBrowser` check ensures
 * `window.launchQueue` is never touched on the server platform; on the
 * server / non-Chromium browsers / non-installed Chromium the
 * controller is a no-op (advocate A3 + skeptic F9).
 *
 * Edge cases documented in step 12 of the M-PWA plan:
 * - **HMR dev-only**: a stale `setConsumer` closure may outlive a
 *   module swap. Benign (dev console only) - the rebuilt module
 *   creates a fresh service instance and the old closure is GC'd
 *   when the page is reloaded.
 * - **File renamed / deleted between OS click and PWA focus**:
 *   caught by the `getFile()` reject branch; surfaces the
 *   `home.osLaunch.error.unreadable` snackbar via the `error` event.
 * - **`.txt` containing JSON via "Choose another -> JotJSON" override**:
 *   flows through unchanged; the existing `validateAndReadSingleFile`
 *   binary detector accepts text content and the snackbar reads
 *   "Opened config.txt." which is the correct behavior.
 * - **Multi-file launch**: short-circuited at the handle layer to
 *   avoid a permission-prompt flood; we deliver the first handle and
 *   the downstream `tooMany` validator never gets a chance to trip.
 */
/**
 * A single file delivered by the launch queue: the resolved `File` (read
 * via `handle.getFile()`) paired with the originating writable handle.
 * `handle` is the W3C File System Access API entry point for write-back;
 * downstream consumers persist it on the `DocumentBacking` union variant
 * for the editor document (see `core/upload/document-backing.ts`).
 *
 * `handle` is **non-null in production** for launchQueue deliveries (the
 * controller obtained the File by calling `handle.getFile()`, so the
 * handle must exist), but the type is `FileSystemFileHandle | null` to
 * mirror the shape used by the drop-controller's per-item handle slot
 * (see `DocumentDropController.DropHandler`) so consumers have one
 * uniform `(file, handle | null)` contract across all three adoption
 * paths: launchQueue, file picker, and drag-drop.
 *
 * Internal: kept un-exported until Phase 3 of M-PWA-write-back wires
 * `HomeComponent.onFilesReceived` to consume the handle. Inlined as a
 * named interface (rather than an anonymous tuple) so the JSDoc has a
 * home; flip to `export` when the first non-test cross-module consumer
 * lands.
 */
interface LaunchFileEntry {
  readonly file: File;
  readonly handle: FileSystemFileHandle | null;
}

export type LaunchEvent =
  | {
      kind: 'files';
      entries: readonly LaunchFileEntry[];
      /**
       * Echo of `LaunchParams.targetURL`, the URL the user navigated to
       * when the launch fired. Preserved for forward-compatibility with
       * launch_handler `client_mode` values other than `navigate-new`
       * (where the launch could land on a non-`/` deep link). Currently
       * always the home URL since the manifest declares
       * `file_handlers[].action: "/"`, but consumers should not assume.
       */
      targetURL: string;
    }
  | { kind: 'error'; cause: unknown };

export type LaunchHandler = (event: LaunchEvent) => void | Promise<void>;

@Injectable({ providedIn: 'root' })
export class LaunchQueueController {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly logger = inject(LoggerService);

  private activeHandler: LaunchHandler | null = null;
  // Monotonic registration id; lets a stale dispose detect that a
  // newer handler has taken over and bail out instead of clobbering
  // it (mirrors DocumentDropController stale-dispose safety).
  private registrationId = 0;

  constructor() {
    if (!isPlatformBrowser(this.platformId)) return;
    const launchQueue = window.launchQueue;
    if (!launchQueue) return;
    launchQueue.setConsumer((params) => {
      void this.handleLaunch(params);
    });
  }

  /**
   * Registers a handler for OS-launched file events. Returns a dispose
   * closure that clears the handler iff it is still the active one
   * (i.e., the closure is stale-safe: if a newer handler has been
   * registered, calling the closure is a no-op).
   *
   * A double-registration replaces the previous handler and emits a
   * console warning, mirroring `DocumentDropController` semantics. In
   * practice the only way this fires is a stale owner that forgot to
   * dispose.
   */
  registerHandler(handler: LaunchHandler): () => void {
    if (this.activeHandler) {
      console.warn(
        '[LaunchQueueController] replacing existing launch handler; ' +
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

  private async handleLaunch(params: LaunchParams): Promise<void> {
    const handles = params.files ?? [];
    if (handles.length === 0) return;
    // Short-circuit multi-file at the handle layer to avoid the
    // permission-prompt flood (one prompt per `getFile()`). The
    // downstream upload validator would surface `tooMany` anyway;
    // truncating here keeps the user from re-confirming N prompts
    // just to land on an error snackbar.
    const handle = handles[0];
    try {
      const file = await handle.getFile();
      await this.deliver({
        kind: 'files',
        entries: [{ file, handle }],
        targetURL: params.targetURL,
      });
    } catch (cause) {
      this.logger.error('home.fileHandler.readFailed', cause);
      await this.deliver({ kind: 'error', cause });
    }
  }

  private async deliver(event: LaunchEvent): Promise<void> {
    const handler = this.activeHandler;
    if (!handler) return;
    await handler(event);
  }
}
