import { Injectable } from '@angular/core';
import { persistedStringSignal } from './persisted-signal';

const DRAFT_KEY = 'jotjson.draft.v1';

/**
 * The draft is a crash-survival mirror, not a real-time UX surface.
 * 500 ms of idle is short enough to cap data loss at half a second
 * while collapsing typing bursts into one localStorage round-trip.
 * Tab close / navigation / mobile background flush synchronously
 * via the `flushOnHide` listeners in `persistedSignal`.
 *
 * See DESIGN_SPEC.md s1068 (localStorage crash-survival contract).
 */
export const DRAFT_WRITE_DEBOUNCE_MS = 500;

/** Persists the current anonymous editor draft to localStorage. */
@Injectable({ providedIn: 'root' })
export class DraftService {
  private readonly _content = persistedStringSignal(DRAFT_KEY, '', {
    writeDebounceMs: DRAFT_WRITE_DEBOUNCE_MS,
    flushOnHide: true,
  });
  readonly content = this._content.asReadonly();

  set(content: string): void {
    this._content.set(content);
  }

  clear(): void {
    this._content.set('');
  }
}
