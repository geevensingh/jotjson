import {
  DestroyRef,
  Injectable,
  OnDestroy,
  Signal,
  computed,
  inject,
  signal
} from '@angular/core';
import { JsonParserService } from '../json/json-parser.service';

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
export type ClipboardPermissionState =
  | 'unsupported'
  | 'unknown'
  | 'prompt'
  | 'granted'
  | 'denied';

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
  private readonly parser = inject(JsonParserService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly permissionStateSignal = signal<ClipboardPermissionState>(
    this.initialState()
  );
  private readonly hasJsonSignal = signal<boolean>(false);
  private readonly previewSignal = signal<string>('');

  readonly permissionState: Signal<ClipboardPermissionState> =
    this.permissionStateSignal.asReadonly();
  readonly hasJson: Signal<boolean> = this.hasJsonSignal.asReadonly();
  readonly preview: Signal<string> = this.previewSignal.asReadonly();

  /**
   * Convenience: is the Paste button in its "has JSON" enabled state?
   * True only when state=granted AND the current clipboard parses as
   * JSON-like content.
   */
  readonly isReady = computed(
    () => this.permissionStateSignal() === 'granted' && this.hasJsonSignal()
  );

  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private permissionStatus: PermissionStatus | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => this.ngOnDestroy());
    void this.queryPermission();
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
    } catch (err) {
      if (this.isNotAllowedError(err)) {
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
    } catch (err) {
      if (this.isNotAllowedError(err)) {
        this.permissionStateSignal.set('denied');
        this.clearClipboardDerived();
      }
      return null;
    }
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

  private isNotAllowedError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const name = (err as { name?: unknown }).name;
    return name === 'NotAllowedError' || name === 'SecurityError';
  }

  private async queryPermission(): Promise<void> {
    if (!this.isSupported()) return;
    const perms = (navigator as Navigator & { permissions?: Permissions })
      .permissions;
    if (!perms || typeof perms.query !== 'function') {
      this.permissionStateSignal.set('unknown');
      return;
    }
    try {
      const status = await perms.query({
        name: 'clipboard-read' as PermissionName
      });
      this.applyPermissionStatus(status);
      status.addEventListener?.('change', this.onPermissionChange);
      this.permissionStatus = status;
    } catch {
      // Firefox throws for unknown permission names.
      this.permissionStateSignal.set('unknown');
    }
  }

  private applyPermissionStatus(status: PermissionStatus): void {
    const s = status.state;
    if (s === 'granted') {
      this.permissionStateSignal.set('granted');
      this.startPolling();
      void this.checkOnce();
    } else if (s === 'denied') {
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
   * Matches the effective Paste predicate in `HomeComponent.onPaste`:
   * accept raw JSON/JSONC, the output of `tryUnescape` parsing to an
   * object/array, OR a plausibility prefix (`{` or `[`) per the spec.
   */
  private looksLikeJson(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      // Plausibility fallback from the spec - even a partially typed
      // `{"a":` should enable the button.
      return true;
    }

    try {
      const { unescaped, changed } = this.parser.tryUnescape(trimmed);
      if (!changed) return false;
      const uTrim = unescaped.trim();
      if (!uTrim.startsWith('{') && !uTrim.startsWith('[')) return false;
      const result = this.parser.parse(unescaped);
      return result.errors.length === 0 && result.value !== undefined;
    } catch {
      return false;
    }
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
