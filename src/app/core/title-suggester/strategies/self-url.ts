import type { SuggestionStrategy } from '../types';
import { isPlainObject, readString } from './helpers';

/**
 * `selfUrl` strategy (confidence 77).
 *
 * Detects a top-level self-link in any of these forms (in priority
 * order):
 *   1. `selfUrl`
 *   2. `self_url`
 *   3. `_links.self.href` (HAL specification)
 *
 * Output: the last non-empty path segment of the URL, URL-decoded,
 * with a trailing `.json` / `.yaml` / `.yml` extension stripped.
 *
 * Skips when:
 *   - none of the paths are populated with a string
 *   - the value is not a parseable URL with an http/https scheme
 *   - the URL has no usable path (e.g. "https://example.com/")
 *
 * Unlike `namedField`, the last segment is NOT rejected for looking
 * like a UUID or pure number -- self URLs typically encode the
 * resource ID in the last segment, and that is in fact the answer.
 */
export const selfUrlStrategy: SuggestionStrategy = (input) => {
  if (!isPlainObject(input.parsed)) return null;
  const obj = input.parsed;
  const candidates: string[] = [];
  const direct = readString(obj, 'selfUrl');
  if (direct !== null) candidates.push(direct);
  const snake = readString(obj, 'self_url');
  if (snake !== null) candidates.push(snake);
  const links = obj['_links'];
  if (isPlainObject(links)) {
    const self = links['self'];
    if (isPlainObject(self)) {
      const href = readString(self, 'href');
      if (href !== null) candidates.push(href);
    }
  }

  for (const url of candidates) {
    const segment = lastUsefulSegment(url);
    if (segment !== null) {
      return { value: segment, source: 'selfUrl', confidence: 77 };
    }
  }

  return null;
};

function lastUsefulSegment(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const pathname = parsed.pathname;
  if (pathname.length === 0 || pathname === '/') return null;
  const parts = pathname.split('/').filter((segment) => segment.length > 0);
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    decoded = last;
  }
  const stripped = decoded.replace(/\.(json|yaml|yml)$/i, '').trim();
  if (stripped.length === 0) return null;
  return stripped;
}
