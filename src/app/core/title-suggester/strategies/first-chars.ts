import type { SuggestionStrategy } from '../types';
import { FIRST_CHARS_PREVIEW_LEN } from '../constants';

/**
 * `firstChars` strategy (confidence 10).
 *
 * Last-resort raw-text peek when no other strategy fired (e.g.,
 * unparseable JSON, bare primitives the user wants to remember by
 * sight). Renders the first ~40 trimmed chars with an ASCII
 * ellipsis when truncated.
 *
 * Skips on empty / whitespace-only input.
 */
export const firstCharsStrategy: SuggestionStrategy = (input) => {
  const trimmed = input.jsonText.trim();
  if (trimmed.length === 0) return null;
  const value =
    trimmed.length > FIRST_CHARS_PREVIEW_LEN
      ? `${trimmed.slice(0, FIRST_CHARS_PREVIEW_LEN)}...`
      : trimmed;
  return { value, source: 'firstChars', confidence: 10 };
};
