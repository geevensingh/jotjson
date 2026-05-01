import type { SuggestionStrategy } from '../types';

/**
 * `untitled` fallback strategy (confidence 5).
 *
 * Last-resort always-on candidate so the menu always has at least
 * one entry whenever there is non-empty content. The post-dedupe
 * synthetic floor (`dateStamped` + `numberedUntitled`) lifts the
 * list to >=2 if needed.
 *
 * Skips on empty / whitespace-only input.
 *
 * NOTE: the source string is i18n-extracted via the
 * `@@toolbar.titleSuggestion.fallback.untitled` ID. A separate
 * ID from `@@toolbar.title.untitled` (used as a placeholder for
 * untitled saved blobs) so translators can pick a more
 * conversational form here if desired.
 */
export const untitledStrategy: SuggestionStrategy = (input) => {
  if (input.jsonText.trim().length === 0) return null;
  return {
    value: $localize`:@@toolbar.titleSuggestion.fallback.untitled:Untitled`,
    source: 'untitled',
    confidence: 5
  };
};
