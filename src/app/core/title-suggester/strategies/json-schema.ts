import type { SuggestionStrategy } from '../types';
import { isPlainObject, readString } from './helpers';

/**
 * JSON Schema strategy (confidence 88).
 *
 * Detects a top-level object that has either:
 *  - `$schema` matching JSON Schema URI patterns, OR
 *  - `$id` set, OR
 *  - both `type` and (`properties` or `items`) -- typical schema
 *    shape.
 *
 * Output priority: `title` > basename of `$id` URL.
 */
const SCHEMA_URI_RE = /json-?schema/i;

export const jsonSchemaStrategy: SuggestionStrategy = (input) => {
  if (!isPlainObject(input.parsed)) return null;
  const obj = input.parsed;
  const schema = readString(obj, '$schema');
  const id = readString(obj, '$id');
  const type = readString(obj, 'type');
  const hasProperties = isPlainObject(obj['properties']) || isPlainObject(obj['items']);

  const looksLikeSchema =
    (schema !== null && SCHEMA_URI_RE.test(schema)) ||
    id !== null ||
    (type !== null && hasProperties);

  if (!looksLikeSchema) return null;

  const title = readString(obj, 'title');
  if (title !== null) {
    return { value: title, source: 'jsonSchema', confidence: 88 };
  }

  if (id !== null) {
    const trailing = id
      .replace(/[#/]+$/, '')
      .split(/[/#]/)
      .pop();
    if (trailing !== undefined && trailing.length > 0) {
      const cleaned = trailing.replace(/\.json$/i, '');
      return { value: cleaned, source: 'jsonSchema', confidence: 88 };
    }
  }

  return null;
};
