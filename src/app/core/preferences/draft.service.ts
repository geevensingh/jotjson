import { Injectable } from '@angular/core';
import { persistedStringSignal } from './persisted-signal';

const DRAFT_KEY = 'jotjson.draft.v1';

/** Persists the current anonymous editor draft to localStorage. */
@Injectable({ providedIn: 'root' })
export class DraftService {
  private readonly _content = persistedStringSignal(DRAFT_KEY);
  readonly content = this._content.asReadonly();

  set(content: string): void {
    this._content.set(content);
  }

  clear(): void {
    this._content.set('');
  }
}
