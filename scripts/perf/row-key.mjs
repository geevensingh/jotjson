// Single source of truth for perf-row composite keys.
//
// A key is a dot-joined tuple of: layer, scenario, fixture, size.
// Layer is numeric in the JSONL schema (1/2/3) but stringified for the
// composite key. Examples:
//   1.parse.wide-aoo.10k
//   3.paste-large.wide-aoo.1m
//
// Used by:
//   - baseline.mjs to index rows in the baseline JSON
//   - diff.mjs to look up corresponding rows between runs
//   - C1 perf-targets reader (future) to look up enforcement entries

/**
 * @typedef {object} RowKeyParts
 * @property {number | string} layer    - 1/2/3 (number) or "1"/"2"/"3" (string)
 * @property {string} scenario          - e.g. "parse", "paste-large"
 * @property {string} fixture           - e.g. "wide-aoo"
 * @property {string} size              - e.g. "10k", "1m"
 */

/**
 * Composes a perf-row composite key from its parts. Layer is stringified
 * (no "l" prefix); other parts must already be non-empty strings without dots.
 * @param {RowKeyParts} parts
 * @returns {string}
 */
export function perfRowKey({ layer, scenario, fixture, size }) {
  const layerStr =
    typeof layer === 'number' && Number.isFinite(layer) && layer > 0
      ? String(layer)
      : typeof layer === 'string' && layer.length > 0
        ? layer
        : null;
  if (layerStr === null) {
    throw new Error(
      `perfRowKey: layer must be a positive number or non-empty string (got ${JSON.stringify(layer)})`,
    );
  }
  if (layerStr.includes('.')) {
    throw new Error(`perfRowKey: layer must not contain '.' (got ${JSON.stringify(layer)})`);
  }
  for (const [name, value] of Object.entries({ scenario, fixture, size })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `perfRowKey: ${name} must be a non-empty string (got ${JSON.stringify(value)})`,
      );
    }
    if (value.includes('.')) {
      throw new Error(`perfRowKey: ${name} must not contain '.' (got ${JSON.stringify(value)})`);
    }
  }
  return `${layerStr}.${scenario}.${fixture}.${size}`;
}

/**
 * Inverse of perfRowKey. Throws on malformed input. Returns layer as
 * the original number if numeric, else as the original string.
 * @param {string} key
 * @returns {{ layer: number | string; scenario: string; fixture: string; size: string }}
 */
export function parsePerfRowKey(key) {
  if (typeof key !== 'string') {
    throw new Error(`parsePerfRowKey: key must be a string (got ${typeof key})`);
  }
  const parts = key.split('.');
  if (parts.length !== 4) {
    throw new Error(
      `parsePerfRowKey: key must have 4 dot-separated parts (got ${parts.length} in ${JSON.stringify(key)})`,
    );
  }
  const [layerRaw, scenario, fixture, size] = parts;
  // If layerRaw is all-digits, return as number to match the JSONL schema.
  const layer = /^\d+$/.test(layerRaw) ? Number(layerRaw) : layerRaw;
  return { layer, scenario, fixture, size };
}
