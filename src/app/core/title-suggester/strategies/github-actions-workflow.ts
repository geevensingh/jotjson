import type { SuggestionStrategy } from '../types';
import { isPlainObject, readString } from './helpers';

/**
 * GitHub Actions workflow strategy (confidence 85).
 *
 * Detects a GitHub Actions workflow by the presence of a `jobs`
 * object plus either an `on` or `name` key. Output: the workflow's
 * `name` if present, else "Workflow".
 *
 * GitHub Actions workflows are typically YAML, but can be expressed
 * as JSON in the editor (e.g., copy-pasted from a JSON pipeline
 * config or programmatic generation).
 */
export const githubActionsWorkflowStrategy: SuggestionStrategy = (input) => {
  if (!isPlainObject(input.parsed)) return null;
  const obj = input.parsed;
  if (!isPlainObject(obj['jobs'])) return null;
  const hasOn = 'on' in obj;
  const hasName = 'name' in obj;
  if (!hasOn && !hasName) return null;
  const name = readString(obj, 'name');
  if (name !== null) {
    return {
      value: name,
      source: 'githubActionsWorkflow',
      confidence: 85,
    };
  }
  return {
    value: $localize`:@@toolbar.titleSuggestion.shape.workflow:Workflow`,
    source: 'githubActionsWorkflow',
    confidence: 85,
  };
};
