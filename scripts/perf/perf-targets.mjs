// Pure reader for `perf-targets.json` (operationalizable NFR ceilings).
//
// File-format contract (also described by perf-targets.schema.json):
//
//   {
//     "$schema": "./perf-targets.schema.json",
//     "schemaVersion": 1,
//     "_comment": "...",
//     "rows": {
//       "<layer>.<scenario>.<fixture>.<size>": {
//         "<metric>": { "ceiling_ms": number, "reason": string },
//         ...
//       },
//       ...
//     }
//   }
//
// Used by `perf:diff` to enforce per-row NFR ceilings on top of the
// soft baseline-regression check. Schema is fail-loud: any version
// mismatch throws so a stale reader can't silently misread the file.

import { existsSync, readFileSync } from 'node:fs';

export const PERF_TARGETS_SCHEMA_VERSION = 1;

/**
 * @typedef {Object} PerfTargetMetric
 * @property {number} ceiling_ms
 * @property {string} reason
 */

/**
 * @typedef {Object} PerfTargetsFile
 * @property {number} schemaVersion
 * @property {Record<string, Record<string, PerfTargetMetric>>} rows
 */

/**
 * Validates a parsed perf-targets object against the schemaVersion contract.
 *
 * @param {unknown} parsed
 * @param {string} sourcePath
 * @returns {PerfTargetsFile}
 */
export function assertPerfTargetsSchema(parsed, sourcePath) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`perf-targets at ${sourcePath} is not an object`);
  }
  const obj = /** @type {Record<string, unknown>} */ (parsed);
  if (typeof obj['schemaVersion'] !== 'number') {
    throw new Error(
      `perf-targets at ${sourcePath} is missing "schemaVersion". Expected ${PERF_TARGETS_SCHEMA_VERSION}. Update perf-targets.json or the reader.`,
    );
  }
  if (obj['schemaVersion'] !== PERF_TARGETS_SCHEMA_VERSION) {
    throw new Error(
      `perf-targets at ${sourcePath} has schemaVersion=${String(obj['schemaVersion'])}, expected ${PERF_TARGETS_SCHEMA_VERSION}. Update perf-targets.json or the reader.`,
    );
  }
  const rows = obj['rows'];
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) {
    throw new Error(
      `perf-targets at ${sourcePath} is missing "rows" object (got ${Array.isArray(rows) ? 'array' : typeof rows}).`,
    );
  }
  for (const [rowKey, metricMap] of Object.entries(rows)) {
    if (!metricMap || typeof metricMap !== 'object' || Array.isArray(metricMap)) {
      throw new Error(
        `perf-targets at ${sourcePath} row "${rowKey}" must be an object of metrics.`,
      );
    }
    for (const [metric, spec] of Object.entries(
      /** @type {Record<string, unknown>} */ (metricMap),
    )) {
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        throw new Error(
          `perf-targets at ${sourcePath} row "${rowKey}" metric "${metric}" must be an object.`,
        );
      }
      const specObj = /** @type {Record<string, unknown>} */ (spec);
      if (typeof specObj['ceiling_ms'] !== 'number' || !Number.isFinite(specObj['ceiling_ms'])) {
        throw new Error(
          `perf-targets at ${sourcePath} row "${rowKey}" metric "${metric}" is missing numeric "ceiling_ms".`,
        );
      }
      if (typeof specObj['reason'] !== 'string' || specObj['reason'].length === 0) {
        throw new Error(
          `perf-targets at ${sourcePath} row "${rowKey}" metric "${metric}" is missing non-empty "reason".`,
        );
      }
    }
  }
  return /** @type {PerfTargetsFile} */ (parsed);
}

/**
 * Reads and validates a perf-targets file.
 *
 * @param {string} targetsPath
 * @returns {PerfTargetsFile}
 */
export function readPerfTargets(targetsPath) {
  if (!existsSync(targetsPath)) {
    throw new Error(`perf-targets.json not found at ${targetsPath}`);
  }
  const text = readFileSync(targetsPath, 'utf8');
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `perf-targets at ${targetsPath} is not valid JSON: ${/** @type {Error} */ (cause).message}`,
    );
  }
  return assertPerfTargetsSchema(parsed, targetsPath);
}
