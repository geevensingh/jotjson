// Deterministic JSON fixture generator for the perf measurement suite.
//
// Importable both from TypeScript (build-tree bench, parse bench) and
// directly from Node ESM after compilation by `tsc -p tsconfig.perf.json`.
// File has zero repo-internal imports.
//
// Determinism: every fixture is generated with a `mulberry32(seed)`
// PRNG, with the seed baked in at module load. The generator
// `generate.test.mjs` asserts golden SHA-256 hashes for key variants so
// drift across machines and CI is loud, not silent.
//
// Sizes are expressed in NODE COUNTS (not bytes). 1M nodes is the
// canonical "user pain" stress.

export type FixtureShape = 'deep25' | 'wide-aoo';

export interface FixtureOptions {
  shape: FixtureShape;
  /** Approximate target node count, includes the root. */
  approxNodes: number;
  /** PRNG seed. Defaults to 0xC0FFEE. */
  seed?: number;
}

const DEFAULT_SEED = 0xc0ffee;

/**
 * mulberry32 PRNG. ~6 lines, well-understood, no deps. Returns the
 * same sequence on every run for a given seed.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEY_POOL: readonly string[] = [
  'id',
  'name',
  'value',
  'count',
  'kind',
  'status',
  'createdAt',
  'updatedAt',
  'flags',
  'tags',
];

/**
 * Picks a primitive value type from the JSON discriminant space.
 * Tuned to roughly match real-world payloads: lots of strings, some
 * numbers, occasional booleans/nulls.
 */
function randomLeaf(rng: () => number): string | number | boolean | null {
  const dice = rng();
  if (dice < 0.55) return `value-${Math.floor(rng() * 1_000_000).toString(36)}`;
  if (dice < 0.8) return Math.floor(rng() * 1_000_000);
  if (dice < 0.92) return rng() < 0.5;
  return null;
}

/**
 * Builds a `deep25` fixture: a 25-deep chain of single-key objects
 * whose leaf is an array of N pseudo-random primitives. Stresses
 * the deep-path / formatPath code path on every leaf, plus a wide
 * array tail. Total node count is exactly `DEPTH + approxNodes + 1`
 * (`+1` for the root).
 */
function buildDeep25(rng: () => number, approxNodes: number): unknown {
  const DEPTH = 25;
  const arrSize = Math.max(0, approxNodes - DEPTH);
  const arr: unknown[] = new Array(arrSize);
  for (let i = 0; i < arrSize; i++) arr[i] = randomLeaf(rng);
  let inner: unknown = arr;
  for (let d = DEPTH - 1; d >= 0; d--) {
    const wrapper: Record<string, unknown> = {};
    wrapper[`level_${d}`] = inner;
    inner = wrapper;
  }
  return inner;
}

/**
 * Builds a `wide-aoo` fixture: an array of small objects (~10 keys
 * each) at the top level. Stresses the wide-array-of-objects path
 * common in API responses. Each object contributes 11 nodes (1
 * container + 10 leaves).
 */
function buildWideAoo(rng: () => number, approxNodes: number): unknown {
  const KEYS_PER_OBJECT = 10;
  const nodesPerItem = KEYS_PER_OBJECT + 1;
  const itemCount = Math.max(1, Math.floor((approxNodes - 1) / nodesPerItem));
  const items: Record<string, unknown>[] = new Array(itemCount);
  for (let i = 0; i < itemCount; i++) {
    const item: Record<string, unknown> = {};
    for (let k = 0; k < KEYS_PER_OBJECT; k++) {
      item[KEY_POOL[k % KEY_POOL.length]!] = randomLeaf(rng);
    }
    items[i] = item;
  }
  return items;
}

/**
 * Produces a minified JSON string. Returned value is suitable for
 * direct paste into the editor; downstream layers serialize / parse it
 * the same way the production code path does.
 */
export function generate(options: FixtureOptions): string {
  const rng = mulberry32(options.seed ?? DEFAULT_SEED);
  let value: unknown;
  switch (options.shape) {
    case 'deep25':
      value = buildDeep25(rng, options.approxNodes);
      break;
    case 'wide-aoo':
      value = buildWideAoo(rng, options.approxNodes);
      break;
    default: {
      const exhaustive: never = options.shape;
      throw new Error(`Unknown fixture shape: ${exhaustive as string}`);
    }
  }
  return JSON.stringify(value);
}
