import type { SuggestionStrategy } from '../types';
import { isPlainObject, looksLikeMachineId, readString } from './helpers';

/**
 * `namedField` strategy (confidence 75).
 *
 * Walks a fixed priority chain of common identifier fields at the
 * top level:
 *   `name > title > displayName > subject > label > id > slug`
 *
 * `subject` and `label` are accepted verbatim (they're rarely used
 * as machine IDs in practice). `id` and `slug` are rejected when the
 * value looks like a UUID, a pure number, or a long string -- such
 * values are useless titles. `name`, `title`, and `displayName` get
 * the same machine-ID rejection too, but only when the rejection
 * would NOT leave us with no candidate; we accept long human
 * titles up to 200 chars (the candidate is later truncated by the
 * compose layer).
 *
 * The chain stops at the first non-rejected field.
 */
type FieldKey =
  | 'name'
  | 'title'
  | 'displayName'
  | 'subject'
  | 'label'
  | 'id'
  | 'slug';

const PRIORITY: readonly FieldKey[] = [
  'name',
  'title',
  'displayName',
  'subject',
  'label',
  'id',
  'slug'
];

const MACHINE_ID_REJECT_KEYS: ReadonlySet<FieldKey> = new Set(['id', 'slug']);

export const namedFieldStrategy: SuggestionStrategy = (input) => {
  if (!isPlainObject(input.parsed)) return null;
  const obj = input.parsed;
  for (const key of PRIORITY) {
    const value = readString(obj, key);
    if (value === null) continue;
    if (MACHINE_ID_REJECT_KEYS.has(key) && looksLikeMachineId(value)) continue;
    return { value, source: 'namedField', confidence: 75 };
  }
  return null;
};
