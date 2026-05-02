import type { SuggestionStrategy } from '../types';
import { isPlainObject, readString } from './helpers';

/**
 * ARM template strategy (confidence 85).
 *
 * Detects an Azure Resource Manager template by its `$schema` URI,
 * which contains "deploymenttemplate.json". Output: a fixed label
 * (no template name field exists at the top level).
 */
const ARM_SCHEMA_RE = /deploymenttemplate.json/i;

export const armTemplateStrategy: SuggestionStrategy = (input) => {
  if (!isPlainObject(input.parsed)) return null;
  const schema = readString(input.parsed, '$schema');
  if (schema === null || !ARM_SCHEMA_RE.test(schema)) return null;
  return {
    value: $localize`:@@toolbar.titleSuggestion.shape.armTemplate:ARM template`,
    source: 'armTemplate',
    confidence: 85,
  };
};
