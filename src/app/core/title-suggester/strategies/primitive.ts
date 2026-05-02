import type { SuggestionStrategy } from '../types';
import { FIRST_CHARS_PREVIEW_LEN } from '../constants';

/**
 * `primitive` strategy (confidence 25).
 *
 * Fires when the top-level parsed value is a primitive (number,
 * string, boolean, null). Output:
 *  - Number: "Number 42"
 *  - String: "String: <truncated value>"
 *  - Boolean: "true" or "false"
 *  - Null: "null"
 *
 * Mutually exclusive with `arrayShape` and `objectShape`.
 */
export const primitiveStrategy: SuggestionStrategy = (input) => {
  const v = input.parsed;
  if (typeof v === 'number') {
    return {
      value: $localize`:@@toolbar.titleSuggestion.shape.numberValue:Number ${v}:value:`,
      source: 'primitive',
      confidence: 25,
    };
  }
  if (typeof v === 'string') {
    const preview =
      v.length > FIRST_CHARS_PREVIEW_LEN ? `${v.slice(0, FIRST_CHARS_PREVIEW_LEN)}...` : v;
    return {
      value: $localize`:@@toolbar.titleSuggestion.shape.stringValue:String: ${preview}:value:`,
      source: 'primitive',
      confidence: 25,
    };
  }
  if (typeof v === 'boolean') {
    return {
      value: v
        ? $localize`:@@toolbar.titleSuggestion.shape.booleanTrue:true`
        : $localize`:@@toolbar.titleSuggestion.shape.booleanFalse:false`,
      source: 'primitive',
      confidence: 25,
    };
  }
  if (v === null) {
    return {
      value: $localize`:@@toolbar.titleSuggestion.shape.nullValue:null`,
      source: 'primitive',
      confidence: 25,
    };
  }
  return null;
};
