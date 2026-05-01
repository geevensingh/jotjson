import type { SuggestionStrategy } from '../types';
import { isPlainObject, readString } from './helpers';

/**
 * Kubernetes manifest strategy (confidence 92).
 *
 * Detects a top-level object with `apiVersion`, `kind`, and
 * `metadata.name`. Output: `"{kind}: {metadata.name}"`. The kind is
 * passed through verbatim (it's a fixed schema enum like
 * `Deployment`, `Service`, etc.).
 *
 * Skips when any of the three required fields is missing.
 */
export const kubernetesStrategy: SuggestionStrategy = (input) => {
  if (!isPlainObject(input.parsed)) return null;
  const obj = input.parsed;
  if (readString(obj, 'apiVersion') === null) return null;
  const kind = readString(obj, 'kind');
  if (kind === null) return null;
  const metadata = obj['metadata'];
  if (!isPlainObject(metadata)) return null;
  const name = readString(metadata, 'name');
  if (name === null) return null;
  return {
    value: `${kind}: ${name}`,
    source: 'kubernetes',
    confidence: 92
  };
};
