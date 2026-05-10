import { DestroyRef, Injectable, OnDestroy, Signal, computed, inject, signal } from '@angular/core';

/**
 * Permission state for the clipboard-read capability.
 *
 * - `unsupported` - `navigator.clipboard` is not available in this browser
 *   (ancient browsers, insecure context). Paste falls back to Ctrl+V.
 * - `unknown` - `navigator.permissions.query({ name: 'clipboard-read' })`
 *   threw (Firefox) or is unavailable. Treated like `prompt`.
 * - `prompt` - user has not been asked yet; the banner should appear
 *   (unless already dismissed).
 * - `granted` - user allowed clipboard reads. Polling can run.
 * - `denied` - user denied OR an explicit user-gesture read failed with
 *   `NotAllowedError`. Button is disabled with an informational tooltip.
 */
export type ClipboardPermissionState = 'unsupported' | 'unknown' | 'prompt' | 'granted' | 'denied';

export type ClipboardGrantedReadResult = { ok: true; text: string } | { ok: false };

const POLL_INTERVAL_MS = 2000;
const PREVIEW_MAX_LENGTH = 80;

/**
 * Source of truth for the smart Paste button (DESIGN_SPEC.md §Smart Paste
 * Button). Owns the entire clipboard-read flow - callers never call
 * `navigator.clipboard.readText` directly.
 *
 * Permission handling is deliberately conservative:
 * - `NotAllowedError` is only treated as a real denial when it originates
 *   from a user gesture (`enable()` / `readForPaste()`). Background poll
 *   failures leave the state in `prompt`/`unknown` so we don't falsely
 *   downgrade Safari (no-gesture throws) or Firefox (permission model
 *   differs).
 * - After a successful `enable()`, the service flips state=granted
 *   directly without waiting on `PermissionStatus.onchange`, which may
 *   never fire.
 *
 * The clipboard contents are never logged, persisted, or transmitted;
 * only an 80-char `preview` signal is exposed to the UI, and it is
 * cleared on any state transition out of granted/hasJson.
 */
@Injectable({ providedIn: 'root' })
export class ClipboardPollingService implements OnDestroy {
  private readonly destroyRef = inject(DestroyRef);

  private readonly permissionStateSignal = signal<ClipboardPermissionState>(this.initialState());
  private readonly permissionReadySignal = signal<boolean>(!this.isSupported());
  private readonly hasJsonSignal = signal<boolean>(false);
  private readonly previewSignal = signal<string>('');

  readonly permissionState: Signal<ClipboardPermissionState> =
    this.permissionStateSignal.asReadonly();
  readonly permissionReady: Signal<boolean> = this.permissionReadySignal.asReadonly();
  readonly hasJson: Signal<boolean> = this.hasJsonSignal.asReadonly();
  readonly preview: Signal<string> = this.previewSignal.asReadonly();

  /**
   * Awaitable form of `permissionReady`. Resolves when the constructor's
   * async `queryPermission()` has settled (or synchronously when the
   * platform is unsupported). Callers that need to gate behavior on the
   * resolved permission state - for example, a cold-boot evaluator that
   * skips a splash hold when permission isn't `'granted'` - should await
   * this before reading `permissionState()`. Resolves once and is cheap
   * to await again afterwards.
   */
  awaitPermissionReady(): Promise<void> {
    return this.permissionDiscoveryPromise;
  }

  /**
   * Convenience: is the Paste button in its "has JSON" enabled state?
   * True only when state=granted AND the current clipboard parses as
   * JSON-like content.
   */
  readonly isReady = computed(
    () => this.permissionStateSignal() === 'granted' && this.hasJsonSignal(),
  );

  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private permissionStatus: PermissionStatus | null = null;
  private permissionDiscoveryPromise: Promise<void>;
  private inFlightGrantedReadPromise: Promise<ClipboardGrantedReadResult> | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => this.ngOnDestroy());
    this.permissionDiscoveryPromise = this.queryPermission();
  }

  ngOnDestroy(): void {
    this.stopPolling();
    if (this.permissionStatus) {
      const status = this.permissionStatus as PermissionStatus & {
        removeEventListener?: typeof EventTarget.prototype.removeEventListener;
      };
      status.removeEventListener?.('change', this.onPermissionChange);
      this.permissionStatus = null;
    }
  }

  /**
   * User-gesture entry point. Call from a button click handler to trigger
   * the browser's clipboard-read permission prompt. Returns the resulting
   * state so callers can decide whether to mark the banner dismissed.
   */
  async enable(): Promise<ClipboardPermissionState> {
    if (!this.isSupported()) {
      this.permissionStateSignal.set('unsupported');
      return 'unsupported';
    }
    try {
      const text = await navigator.clipboard.readText();
      this.permissionStateSignal.set('granted');
      this.applyText(text);
      this.startPolling();
      return 'granted';
    } catch (error) {
      if (this.isNotAllowedError(error)) {
        this.permissionStateSignal.set('denied');
        this.clearClipboardDerived();
      }
      return this.permissionStateSignal();
    }
  }

  /**
   * Single authoritative clipboard read for a Paste click. Performs one
   * `readText` call so the value we apply is the same one the smart-state
   * just evaluated (no double-read). Safe to call from any state; in
   * non-granted states it doubles as a user-gesture permission prompt.
   *
   * Returns the raw clipboard text, or `null` if it could not be read.
   */
  async readForPaste(): Promise<string | null> {
    if (!this.isSupported()) {
      this.permissionStateSignal.set('unsupported');
      return null;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (this.permissionStateSignal() !== 'granted') {
        this.permissionStateSignal.set('granted');
        this.startPolling();
      }
      this.applyText(text);
      return text;
    } catch (error) {
      if (this.isNotAllowedError(error)) {
        this.permissionStateSignal.set('denied');
        this.clearClipboardDerived();
      }
      return null;
    }
  }

  /**
   * Cold-boot read path used only after the initial permission discovery has
   * settled. Unlike user-gesture reads, background failures do not mark the
   * permission as denied.
   */
  readGrantedClipboardOnce(reason: 'coldBootAutoPaste'): Promise<ClipboardGrantedReadResult> {
    void reason;
    if (this.inFlightGrantedReadPromise) return this.inFlightGrantedReadPromise;

    const readPromise = this.readGrantedClipboardOnceInternal().finally(() => {
      if (this.inFlightGrantedReadPromise === readPromise) {
        this.inFlightGrantedReadPromise = null;
      }
    });
    this.inFlightGrantedReadPromise = readPromise;
    return readPromise;
  }

  /**
   * Idempotent. Does nothing when state !== granted or the tab is hidden.
   * Multiple calls coalesce into a single interval.
   */
  startPolling(): void {
    if (this.pollHandle !== null) return;
    if (this.permissionStateSignal() !== 'granted') return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }
    this.pollHandle = setInterval(() => void this.checkOnce(), POLL_INTERVAL_MS);
  }

  stopPolling(): void {
    if (this.pollHandle !== null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  /**
   * Read the clipboard once and update derived state. Intended for use
   * from focus/visibilitychange listeners and the polling interval.
   *
   * Failure handling is deliberately forgiving: we never promote to
   * `denied` from a background failure, because Safari throws without a
   * user gesture even when permission would be granted.
   */
  async checkOnce(): Promise<void> {
    if (!this.isSupported()) return;
    if (this.permissionStateSignal() === 'denied') return;
    try {
      const text = await navigator.clipboard.readText();
      if (this.permissionStateSignal() !== 'granted') {
        this.permissionStateSignal.set('granted');
      }
      this.applyText(text);
    } catch {
      // Swallow: `NotAllowedError` without a user gesture (Safari), or a
      // transient DOMException. Neither warrants promoting to denied.
      this.clearClipboardDerived();
    }
  }

  // --- Internals ----------------------------------------------------------

  private initialState(): ClipboardPermissionState {
    return this.isSupported() ? 'prompt' : 'unsupported';
  }

  private isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.clipboard &&
      typeof navigator.clipboard.readText === 'function'
    );
  }

  private isNotAllowedError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const name = (error as { name?: unknown }).name;
    return name === 'NotAllowedError' || name === 'SecurityError';
  }

  private async readGrantedClipboardOnceInternal(): Promise<ClipboardGrantedReadResult> {
    await this.permissionDiscoveryPromise;
    if (this.permissionStateSignal() !== 'granted') return { ok: false };
    try {
      const text = await navigator.clipboard.readText();
      this.applyText(text);
      return { ok: true, text };
    } catch {
      return { ok: false };
    }
  }

  private async queryPermission(): Promise<void> {
    try {
      if (!this.isSupported()) return;
      const perms = (navigator as Navigator & { permissions?: Permissions }).permissions;
      if (!perms || typeof perms.query !== 'function') {
        this.permissionStateSignal.set('unknown');
        return;
      }
      const status = await perms.query({
        name: 'clipboard-read' as PermissionName,
      });
      this.applyPermissionStatus(status);
      status.addEventListener?.('change', this.onPermissionChange);
      this.permissionStatus = status;
    } catch {
      // Firefox throws for unknown permission names.
      this.permissionStateSignal.set('unknown');
    } finally {
      this.permissionReadySignal.set(true);
    }
  }

  private applyPermissionStatus(status: PermissionStatus): void {
    const state = status.state;
    if (state === 'granted') {
      this.permissionStateSignal.set('granted');
      this.startPolling();
      void this.checkOnce();
    } else if (state === 'denied') {
      this.permissionStateSignal.set('denied');
      this.clearClipboardDerived();
    } else {
      this.permissionStateSignal.set('prompt');
    }
  }

  private onPermissionChange = (event: Event): void => {
    const status = event.target as PermissionStatus | null;
    if (status) this.applyPermissionStatus(status);
  };

  private applyText(text: string): void {
    if (!text) {
      this.clearClipboardDerived();
      return;
    }
    if (this.looksLikeJson(text)) {
      this.hasJsonSignal.set(true);
      this.previewSignal.set(this.makePreview(text));
    } else {
      this.clearClipboardDerived();
    }
  }

  /**
   * Plausibility predicate that gates the toolbar Paste button. Widened in
   * M7p so the button enables for mixed text (prose around JSON), which the
   * paste pipeline can extract via `JsonExtractorService`. Returns true iff
   * the trimmed text contains `{` or `[` anywhere.
   */
  private looksLikeJson(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    return trimmed.includes('{') || trimmed.includes('[');
  }

  private makePreview(text: string): string {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    if (collapsed.length <= PREVIEW_MAX_LENGTH) return collapsed;
    return collapsed.slice(0, PREVIEW_MAX_LENGTH - 3) + '...';
  }

  private clearClipboardDerived(): void {
    if (this.hasJsonSignal()) this.hasJsonSignal.set(false);
    if (this.previewSignal()) this.previewSignal.set('');
  }
}
