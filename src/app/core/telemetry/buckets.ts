/**
 * Bucketing helpers for telemetry custom dimensions.
 *
 * Why buckets? Application Insights `customDimensions` is a string-keyed
 * map of strings; high-cardinality values (e.g. raw byte counts, raw
 * latency milliseconds, free-form colors) explode the schema, slow
 * queries, and inflate storage cost. Closed-enum strings keep
 * `customDimensions` cheap to query and filter on.
 *
 * Use the corresponding `customMeasurements` numeric companion for the
 * raw value when you also want percentile / avg / sum.
 *
 * Pattern:
 *   logger.event('paste.handle',
 *     { sizeBytesBucket: bucketBytes(bytes) },   // dimension (string)
 *     { sizeBytes: bytes }                       // measurement (number)
 *   );
 */

/**
 * Closed-enum bucket for byte sizes. Boundaries chosen to keep paste /
 * upload / blob events queryable at meaningful granularity without
 * inventing new strings per call site.
 */
export type SizeBucket = '<1KB' | '1-10KB' | '10-100KB' | '100KB-1MB' | '>1MB';

/**
 * Closed-enum bucket for item counts (tree node count, ruleSet rule
 * count, history entry count, etc.).
 */
export type CountBucket = '<100' | '100-1K' | '1K-10K' | '>10K';

/**
 * Closed-enum bucket for line counts in a rendered string. Boundaries
 * are picked to surface the common "single line / a few lines / dense
 * log" distribution without inventing per-call-site strings.
 */
export type LineCountBucket = '1' | '2-5' | '6-20' | '21-100' | '100+';

/**
 * Returns the {@link SizeBucket} that contains `n` bytes. `NaN` and
 * negative inputs clamp to the smallest bucket; `Infinity` clamps to
 * the largest. We do not throw on bad input.
 */
export function bucketBytes(n: number): SizeBucket {
  if (Number.isNaN(n) || n < 1024) {
    return '<1KB';
  }
  if (n < 10 * 1024) {
    return '1-10KB';
  }
  if (n < 100 * 1024) {
    return '10-100KB';
  }
  if (n < 1024 * 1024) {
    return '100KB-1MB';
  }
  return '>1MB';
}

/**
 * Returns the {@link CountBucket} that contains `n` items. `NaN` and
 * negative inputs clamp to the smallest bucket; `Infinity` clamps to
 * the largest.
 */
export function bucketCount(n: number): CountBucket {
  if (Number.isNaN(n) || n < 100) {
    return '<100';
  }
  if (n < 1000) {
    return '100-1K';
  }
  if (n < 10000) {
    return '1K-10K';
  }
  return '>10K';
}

/**
 * Returns the {@link LineCountBucket} that contains the number of
 * lines in `text`. Counts line breaks via a single forward scan with
 * an early exit at the highest bucket boundary, so this is safe to
 * call on multi-MB strings without `split` allocating intermediate
 * arrays. CRLF (`\r\n`) is treated as one line break, matching how
 * `pre-wrap` and most editors render the sequence.
 *
 * The result counts lines, not breaks: a string with zero line breaks
 * is `'1'`; a string with one `\n` is `'2-5'`; etc. An empty string
 * is `'1'`.
 */
export function bucketLineCount(text: string): LineCountBucket {
  let breaks = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 10) {
      // \n
      breaks += 1;
    } else if (code === 13) {
      // \r - treat \r\n as one break
      breaks += 1;
      if (i + 1 < text.length && text.charCodeAt(i + 1) === 10) {
        i += 1;
      }
    }
    if (breaks >= 100) {
      return '100+';
    }
  }
  const lines = breaks + 1;
  if (lines <= 1) return '1';
  if (lines <= 5) return '2-5';
  if (lines <= 20) return '6-20';
  return '21-100';
}
