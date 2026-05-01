/**
 * Editor mode tag derived from content (presence of single-line `//`
 * or block-comment trivia). Drives the status-bar badge label and the
 * download filename extension. Does NOT control parser or editor
 * behavior -- Monaco language is hardcoded to 'json' and the
 * JSONC-aware parser always allows comments + trailing commas.
 *
 * See `HomeComponent.detectMode` (`features/home/home.component.ts`)
 * and the auto-detect effect that drives this signal.
 */
export type EditorMode = 'json' | 'jsonc';
