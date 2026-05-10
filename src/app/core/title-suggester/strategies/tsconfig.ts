import type { SuggestionStrategy } from '../types';
import { isPlainObject } from './helpers';

/**
 * `tsconfig.json` strategy (confidence 85).
 *
 * Two acceptance paths:
 *  1. Filename is `tsconfig.json` (or `tsconfig.<variant>.json`), OR
 *  2. The object has a `compilerOptions` key with an object value
 *     (the load-bearing field that all real tsconfigs share).
 *
 * Output: a fixed label since tsconfig has no name field.
 */
const TSCONFIG_FILENAME_RE = /^tsconfig(?:\..+)?\.json$/i;

export const tsconfigStrategy: SuggestionStrategy = (input) => {
  if (!isPlainObject(input.parsed)) return null;
  const filenameMatches =
    input.filename !== null && TSCONFIG_FILENAME_RE.test(input.filename.split(/[\\/]/).pop()!);
  const hasCompilerOptions = isPlainObject(input.parsed['compilerOptions']);
  if (!filenameMatches && !hasCompilerOptions) return null;
  return {
    value: $localize`:@@toolbar.titleSuggestion.shape.tsconfig:tsconfig`,
    source: 'tsconfig',
    confidence: 85,
  };
};
