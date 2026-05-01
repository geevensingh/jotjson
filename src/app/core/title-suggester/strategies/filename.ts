import type { SuggestionStrategy } from '../types';

/**
 * Filename strategy (confidence 95 -- top of the registry).
 *
 * When the editor was populated from an upload or drag-drop, the
 * file's basename (with `.json` / `.jsonc` / `.yaml` / `.yml`
 * extension stripped) is the most reliable title hint.
 *
 * Skips when no filename is set (`null`) or the basename collapses
 * to empty after stripping.
 */
export const filenameStrategy: SuggestionStrategy = (input) => {
  const filename = input.filename;
  if (filename === null || filename.trim().length === 0) return null;
  const basename = filename
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(json|jsonc|yaml|yml)$/i, '')
    .trim();
  if (basename.length === 0) return null;
  return { value: basename, source: 'filename', confidence: 95 };
};
