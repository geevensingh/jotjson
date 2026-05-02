import type { SuggestionStrategy } from '../types';
import { isPlainObject, readString } from './helpers';
import { DESCRIPTION_PREVIEW_LEN } from '../constants';

/**
 * `descriptionFallback` strategy (confidence 40).
 *
 * Inspects `description` first, then `summary`. Outputs the first
 * sentence (text before the first period or newline), trimmed and
 * truncated to ~60 chars with an ASCII ellipsis when truncation
 * happened.
 *
 * Skips when both are empty / absent / non-string. The strategy is
 * intentionally low-confidence -- prose is rarely as useful as a
 * named identifier, but better than nothing.
 */
export const descriptionFallbackStrategy: SuggestionStrategy = (input) => {
  if (!isPlainObject(input.parsed)) return null;
  const description = readString(input.parsed, 'description');
  const summary = readString(input.parsed, 'summary');
  const source = description ?? summary;
  if (source === null) return null;
  const firstSentenceEnd = source.search(/[.\n]/);
  const firstSentence = firstSentenceEnd >= 0 ? source.slice(0, firstSentenceEnd) : source;
  const trimmed = firstSentence.trim();
  if (trimmed.length === 0) return null;
  const value =
    trimmed.length > DESCRIPTION_PREVIEW_LEN
      ? `${trimmed.slice(0, DESCRIPTION_PREVIEW_LEN)}...`
      : trimmed;
  return { value, source: 'descriptionFallback', confidence: 40 };
};
