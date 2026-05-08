import type { SuggestionStrategy } from '../types';
import { isPlainObject, readString } from './helpers';

/**
 * Postman collection strategy (confidence 85).
 *
 * Detects a Postman collection by the `info` object containing a
 * `_postman_id` (Postman v2.x) or `schema` matching Postman's URI.
 * Output: `info.name` if present.
 */
const POSTMAN_SCHEMA_RE = /^https?:\/\/schema\.getpostman\.com\//i;

export const postmanCollectionStrategy: SuggestionStrategy = (input) => {
  if (!isPlainObject(input.parsed)) return null;
  const info = input.parsed['info'];
  if (!isPlainObject(info)) return null;
  const schema = readString(info, 'schema');
  const postmanId = readString(info, '_postman_id');
  const looksLikePostman =
    postmanId !== null || (schema !== null && POSTMAN_SCHEMA_RE.test(schema));
  if (!looksLikePostman) return null;
  const name = readString(info, 'name');
  if (name === null) return null;
  return { value: name, source: 'postmanCollection', confidence: 85 };
};
