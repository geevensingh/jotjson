import type { SuggestionStrategy } from '../types';
import { isPlainObject } from './helpers';

/**
 * `topLevelKeys` strategy (confidence 50).
 *
 * Joins the first 3 top-level keys with `, `. Useful for
 * configuration objects whose keys themselves are the gist (e.g.
 * `{aws, azure, gcp}` -> "aws, azure, gcp").
 *
 * Skips on empty objects, non-objects, and when the joined output
 * exceeds 80 chars (signal-to-noise drops past that point).
 */
const KEY_LIMIT = 3;
const VALUE_LENGTH_LIMIT = 80;

export const topLevelKeysStrategy: SuggestionStrategy = (input) => {
  if (!isPlainObject(input.parsed)) return null;
  const keys = Object.keys(input.parsed);
  if (keys.length === 0) return null;
  const trimmed = keys.slice(0, KEY_LIMIT);
  const value = trimmed.join(', ');
  if (value.length === 0 || value.length > VALUE_LENGTH_LIMIT) return null;
  return { value, source: 'topLevelKeys', confidence: 50 };
};
