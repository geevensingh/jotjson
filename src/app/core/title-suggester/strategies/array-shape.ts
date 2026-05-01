import type { SuggestionStrategy } from '../types';

/**
 * `arrayShape` strategy (confidence 30).
 *
 * Fires when the top-level parsed value is an array. Output:
 *  - "List of N items" for N >= 1
 *  - "Empty list" for N == 0
 *
 * Mutually exclusive with `objectShape` and `primitive` -- only one
 * fires for any given parsed value.
 */
export const arrayShapeStrategy: SuggestionStrategy = (input) => {
  if (!Array.isArray(input.parsed)) return null;
  const len = input.parsed.length;
  if (len === 0) {
    return {
      value: $localize`:@@toolbar.titleSuggestion.shape.emptyList:Empty list`,
      source: 'arrayShape',
      confidence: 30
    };
  }
  return {
    value: $localize`:@@toolbar.titleSuggestion.shape.listOfNItems:List of ${len}:n: items`,
    source: 'arrayShape',
    confidence: 30
  };
};
