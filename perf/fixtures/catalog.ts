/**
 * Canonical perf-suite fixture matrix. Single source of truth for
 * which shapes + sizes the benches and Playwright scenarios run
 * against. Importing from here keeps L1, L2, L3 in sync; never
 * duplicate this list inline.
 *
 * The `mixed-d10 @ 380k` row is the NFR-anchor fixture: ~5 MB
 * UTF-8 minified JSON with mixed object/array/leaf content and
 * realized depth 10, anchoring DESIGN_SPEC.md NFR #1 ("open a 5 MB
 * JSON file without freezing"). See `perf/fixtures/generate.ts`
 * `buildMixedD10` for shape details and issue #215 for context.
 */
export interface FixtureSpec {
  readonly shape: 'wide-aoo' | 'deep25' | 'mixed-d10';
  readonly approxNodes: number;
  /** Human-readable size label as a node-count abbreviation (e.g., "10k", "100k", "1m", "380k"). */
  readonly size: string;
}

export const FIXTURE_CATALOG: readonly FixtureSpec[] = [
  { shape: 'deep25', approxNodes: 10_000, size: '10k' },
  { shape: 'wide-aoo', approxNodes: 10_000, size: '10k' },
  { shape: 'deep25', approxNodes: 100_000, size: '100k' },
  { shape: 'wide-aoo', approxNodes: 100_000, size: '100k' },
  { shape: 'deep25', approxNodes: 1_000_000, size: '1m' },
  { shape: 'wide-aoo', approxNodes: 1_000_000, size: '1m' },
  { shape: 'mixed-d10', approxNodes: 380_000, size: '380k' },
] as const;
