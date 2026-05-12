/**
 * Canonical perf-suite fixture matrix. Single source of truth for
 * which shapes + sizes the benches and Playwright scenarios run
 * against. Importing from here keeps L1, L2, L3 in sync; never
 * duplicate this list inline.
 */
export interface FixtureSpec {
  readonly shape: 'wide-aoo' | 'deep25';
  readonly approxNodes: number;
  /** Human-readable size label (e.g., "10k", "100k", "1m"). */
  readonly size: string;
}

export const FIXTURE_CATALOG: readonly FixtureSpec[] = [
  { shape: 'deep25', approxNodes: 10_000, size: '10k' },
  { shape: 'wide-aoo', approxNodes: 10_000, size: '10k' },
  { shape: 'deep25', approxNodes: 100_000, size: '100k' },
  { shape: 'wide-aoo', approxNodes: 100_000, size: '100k' },
  { shape: 'deep25', approxNodes: 1_000_000, size: '1m' },
  { shape: 'wide-aoo', approxNodes: 1_000_000, size: '1m' },
] as const;
