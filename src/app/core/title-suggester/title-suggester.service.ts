import { Injectable } from '@angular/core';
import { TITLE_CAP, TITLE_MAX_CHARS } from './constants';
import { STRATEGIES } from './strategies';
import {
  dateStampedCandidate,
  numberedUntitledCandidate
} from './strategies/synthetic-floor';
import type { SuggestionCandidate, SuggestionInput } from './types';

/**
 * Generates candidate titles for a JSON document by composing a
 * registry of pure strategy functions. See
 * `src/app/core/title-suggester/types.ts` and the `strategies/`
 * folder for the full registry.
 *
 * The service is invoked **only on demand** -- it is NOT called
 * per-keystroke. The home component's wand button click handler
 * passes the already-parsed JSON value (no double-parse) and the
 * last-used filename.
 *
 * Compose pipeline:
 *   1. Run every regular strategy. Drop nulls.
 *   2. Sort by confidence desc.
 *   3. Truncate each value to TITLE_MAX_CHARS (matches server cap).
 *   4. Dedupe by lowercased + trimmed value (higher-confidence wins).
 *   5. Cap to TITLE_CAP entries.
 *   6. Synthetic floor: if the result is still under 2, append
 *      `dateStamped` (with today's date), then `numberedUntitled(2)`,
 *      `numberedUntitled(3)`, ... -- skipping any that collide with
 *      an existing entry -- until the list has >= 2 entries.
 *
 * The service deliberately returns an EMPTY list when the editor is
 * empty / whitespace-only; the caller is expected to also disable the
 * wand button on empty content (a cheap signal-level check).
 */
@Injectable({ providedIn: 'root' })
export class TitleSuggesterService {
  suggest(input: SuggestionInput): readonly SuggestionCandidate[] {
    if (input.jsonText.trim().length === 0) return [];
    const raw: SuggestionCandidate[] = [];
    for (const strategy of STRATEGIES) {
      const candidate = strategy(input);
      if (candidate !== null) raw.push(candidate);
    }
    return composeFinalList(raw);
  }
}

function composeFinalList(
  raw: SuggestionCandidate[]
): readonly SuggestionCandidate[] {
  const sorted = [...raw].sort((a, b) => b.confidence - a.confidence);
  const truncated = sorted.map(truncate);
  const seen = new Set<string>();
  const deduped: SuggestionCandidate[] = [];
  for (const candidate of truncated) {
    const key = normalize(candidate.value);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  const capped = deduped.slice(0, TITLE_CAP);
  // Re-collect the seen set against only the surviving entries so the
  // synthetic floor's collision check is relative to the visible
  // result -- not against entries that were dedup-collapsed but still
  // counted.
  const survivingKeys = new Set(capped.map((c) => normalize(c.value)));
  return ensureMinimumTwo(capped, survivingKeys);
}

function ensureMinimumTwo(
  list: SuggestionCandidate[],
  seen: Set<string>
): SuggestionCandidate[] {
  if (list.length >= 2) return list;
  const result = [...list];

  const date = truncate(dateStampedCandidate());
  const dateKey = normalize(date.value);
  if (!seen.has(dateKey)) {
    result.push(date);
    seen.add(dateKey);
  }

  let counter = 2;
  while (result.length < 2) {
    const numbered = truncate(numberedUntitledCandidate(counter));
    const key = normalize(numbered.value);
    if (!seen.has(key)) {
      result.push(numbered);
      seen.add(key);
    }
    counter += 1;
    if (counter > 100) break;
  }
  return result;
}

function truncate(candidate: SuggestionCandidate): SuggestionCandidate {
  if (candidate.value.length <= TITLE_MAX_CHARS) return candidate;
  return {
    ...candidate,
    value: candidate.value.slice(0, TITLE_MAX_CHARS)
  };
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
