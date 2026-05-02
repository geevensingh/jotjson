import type { SuggestionStrategy } from '../types';
import { isPlainObject } from './helpers';

/**
 * `objectShape` strategy (confidence 30).
 *
 * Fires when the top-level parsed value is a non-empty object.
 * Output: "Object with N keys".
 *
 * Skips empty objects (no useful info) -- those will fall through
 * to `firstChars` / `untitled`. Mutually exclusive with `arrayShape`
 * and `primitive`.
 */
export const objectShapeStrategy: SuggestionStrategy = (input) => {
  if (!isPlainObject(input.parsed)) return null;
  const len = Object.keys(input.parsed).length;
  if (len === 0) return null;
  return {
    value: $localize`:@@toolbar.titleSuggestion.shape.objectWithNKeys:Object with ${len}:n: keys`,
    source: 'objectShape',
    confidence: 30,
  };
};
