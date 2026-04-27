/**
 * Cosmos DB accessor for HistoryEntry documents. History entries are stored
 * in the `history` container, partitioned by `/userId`. Records the
 * authenticated user's `viewed` events on shared blobs they don't own,
 * for the "Recently viewed" timeline UI.
 *
 * Document shape (matches DESIGN_SPEC §Domain Model / HistoryEntry):
 * ```
 * {
 *   id: string,        // UUID - Cosmos primary key
 *   userId: string,    // Entra oid of the actor; partition key
 *   blobId?: string,   // Source blob UUID
 *   slug?: string,     // Snapshot of the blob's slug at record time
 *   title?: string,    // Snapshot of the blob's title at record time
 *   accessedAt: string,// ISO timestamp
 *   action: "viewed"
 * }
 * ```
 *
 * v1 narrowing (post-M5d): only `viewed` is recorded; legacy rows of
 * other action types are filtered out by `listEntries` and age out via
 * FIFO. See DESIGN_SPEC §M5 for context.
 *
 * Retention: 1,000 entries per user, FIFO-pruned on each write.
 * View debounce: 5 minutes per (user, blob), enforced via getRecentViewAt.
 */
import type { Container } from '@azure/cosmos';
import { randomUUID } from 'crypto';
import { getCosmos } from './cosmos';

export type HistoryAction = 'viewed';

export const HISTORY_ACTIONS: ReadonlySet<HistoryAction> = new Set<HistoryAction>([
  'viewed'
]);

export interface HistoryDocument {
  id: string;
  userId: string;
  blobId?: string;
  slug?: string;
  title?: string;
  accessedAt: string;
  action: HistoryAction;
}

export interface RecordEntryInput {
  userId: string;
  action: HistoryAction;
  blobId?: string;
  slug?: string;
  title?: string;
}

export interface ListEntriesOptions {
  pageSize?: number;
  continuationToken?: string;
  /**
   * Case-insensitive substring filter applied to `title` and `slug`. The
   * caller is expected to have already trimmed and lower-cased the value;
   * empty strings are treated as "no filter".
   */
  q?: string;
  /**
   * Inclusive lower bound on accessedAt (ISO string). Caller validates
   * format; this accessor passes the value through verbatim.
   */
  from?: string;
  /** Inclusive upper bound on accessedAt (ISO string). */
  to?: string;
}

export interface ListEntriesResult {
  entries: HistoryDocument[];
  continuationToken?: string;
}

export const HISTORY_RETENTION_PER_USER = 1000;
export const VIEW_DEBOUNCE_SECONDS = 300;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

let cached: Container | undefined;

export function getHistoryContainer(): Container {
  if (!cached) {
    cached = getCosmos().database.container('history');
  }
  return cached;
}

/** Reset the cached container - used by tests. */
export function __resetHistoryContainerForTesting(): void {
  cached = undefined;
}

/**
 * Insert a new entry and prune the oldest entries past the retention cap.
 * Returns the persisted document. Pruning failures are swallowed: the
 * caller should treat history writes as best-effort, and a missed prune
 * just leaves a few extra rows that the next write will catch.
 */
export async function recordEntry(input: RecordEntryInput): Promise<HistoryDocument> {
  if (typeof input.userId !== 'string' || input.userId.length === 0) {
    throw new Error('userId is required');
  }
  const doc: HistoryDocument = {
    id: randomUUID(),
    userId: input.userId,
    accessedAt: new Date().toISOString(),
    action: input.action,
    ...(input.blobId !== undefined ? { blobId: input.blobId } : {}),
    ...(input.slug !== undefined ? { slug: input.slug } : {}),
    ...(input.title !== undefined ? { title: input.title } : {})
  };
  const response = await getHistoryContainer().items.create<HistoryDocument>(doc);
  const saved = response.resource ?? doc;
  // Best-effort prune; never let a prune failure surface to the caller.
  try {
    await pruneFifo(input.userId);
  } catch {
    // Ignored - the next write will retry pruning.
  }
  return saved;
}

/**
 * Enforce the per-user retention cap. Counts entries for the user; if
 * over HISTORY_RETENTION_PER_USER, deletes the oldest entries (by
 * accessedAt, then id as deterministic tiebreaker) until the count
 * equals the cap. Returns the number of entries deleted.
 */
export async function pruneFifo(userId: string): Promise<number> {
  const container = getHistoryContainer();
  const { resources: countRows } = await container.items
    .query<number>({
      query: 'SELECT VALUE COUNT(1) FROM c WHERE c.userId = @uid',
      parameters: [{ name: '@uid', value: userId }]
    }, { partitionKey: userId })
    .fetchAll();
  const total = countRows[0] ?? 0;
  if (total <= HISTORY_RETENTION_PER_USER) return 0;

  const overflow = total - HISTORY_RETENTION_PER_USER;
  const { resources: oldest } = await container.items
    .query<{ id: string }>({
      query:
        'SELECT TOP @n c.id FROM c WHERE c.userId = @uid ORDER BY c.accessedAt ASC, c.id ASC',
      parameters: [
        { name: '@uid', value: userId },
        { name: '@n', value: overflow }
      ]
    }, { partitionKey: userId })
    .fetchAll();
  let deleted = 0;
  for (const row of oldest) {
    try {
      await container.item(row.id, userId).delete();
      deleted++;
    } catch (error) {
      // Tolerate 404 from concurrent prune; rethrow anything else so the
      // caller's catch block can log it.
      const code = (error as { code?: number }).code;
      if (code !== 404) throw error;
    }
  }
  return deleted;
}

/**
 * Return the ISO timestamp of the user's most recent `"viewed"` entry
 * for the given blob, or `null` if none exists. Used by the GET
 * /api/blobs/{idOrSlug} endpoint to enforce the
 * VIEW_DEBOUNCE_SECONDS server-side debounce.
 */
export async function getRecentViewAt(
  userId: string,
  blobId: string
): Promise<string | null> {
  const { resources } = await getHistoryContainer().items
    .query<{ accessedAt: string }>({
      query:
        'SELECT TOP 1 c.accessedAt FROM c WHERE c.userId = @uid AND c.action = "viewed" AND c.blobId = @bid ORDER BY c.accessedAt DESC',
      parameters: [
        { name: '@uid', value: userId },
        { name: '@bid', value: blobId }
      ]
    }, { partitionKey: userId })
    .fetchAll();
  return resources[0]?.accessedAt ?? null;
}

/**
 * Page through a user's entries, newest first. Cosmos returns a
 * continuation token when more rows remain; pass it back on the next call
 * via `options.continuationToken`. The token is opaque - clients echo it
 * verbatim.
 */
export async function listEntries(
  userId: string,
  options: ListEntriesOptions = {}
): Promise<ListEntriesResult> {
  const pageSize = Math.min(
    Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE
  );
  const q = typeof options.q === 'string' ? options.q.trim() : '';
  // Lower-case once on the server so the Cosmos call doesn't have to
  // recompute LOWER(@q) per row. The query side wraps the column values
  // in LOWER(...) so the comparison stays case-insensitive.
  const qLower = q.toLowerCase();
  const parameters: { name: string; value: string | number | string[] }[] = [
    { name: '@uid', value: userId }
  ];
  let where = 'c.userId = @uid AND c.action = "viewed"';
  if (qLower) {
    where +=
      ' AND (CONTAINS(LOWER(c.title), @q) OR CONTAINS(LOWER(c.slug), @q))';
    parameters.push({ name: '@q', value: qLower });
  }
  if (typeof options.from === 'string' && options.from.length > 0) {
    where += ' AND c.accessedAt >= @from';
    parameters.push({ name: '@from', value: options.from });
  }
  if (typeof options.to === 'string' && options.to.length > 0) {
    where += ' AND c.accessedAt <= @to';
    parameters.push({ name: '@to', value: options.to });
  }
  const iterator = getHistoryContainer().items.query<HistoryDocument>(
    {
      query: `SELECT * FROM c WHERE ${where} ORDER BY c.accessedAt DESC`,
      parameters
    },
    {
      partitionKey: userId,
      maxItemCount: pageSize,
      ...(options.continuationToken
        ? { continuationToken: options.continuationToken }
        : {})
    }
  );
  const response = await iterator.fetchNext();
  return {
    entries: response.resources ?? [],
    ...(response.continuationToken
      ? { continuationToken: response.continuationToken }
      : {})
  };
}

/**
 * Delete every history entry for the user. Returns the count deleted.
 * Iterates the partition in pages of 100 to keep memory bounded.
 */
export async function clearAll(userId: string): Promise<number> {
  const container = getHistoryContainer();
  let totalDeleted = 0;
  // Iterate until the partition is empty. Each pass reads up to 100 ids
  // and deletes them; this avoids loading the whole partition into RAM
  // for users near the 1k cap.
  while (true) {
    const { resources } = await container.items
      .query<{ id: string }>({
        query: 'SELECT TOP 100 c.id FROM c WHERE c.userId = @uid',
        parameters: [{ name: '@uid', value: userId }]
      }, { partitionKey: userId })
      .fetchAll();
    if (resources.length === 0) break;
    for (const row of resources) {
      try {
        await container.item(row.id, userId).delete();
        totalDeleted++;
      } catch (error) {
        const code = (error as { code?: number }).code;
        if (code !== 404) throw error;
      }
    }
  }
  return totalDeleted;
}
