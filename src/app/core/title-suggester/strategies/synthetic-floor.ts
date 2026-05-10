import type { SuggestionCandidate } from '../types';

/**
 * Synthetic floor strategies.
 *
 * These are NOT registered in the regular registry. They are only
 * invoked by `applyComposeRules` when the post-dedupe + post-cap list
 * is still under 2 -- the rare case where regular strategies all
 * collapse to the same normalized value.
 *
 * Each call appends a unique candidate; the caller iterates until the
 * list has >=2 entries.
 */

/**
 * `dateStamped` synthetic candidate.
 *
 * Returns "Untitled - YYYY-MM-DD" using the current date. Used as the
 * first synthetic fallback because it's always unique against the
 * `untitled` candidate.
 */
export function dateStampedCandidate(now: Date = new Date()): SuggestionCandidate {
  const year = now.getFullYear().toString().padStart(4, '0');
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const dateIso = `${year}-${month}-${day}`;
  const value = $localize`:@@toolbar.titleSuggestion.fallback.dateStamped:Untitled - ${dateIso}:dateIso:`;
  return { value, source: 'dateStamped', confidence: 0 };
}

/**
 * `numberedUntitled` synthetic candidate.
 *
 * Returns "Untitled (n)" where n is the supplied number (>=2). Used
 * as the second synthetic fallback when `dateStamped` collides with
 * an earlier candidate (e.g. user pasted exactly that string), and
 * as further fallbacks for any subsequent collision.
 */
export function numberedUntitledCandidate(n: number): SuggestionCandidate {
  const value = $localize`:@@toolbar.titleSuggestion.fallback.numberedUntitled:Untitled (${n}):n:`;
  return { value, source: 'numberedUntitled', confidence: 0 };
}
