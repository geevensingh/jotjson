import type { SuggestionStrategy } from '../types';
import { isPlainObject, readString } from './helpers';

/**
 * `package.json` strategy (confidence 92).
 *
 * Two acceptance paths:
 *  1. Filename is exactly `package.json` (after path strip), OR
 *  2. The object has `name` AND at least one classic package.json
 *     marker key (`scripts`, `dependencies`, `devDependencies`,
 *     `peerDependencies`).
 *
 * The second path avoids false-positives on arbitrary `{name, version}`
 * payloads that happen to share field names with package.json. The
 * filename path catches authentic package.json uploads even when the
 * payload itself is minimal.
 *
 * Output: `name` if no version, otherwise `name@version`. Skips when
 * `name` is missing.
 */
const MARKER_KEYS = [
  'scripts',
  'dependencies',
  'devDependencies',
  'peerDependencies'
] as const;

export const packageJsonStrategy: SuggestionStrategy = (input) => {
  if (!isPlainObject(input.parsed)) return null;
  const obj = input.parsed;
  const name = readString(obj, 'name');
  if (name === null) return null;

  const filenameMatches =
    input.filename !== null &&
    input.filename
      .split(/[\\/]/)
      .pop()!
      .toLowerCase() === 'package.json';

  const hasMarkerKey = MARKER_KEYS.some((key) =>
    Object.prototype.hasOwnProperty.call(obj, key)
  );

  if (!filenameMatches && !hasMarkerKey) return null;

  const version = readString(obj, 'version');
  const value = version !== null ? `${name}@${version}` : name;
  return { value, source: 'packageJson', confidence: 92 };
};
