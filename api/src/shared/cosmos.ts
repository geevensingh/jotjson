import type { Container, ItemResponse } from '@azure/cosmos';
import { CosmosClient, Database } from '@azure/cosmos';
// `@azure/identity` is loaded lazily inside `getCosmos` (only on the
// dead-code AAD branch) because its transitive dep on `@azure/msal-node`
// pulls in `uuid` (ESM-only). Importing it at the top level forces every
// test that does `jest.requireActual('./cosmos')` to drag the ESM chain
// through Jest's CJS transformer, which fails under a clean CI install.
// The `aadCredentials` branch is reserved for the future M7o
// BYO-Functions migration; in production today the COSMOS_KEY branch is
// always taken, so the lazy require has no startup cost in the prod hot
// path.

let cachedClient: CosmosClient | undefined;
let cachedDatabase: Database | undefined;

export class CosmosConfigurationError extends Error {
  readonly statusCode = 500;
  constructor(message: string) {
    super(message);
    this.name = 'CosmosConfigurationError';
  }
}

/**
 * Returns a cached Cosmos DB client and database handle.
 *
 * Auth precedence (per `DESIGN_SPEC.md` Cosmos DB authentication):
 *  1. `COSMOS_KEY` env var - the production path. Required in any
 *     Azure-host environment (`WEBSITE_INSTANCE_ID` set) because the
 *     SWA managed-Functions runtime does not expose managed identity
 *     to the Function process. Also the conventional local-dev path,
 *     supplied via `local.settings.json`.
 *  2. `DefaultAzureCredential` - reserved for the future M7o
 *     BYO-Functions migration. Today this branch is only useful on a
 *     developer workstation that has run `az login`. In an Azure-host
 *     env, missing `COSMOS_KEY` is a hard configuration error and we
 *     fail fast rather than silently fall through to broken upstream
 *     code (see 5/1 incident retrospective).
 *
 * `COSMOS_ENDPOINT` is always required. `COSMOS_DATABASE` defaults to
 * `jotjson`.
 */
export function getCosmos(): { client: CosmosClient; database: Database } {
  if (!cachedClient || !cachedDatabase) {
    const endpoint = process.env['COSMOS_ENDPOINT'];
    const key = process.env['COSMOS_KEY'];
    const dbName = process.env['COSMOS_DATABASE'] ?? 'jotjson';

    if (!endpoint) {
      throw new Error('COSMOS_ENDPOINT must be set');
    }

    if (!key && process.env['WEBSITE_INSTANCE_ID']) {
      throw new CosmosConfigurationError(
        'COSMOS_KEY app setting is required in Azure-host environments. ' +
          'See DESIGN_SPEC.md "Cosmos DB authentication". The DefaultAzureCredential ' +
          'branch is reserved for the future M7o BYO-Functions migration.',
      );
    }

    cachedClient = key
      ? new CosmosClient({ endpoint, key })
      : new CosmosClient({
          endpoint,
          aadCredentials: new (
            require('@azure/identity') as typeof import('@azure/identity')
          ).DefaultAzureCredential(),
        });
    cachedDatabase = cachedClient.database(dbName);
  }
  return { client: cachedClient, database: cachedDatabase };
}

/** Reset the cached client - used by tests. */
export function __resetCosmosForTesting(): void {
  cachedClient = undefined;
  cachedDatabase = undefined;
}

// =============================================================================
// Versioned-document concurrency primitives
// =============================================================================

/**
 * Every Cosmos document JotJSON stores carries an integer `version`
 * field that is the client-facing revision number. The Cosmos
 * system field `_etag` is the only thing Cosmos's `IfMatch`
 * precondition accepts; we keep both because they answer different
 * questions:
 *
 *  - `version` is the wire contract: we surface it as a strong
 *    `ETag: "<n>"` header, clients send it back as
 *    `If-Match: "<n>"`, the handler rejects mismatches with 412.
 *    It is monotonic and meaningful across rebuilds / migrations.
 *  - `_etag` is the storage primitive: opaque, vendor-managed,
 *    and the ONLY value the Cosmos SDK accepts as an `IfMatch`
 *    condition. It MUST never reach the wire because clients have
 *    no use for it and exposing it leaks Cosmos vendor detail.
 *
 * `_etag` is therefore stripped at the response boundary by
 * `stripCosmosMetadata`, and the helper below re-strips on the
 * write body so callers cannot accidentally smuggle a stale value
 * back into Cosmos.
 */
export interface VersionedDocument {
  id: string;
  version: number;
  /**
   * Cosmos system ETag. Server-managed. Stripped on every write
   * via `replaceWithIfMatch` and on every response via
   * `stripCosmosMetadata`. Never crosses the wire.
   */
  _etag?: string;
}

/**
 * The mutator-parameter type for `replaceWithIfMatch`. Strips the
 * three fields the helper itself owns (`id`, `version`, `_etag`)
 * so callers cannot reassign them via TypeScript. Resource-specific
 * accessors typically narrow further (e.g., also stripping
 * `userId`, `createdAt`, `ownerId` etc.).
 */
export type Mutable<T extends VersionedDocument> = Omit<T, 'id' | 'version' | '_etag'>;

/** Public response shape: same as `T` but without `_etag`. */
export type PublicShape<T extends VersionedDocument> = Omit<T, '_etag'>;

/**
 * Thrown when a Cosmos `IfMatch` write returns 412. The handler
 * layer translates this to a 412 HTTP response.
 */
export class VersionConflictError extends Error {
  readonly statusCode = 412;
  constructor(message: string) {
    super(message);
    this.name = 'VersionConflictError';
  }
}

/**
 * Thrown for invariant violations inside the Cosmos helper layer
 * that should never fire in production. Today the only case is "a
 * document we just read from Cosmos has no `_etag` field" - real
 * Cosmos always populates this, so the only way this fires is via
 * a misconfigured test fake.
 *
 * Distinct from `VersionConflictError` because programming bugs
 * must NOT be hidden as concurrency conflicts. Falls through to
 * the default `internalError` 500 path so the bug is logged loudly.
 */
export class CosmosInvariantError extends Error {
  readonly statusCode = 500;
  constructor(message: string) {
    super(message);
    this.name = 'CosmosInvariantError';
  }
}

/**
 * True when the given thrown value is a Cosmos 412 PreconditionFailed.
 * Cosmos surfaces this as either `code: 412` (numeric) or
 * `code: 'PreconditionFailed'` (string) depending on SDK version.
 * Digit-string `'412'` is intentionally NOT accepted here: it has
 * never been observed from the `Items#replace` call this helper
 * catches, and broadening the predicate without evidence would add
 * an untested behavior path to the api's 412 -> VersionConflictError
 * translation.
 *
 * Broader Cosmos error-code normalization (covering 404/409/412 in
 * numeric, digit-string, and named-alias shapes) lives in
 * `scripts/cosmos-back-sync.mjs:getErrorCode`. The two helpers
 * deliberately have different accepted-shape sets: this helper is a
 * single-purpose 412 classifier used only by `replaceWithIfMatch`,
 * while `getErrorCode` is a multi-shape normalizer used at multiple
 * call sites (read 404, write 409/412). The cross-reference is for
 * navigation, not shape parity.
 *
 * If a future SDK release adds a new string alias for 412
 * (analogous to `'PreconditionFailed'`), register it in both
 * helpers in the same change.
 */
export function isCosmosPreconditionFailed(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 412 || code === 'PreconditionFailed';
}

/**
 * The single allowed Cosmos replace primitive. Lints elsewhere ban
 * direct `.item(...).replace(` and `.upsert(` so this helper is the
 * only path for in-place updates.
 *
 * Contract:
 *  - `existing` MUST be a freshly-read Cosmos document carrying the
 *    server's current `_etag`. The helper throws
 *    `CosmosInvariantError` if `_etag` is missing.
 *  - The `mutate` callback receives a deep clone of `existing`
 *    narrowed to `Mutable<T>` (no `id`, no `version`, no `_etag`).
 *    Resource accessors should further narrow per-type immutables
 *    via their own `Omit<T, ...>` shape.
 *  - The mutator MUST be synchronous. If you need async work,
 *    perform it BEFORE calling this helper.
 *  - After the mutator returns the helper defensively re-strips
 *    `_etag` from the draft (in case a runtime cast smuggled it
 *    back), restores `id` from `existing` (same), and bumps
 *    `version` to `existing.version + 1`. Callers that try to bump
 *    `version` themselves are simply overwritten.
 *  - The `IfMatch` precondition is built from `existing._etag`.
 *    A 412 from Cosmos is translated into `VersionConflictError`.
 *
 * Returns the resource Cosmos returned (the post-write doc with
 * the new server-assigned `_etag`). Callers that surface the doc
 * to clients must run `stripCosmosMetadata` on it first.
 */
export async function replaceWithIfMatch<T extends VersionedDocument>(
  container: Container,
  partitionKey: string,
  existing: T,
  mutate: (draft: Mutable<T>) => void,
): Promise<T> {
  if (!existing._etag) {
    throw new CosmosInvariantError(
      'replaceWithIfMatch: existing document is missing _etag. Real Cosmos ' +
        'always populates this; the most likely cause is a test fake that ' +
        "doesn't stamp _etag on stored documents.",
    );
  }

  const ifMatch = existing._etag;

  // Deep clone so the mutator cannot mutate `existing` (which the
  // caller may still hold and observe). structuredClone handles
  // nested arrays/objects; a shallow spread would not.
  const draft = structuredClone(existing) as T;

  // Strip _etag *before* the mutator so the mutator type narrowing
  // (`Mutable<T>`) lines up with runtime shape. Then run the mutator.
  delete draft._etag;
  mutate(draft as Mutable<T>);

  // Defensive: even though `Mutable<T>` excludes these at the type
  // level, a runtime cast could put them back. Strip / restore /
  // bump unconditionally so the helper, not the caller, owns these.
  delete draft._etag;
  draft.id = existing.id;
  draft.version = existing.version + 1;

  try {
    const ifMatchOpts = { accessCondition: { type: 'IfMatch' as const, condition: ifMatch } };
    const response: ItemResponse<T> = await container
      .item(existing.id, partitionKey)
      .replace<T>(draft, ifMatchOpts); // allow:cosmos-replace internal-only
    return response.resource ?? draft;
  } catch (error) {
    if (isCosmosPreconditionFailed(error)) {
      throw new VersionConflictError(
        `Document was modified by another writer (id=${existing.id}, ` +
          `expected version ${existing.version})`,
      );
    }
    throw error;
  }
}

/**
 * Returns a copy of `doc` with `_etag` removed, typed as
 * `PublicShape<T>` so handler code cannot accidentally keep
 * threading `_etag` downstream. Apply at every response site.
 */
export function stripCosmosMetadata<T extends VersionedDocument>(doc: T): PublicShape<T> {
  const { _etag: _ignored, ...rest } = doc;
  return rest as PublicShape<T>;
}
