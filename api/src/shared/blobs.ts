/**
 * Cosmos DB accessor for JSON blob documents. Blobs are stored in the `blobs`
 * container, partitioned by `/ownerId`. Each blob has a UUID primary key (`id`)
 * and a NanoID(6) short slug used for public URLs (`/s/:slug`).
 *
 * Document shape (matches DESIGN_SPEC §Entities / JsonBlob):
 * ```
 * {
 *   id: string,           // UUID - Cosmos primary key
 *   slug: string,         // NanoID(6), unique across the container
 *   content: string,      // raw JSON/JSONC text
 *   title?: string,
 *   ownerId: string,      // Entra oid of the owner; partition key
 *   isPublic: boolean,
 *   createdAt: string,    // ISO
 *   updatedAt: string     // ISO
 * }
 * ```
 *
 * GET lookups can accept either `id` or `slug`. Neither is the partition key
 * alone, so lookups are cross-partition queries. The `blobs` container is
 * small (100 docs/user cap) and lives on serverless throughput, so the extra
 * RU cost is acceptable for v1; revisit if this becomes hot.
 */
import type { Container, ItemResponse } from '@azure/cosmos';
import { randomBytes, randomUUID } from 'crypto';
import { getCosmos } from './cosmos';

export interface BlobDocument {
  id: string;
  slug: string;
  content: string;
  title?: string;
  ownerId: string;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBlobInput {
  content: string;
  title?: string;
  isPublic?: boolean;
}

export interface UpdateBlobPatch {
  content?: string;
  title?: string;
  isPublic?: boolean;
}

export const MAX_BLOB_BYTES = 1_000_000; // 1 MB, per DESIGN_SPEC §Constraints
export const MAX_TITLE_LENGTH = 200;
export const SLUG_LENGTH = 6;
export const MAX_SLUG_ATTEMPTS = 5;

// Alphanumeric only - avoids URL-unfriendly or visually ambiguous characters.
// This is effectively a tiny in-process NanoID implementation using
// node:crypto rejection sampling, which keeps us CJS-compatible (nanoid 5.x
// ships ESM-only and would drag in package.json "type": "module" changes).
const SLUG_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function generateSlug(length: number = SLUG_LENGTH): string {
  const mask = 63; // 6 bits, SLUG_ALPHABET.length === 62 < 64
  const step = Math.ceil((length * 1.6) | 0) || 1;
  let result = '';
  while (result.length < length) {
    const bytes = randomBytes(step);
    for (let i = 0; i < bytes.length && result.length < length; i++) {
      const byte = (bytes[i] ?? 0) & mask;
      if (byte < SLUG_ALPHABET.length) {
        result += SLUG_ALPHABET[byte];
      }
    }
  }
  return result;
}

export class BlobValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobValidationError';
  }
}

export class SlugGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlugGenerationError';
  }
}

let cached: Container | undefined;

export function getBlobsContainer(): Container {
  if (!cached) {
    cached = getCosmos().database.container('blobs');
  }
  return cached;
}

/** Reset the cached container - used by tests. */
export function __resetBlobsContainerForTesting(): void {
  cached = undefined;
}

function validateContent(content: unknown): string {
  if (typeof content !== 'string') {
    throw new BlobValidationError('content must be a string');
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_BLOB_BYTES) {
    throw new BlobValidationError(
      `content too large - max ${MAX_BLOB_BYTES} bytes (got ${bytes})`
    );
  }
  return content;
}

function validateTitle(title: unknown): string | undefined {
  if (title === undefined || title === null || title === '') return undefined;
  if (typeof title !== 'string') {
    throw new BlobValidationError('title must be a string');
  }
  const trimmed = title.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw new BlobValidationError(
      `title too long - max ${MAX_TITLE_LENGTH} characters (got ${trimmed.length})`
    );
  }
  return trimmed;
}

function validateIsPublic(isPublic: unknown): boolean {
  if (isPublic === undefined) return false;
  if (typeof isPublic !== 'boolean') {
    throw new BlobValidationError('isPublic must be a boolean');
  }
  return isPublic;
}

/**
 * Look up a blob by either its UUID `id` or its NanoID `slug`. Cross-partition
 * query - returns null if not found.
 */
export async function findBlobByIdOrSlug(idOrSlug: string): Promise<BlobDocument | null> {
  if (typeof idOrSlug !== 'string' || idOrSlug.length === 0) return null;
  const { resources } = await getBlobsContainer()
    .items.query<BlobDocument>({
      query: 'SELECT * FROM c WHERE c.id = @key OR c.slug = @key',
      parameters: [{ name: '@key', value: idOrSlug }]
    })
    .fetchAll();
  return resources[0] ?? null;
}

async function slugExists(slug: string): Promise<boolean> {
  const { resources } = await getBlobsContainer()
    .items.query<{ id: string }>({
      query: 'SELECT VALUE c.id FROM c WHERE c.slug = @slug',
      parameters: [{ name: '@slug', value: slug }]
    })
    .fetchAll();
  return resources.length > 0;
}

/**
 * Create a new blob. Generates a unique slug by retrying on collision up to
 * MAX_SLUG_ATTEMPTS times before giving up.
 */
export async function createBlob(
  ownerId: string,
  input: CreateBlobInput
): Promise<BlobDocument> {
  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    throw new BlobValidationError('ownerId is required');
  }
  const content = validateContent(input.content);
  const title = validateTitle(input.title);
  const isPublic = validateIsPublic(input.isPublic);

  let slug: string | undefined;
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const candidate = generateSlug();
    if (!(await slugExists(candidate))) {
      slug = candidate;
      break;
    }
  }
  if (!slug) {
    throw new SlugGenerationError(
      `Failed to generate a unique slug after ${MAX_SLUG_ATTEMPTS} attempts`
    );
  }

  const now = new Date().toISOString();
  const doc: BlobDocument = {
    id: randomUUID(),
    slug,
    content,
    ...(title !== undefined ? { title } : {}),
    ownerId,
    isPublic,
    createdAt: now,
    updatedAt: now
  };

  const response: ItemResponse<BlobDocument> = await getBlobsContainer()
    .items.create<BlobDocument>(doc);
  return response.resource ?? doc;
}

/**
 * Apply a patch to an existing blob. Validates each supplied field, stamps
 * `updatedAt`, and replaces the document in place. `id`, `slug`, `ownerId`,
 * and `createdAt` are always preserved.
 */
export async function updateBlob(
  existing: BlobDocument,
  patch: UpdateBlobPatch
): Promise<BlobDocument> {
  const next: BlobDocument = { ...existing };
  if (patch.content !== undefined) {
    next.content = validateContent(patch.content);
  }
  if (patch.title !== undefined) {
    const title = validateTitle(patch.title);
    if (title === undefined) {
      delete next.title;
    } else {
      next.title = title;
    }
  }
  if (patch.isPublic !== undefined) {
    next.isPublic = validateIsPublic(patch.isPublic);
  }
  next.updatedAt = new Date().toISOString();

  const response: ItemResponse<BlobDocument> = await getBlobsContainer()
    .item(existing.id, existing.ownerId)
    .replace<BlobDocument>(next);
  return response.resource ?? next;
}

/**
 * Delete a blob by (id, ownerId). Returns `true` if the doc was removed,
 * `false` if it did not exist. Callers must have already verified ownership
 * via `findBlobByIdOrSlug` + owner check.
 */
export async function deleteBlobById(
  id: string,
  ownerId: string
): Promise<boolean> {
  try {
    await getBlobsContainer().item(id, ownerId).delete();
    return true;
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 404) return false;
    throw err;
  }
}

/**
 * List every blob owned by `ownerId`, most-recently-updated first. Uses the
 * partition key, so this is a single-partition query (no cross-partition RU
 * cost). Not paginated - callers are capped at 100 blobs per user by the
 * quota enforced on insert.
 */
export async function listBlobsByOwner(
  ownerId: string
): Promise<BlobDocument[]> {
  if (typeof ownerId !== 'string' || ownerId.length === 0) return [];
  const { resources } = await getBlobsContainer()
    .items.query<BlobDocument>({
      query:
        'SELECT * FROM c WHERE c.ownerId = @ownerId ORDER BY c.updatedAt DESC',
      parameters: [{ name: '@ownerId', value: ownerId }]
    })
    .fetchAll();
  return resources;
}
