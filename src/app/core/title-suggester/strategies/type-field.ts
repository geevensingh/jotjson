import type { SuggestionStrategy } from '../types';
import { isPlainObject, readString } from './helpers';

/**
 * `typeField` strategy (confidence 60).
 *
 * Inspects common type-discriminator fields used by JSON-LD
 * (`@type`), GraphQL responses (`__typename`), and FHIR resources
 * (`resourceType`). Returns the type name verbatim.
 *
 * Priority order: `@type > __typename > resourceType`.
 *
 * Skips when none are populated with a non-empty string.
 */
const PRIORITY = ['@type', '__typename', 'resourceType'] as const;

export const typeFieldStrategy: SuggestionStrategy = (input) => {
  if (!isPlainObject(input.parsed)) return null;
  for (const key of PRIORITY) {
    const value = readString(input.parsed, key);
    if (value !== null) {
      return { value, source: 'typeField', confidence: 60 };
    }
  }
  return null;
};
