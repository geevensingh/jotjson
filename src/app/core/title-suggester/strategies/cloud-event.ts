import type { SuggestionStrategy } from '../types';
import { isPlainObject, readString } from './helpers';

/**
 * CloudEvents v1.0 strategy (confidence 90).
 *
 * Detects a top-level object carrying ALL FOUR required CloudEvents
 * v1.0 context attributes: `id`, `source`, `specversion`, `type`
 * (per https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md).
 * Requiring all four (not just three) keeps the false-positive rate
 * low against benign config objects that happen to have a `type` and
 * a `source` field.
 *
 * Output: `"{type} from {URL last segment of source}"` when `source`
 * parses as an http(s) URL with a meaningful last segment; otherwise
 * just `"{type}"`.
 */
export const cloudEventStrategy: SuggestionStrategy = (input) => {
  if (!isPlainObject(input.parsed)) return null;
  const obj = input.parsed;
  if (readString(obj, 'specversion') === null) return null;
  if (readString(obj, 'id') === null) return null;
  const type = readString(obj, 'type');
  if (type === null) return null;
  const source = readString(obj, 'source');
  if (source === null) return null;

  const sourceSegment = lastUrlSegment(source);
  const value =
    sourceSegment !== null
      ? $localize`:@@toolbar.titleSuggestion.cloudEvent.fromSource:${type}:type: from ${sourceSegment}:source:`
      : $localize`:@@toolbar.titleSuggestion.cloudEvent.typeOnly:${type}:type:`;

  return { value, source: 'cloudEvent', confidence: 90 };
};

function lastUrlSegment(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const parts = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1]!;
  try {
    const decoded = decodeURIComponent(last).trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return last;
  }
}
