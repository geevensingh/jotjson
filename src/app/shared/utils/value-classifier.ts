/**
 * Classifies a parsed JSON value into a richer label than its raw JSON
 * type. Used by the tree view's type badge so users can see at a glance
 * that a string is e.g. a UUID or an email rather than just "string".
 *
 * Detectors are intentionally conservative - false negatives are
 * preferred over false positives. `node.type` (the underlying JSON
 * primitive) is unaffected by this module; this is purely a display
 * concern.
 */
import { parseAsDate, ParseOptions } from './date-detect';
import type { JsonValueType } from '../pipes/json-type.pipe';

export type ValueClassification =
  | 'date'
  | 'date/time'
  | 'uuid'
  | 'url'
  | 'email'
  | 'path'
  | 'ipv4'
  | 'ipv6'
  | 'integer'
  | 'number'
  | 'string'
  | 'boolean'
  | 'null'
  | 'array'
  | 'object'
  | 'undefined';

export interface ClassifyOptions extends ParseOptions {
  /**
   * When false, skip the `parseAsDate` step entirely. The string will
   * fall through to the other classifiers (and ultimately to "string").
   */
  detectDates?: boolean;
}

const UUID_RE =
  /^(?:urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}|\([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

const URL_RE =
  /^(?:https?|wss?|ftps?|file|mailto):[^\s]+$/i;

// Local + @ + domain with at least one dot + 2+ alpha TLD.
const EMAIL_RE =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

// Path detector: identifies absolute and relative URL-style paths
// (RFC 3986 path component, optionally with `?query` and `#fragment`).
// Conservative - intended to label cloud resource IDs, REST hyperlinks,
// and unix-style file paths without flagging arbitrary slashed prose.
const PATH_SEGMENT_CHARS = "A-Za-z0-9._~%!$&'()*+,;=:@\\-";
const PATH_PATH_RE = new RegExp(`^[/${PATH_SEGMENT_CHARS}]+$`);
const PATH_QUERY_FRAGMENT_RE = new RegExp(`^[/?#${PATH_SEGMENT_CHARS}]*$`);
const FILENAME_EXT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8}$/;

function isPath(s: string): boolean {
  if (s.length < 4 || s.length > 2048) return false;
  if (/[\s\\\u0000-\u001f\u007f]/.test(s)) return false;
  if (s.includes('://')) return false;

  // Split off optional ?query and #fragment.
  let pathPart = s;
  let rest = '';
  const hashIdx = s.indexOf('#');
  const qIdx = s.indexOf('?');
  const splitIdx = qIdx >= 0 && (hashIdx < 0 || qIdx < hashIdx) ? qIdx : hashIdx;
  if (splitIdx >= 0) {
    pathPart = s.slice(0, splitIdx);
    rest = s.slice(splitIdx);
  }
  if (pathPart.length === 0) return false;
  if (!PATH_PATH_RE.test(pathPart)) return false;
  // Validate query/fragment portion (skip the leading `?`/`#`).
  if (rest.length > 0 && !PATH_QUERY_FRAGMENT_RE.test(rest.slice(1))) {
    return false;
  }

  if (pathPart.startsWith('/')) {
    if (pathPart.startsWith('//')) return false;
    const segments = pathPart.slice(1).split('/').filter((seg) => seg.length > 0);
    return segments.length >= 2;
  }
  // Relative path: must not start with ? or # (already handled), and
  // must satisfy >=3 segments OR >=2 segments + filename-ext last segment.
  const segments = pathPart.split('/');
  if (segments.some((seg) => seg.length === 0)) return false;
  if (segments.length >= 3) return true;
  if (segments.length === 2) {
    return FILENAME_EXT_RE.test(segments[1]);
  }
  return false;
}

function isIpv4(s: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) return false;
  return s.split('.').every((octet) => {
    const n = Number(octet);
    return n >= 0 && n <= 255 && String(n) === octet;
  });
}

// Conservative IPv6 matcher: hex groups separated by `:`, optional `::`
// compression once, optional zone id (`%eth0`) excluded for simplicity.
// Length bounds keep us out of pathological inputs.
function isIpv6(s: string): boolean {
  if (s.length < 2 || s.length > 45) return false;
  if (!/^[0-9a-fA-F:]+$/.test(s)) return false;
  // Must contain at least one ':', and at most one '::' compression.
  if (!s.includes(':')) return false;
  const compressionMatches = s.match(/::/g);
  if (compressionMatches && compressionMatches.length > 1) return false;
  // Split and validate group counts.
  if (s.includes('::')) {
    const [left, right] = s.split('::');
    const leftGroups = left === '' ? [] : left.split(':');
    const rightGroups = right === '' ? [] : right.split(':');
    if (leftGroups.length + rightGroups.length > 7) return false;
    return [...leftGroups, ...rightGroups].every((g) => /^[0-9a-fA-F]{1,4}$/.test(g));
  }
  const groups = s.split(':');
  if (groups.length !== 8) return false;
  return groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g));
}

function classifyString(value: string, opts?: ClassifyOptions): ValueClassification {
  const trimmed = value.trim();
  if (opts?.detectDates !== false) {
    const parsed = parseAsDate(trimmed, undefined, {
      assumeUtcForIsoDateTime: opts?.assumeUtcForIsoDateTime,
      assumeUtcForIsoDateOnly: opts?.assumeUtcForIsoDateOnly
    });
    if (parsed) return parsed.hasTime ? 'date/time' : 'date';
  }
  if (UUID_RE.test(trimmed)) return 'uuid';
  if (URL_RE.test(trimmed)) return 'url';
  if (EMAIL_RE.test(trimmed)) return 'email';
  if (isPath(trimmed)) return 'path';
  if (isIpv4(trimmed)) return 'ipv4';
  if (isIpv6(trimmed)) return 'ipv6';
  return 'string';
}

export function classifyValue(
  type: JsonValueType,
  value: unknown,
  opts?: ClassifyOptions
): ValueClassification {
  switch (type) {
    case 'string':
      return typeof value === 'string' ? classifyString(value, opts) : 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
        ? 'integer'
        : 'number';
    default:
      return type;
  }
}
