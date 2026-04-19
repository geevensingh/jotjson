import { effect, Injectable, signal } from '@angular/core';

const DRAFT_KEY = 'jotjson.draft.v1';

/** Persists the current anonymous editor draft to localStorage. */
@Injectable({ providedIn: 'root' })
export class DraftService {
  private readonly _content = signal<string>(this.load());
  readonly content = this._content.asReadonly();

  constructor() {
    effect(() => {
      const current = this._content();
      try {
        if (current.length === 0) localStorage.removeItem(DRAFT_KEY);
        else localStorage.setItem(DRAFT_KEY, current);
      } catch {
        /* ignore quota errors */
      }
    });
  }

  set(content: string): void {
    this._content.set(content);
  }

  clear(): void {
    this._content.set('');
  }

  private load(): string {
    try {
      return localStorage.getItem(DRAFT_KEY) ?? '';
    } catch {
      return '';
    }
  }
}
