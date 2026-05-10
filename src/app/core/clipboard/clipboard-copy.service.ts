import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';

/**
 * Resolved (already-localized) snackbar messages for the three outcomes of
 * a clipboard write. Callers must evaluate `$localize` tagged template
 * literals at the call site so the i18n extractor can find them.
 */
export interface CopyToastMessages {
  /** Shown after `clipboard.writeText` resolves. */
  success: string;
  /** Shown after `clipboard.writeText` rejects. */
  failed: string;
  /** Shown when `navigator.clipboard?.writeText` is unavailable. */
  unsupported: string;
}

/**
 * Optional duration overrides (milliseconds) for each outcome.
 * Defaults match the original inlined copy/share-link behavior.
 */
export interface CopyToastDurations {
  successDurationMs?: number;
  failedDurationMs?: number;
  unsupportedDurationMs?: number;
}

const DEFAULT_SUCCESS_MS = 3000;
const DEFAULT_FAILED_MS = 4000;
const DEFAULT_UNSUPPORTED_MS = 4000;

/**
 * Write-side companion to `ClipboardPollingService`. Centralizes the
 * "copy text and tell the user how it went" pattern so call sites do
 * not duplicate the unsupported / success / failed snackbar plumbing.
 *
 * Callers pass already-localized messages because Angular's i18n
 * extractor only finds `$localize` tagged template literals at lexical
 * positions; the helper cannot accept ID strings and resolve them.
 */
@Injectable({ providedIn: 'root' })
export class ClipboardCopyService {
  private readonly snack = inject(MatSnackBar);

  /**
   * Copies `text` to the clipboard and opens a snackbar describing the
   * outcome. Resolves to `true` when the write succeeded, `false` when the
   * environment is unsupported or `writeText` rejected. Most callers can
   * `void` the return value; the boolean exists so future callers can chain
   * follow-up UI on success without re-plumbing the API.
   */
  async copyWithToast(
    text: string,
    messages: CopyToastMessages,
    durations: CopyToastDurations = {},
  ): Promise<boolean> {
    const dismiss = $localize`:@@common.dismiss:Dismiss`;
    const successMs = durations.successDurationMs ?? DEFAULT_SUCCESS_MS;
    const failedMs = durations.failedDurationMs ?? DEFAULT_FAILED_MS;
    const unsupportedMs = durations.unsupportedDurationMs ?? DEFAULT_UNSUPPORTED_MS;

    const clipboard = navigator.clipboard;
    // clipboard is undefined on HTTP / file:// (insecure contexts) and in
    // older browsers; writeText may also be missing on partial polyfills.
    if (!clipboard?.writeText) {
      this.snack.open(messages.unsupported, dismiss, { duration: unsupportedMs });
      return false;
    }
    try {
      await clipboard.writeText(text);
      this.snack.open(messages.success, dismiss, { duration: successMs });
      return true;
    } catch {
      this.snack.open(messages.failed, dismiss, { duration: failedMs });
      return false;
    }
  }
}
