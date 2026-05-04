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
 *   highlights?: BlobHighlight[],
 *   version: number,      // monotonic client-facing revision
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
import { parse, type ParseError } from 'jsonc-parser';
import {
  getCosmos,
  replaceWithIfMatch,
  VersionConflictError,
  type VersionedDocument,
} from './cosmos';

export interface BlobHighlight {
  path: string;
  color: string;
  cascade: boolean;
}

export interface BlobDocument extends VersionedDocument {
  id: string;
  slug: string;
  content: string;
  title?: string;
  ownerId: string;
  isPublic: boolean;
  highlights?: BlobHighlight[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBlobInput {
  content: unknown;
  title?: unknown;
  isPublic?: unknown;
  highlights?: unknown;
}

export interface UpdateBlobPatch {
  content?: unknown;
  title?: unknown;
  isPublic?: unknown;
  highlights?: unknown;
}

export const MAX_BLOB_BYTES = 1_000_000; // 1 MB, per DESIGN_SPEC section Constraints
export const MAX_HIGHLIGHTS = 100;
export const MAX_HIGHLIGHT_PATH_LENGTH = 1024;
export const MAX_HIGHLIGHTS_SERIALIZED_CHARS = 16_384;
// Keeps the existing 1 MB raw-content allowance while bounding highlight overhead
// to 16 KB plus a small JSON envelope.
export const MAX_BLOB_DOCUMENT_SERIALIZED_CHARS =
  MAX_BLOB_BYTES + MAX_HIGHLIGHTS_SERIALIZED_CHARS + 128;
export const MAX_TITLE_LENGTH = 200;
export const MAX_BLOBS_PER_USER = 100; // free-tier quota, DESIGN_SPEC section Constraints
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

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const IDENTIFIER_START = /^[A-Za-z_$]$/;
const IDENTIFIER_PART = /^[A-Za-z0-9_$]$/;
const DECIMAL_DIGIT = /^[0-9]$/;
const NON_ZERO_DECIMAL_DIGIT = /^[1-9]$/;
const HEX_DIGIT = /^[0-9a-fA-F]$/;
const HIGHLIGHT_KEYS = ['path', 'color', 'cascade'] as const;
const JSON_STRING_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeVersion(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1;
}

function normalizeBlobDocument(doc: BlobDocument): BlobDocument {
  const version = normalizeVersion(doc.version);
  return doc.version === version ? doc : { ...doc, version };
}

function isDecimalDigit(character: string | undefined): boolean {
  return character !== undefined && DECIMAL_DIGIT.test(character);
}

function assertBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new BlobValidationError(`${field} must be a boolean`);
  }
  return value;
}

function consumeIdentifier(path: string, startIndex: number): number | null {
  const firstCharacter = path[startIndex];
  if (!firstCharacter || !IDENTIFIER_START.test(firstCharacter)) {
    return null;
  }

  let index = startIndex + 1;
  while (index < path.length) {
    const character = path[index];
    if (!character || !IDENTIFIER_PART.test(character)) {
      break;
    }
    index += 1;
  }
  return index;
}

function consumeArrayIndex(path: string, startIndex: number): number | null {
  const firstCharacter = path[startIndex];
  let index = startIndex;
  if (firstCharacter === '0') {
    index += 1;
  } else if (firstCharacter && NON_ZERO_DECIMAL_DIGIT.test(firstCharacter)) {
    index += 1;
    while (isDecimalDigit(path[index])) {
      index += 1;
    }
  } else {
    return null;
  }

  if (path[index] !== ']') {
    return null;
  }
  return index + 1;
}

function consumeJsonString(path: string, quoteIndex: number): number | null {
  let index = quoteIndex + 1;
  while (index < path.length) {
    const character = path[index];
    if (!character) {
      return null;
    }
    if (character.charCodeAt(0) < 0x20) {
      return null;
    }
    if (character === '"') {
      return index + 1;
    }
    if (character === '\\') {
      index += 1;
      const escapeCharacter = path[index];
      if (!escapeCharacter) {
        return null;
      }
      if (escapeCharacter === 'u') {
        for (let offset = 1; offset <= 4; offset++) {
          if (!HEX_DIGIT.test(path[index + offset] ?? '')) {
            return null;
          }
        }
        index += 5;
      } else if (JSON_STRING_ESCAPES.has(escapeCharacter)) {
        index += 1;
      } else {
        return null;
      }
      continue;
    }
    index += 1;
  }
  return null;
}

function parseCanonicalJsonString(jsonText: string): string | null {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(jsonText, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (errors.length > 0 || typeof parsed !== 'string') {
    return null;
  }
  if (JSON.stringify(parsed) !== jsonText) {
    return null;
  }
  return parsed;
}

function consumeBracketedString(path: string, quoteIndex: number): number | null {
  const stringEndIndex = consumeJsonString(path, quoteIndex);
  if (stringEndIndex === null || path[stringEndIndex] !== ']') {
    return null;
  }

  const jsonText = path.slice(quoteIndex, stringEndIndex);
  if (parseCanonicalJsonString(jsonText) === null) {
    return null;
  }
  return stringEndIndex + 1;
}

function consumeBracketSegment(path: string, startIndex: number): number | null {
  const firstCharacter = path[startIndex];
  if (firstCharacter === '"') {
    return consumeBracketedString(path, startIndex);
  }
  if (isDecimalDigit(firstCharacter)) {
    return consumeArrayIndex(path, startIndex);
  }
  return null;
}

export function assertHighlightPath(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BlobValidationError('highlight path must be a string');
  }
  if (value.length === 0) {
    throw new BlobValidationError('highlight path is required');
  }
  if (value.length > MAX_HIGHLIGHT_PATH_LENGTH) {
    throw new BlobValidationError(
      `highlight path too long - max ${MAX_HIGHLIGHT_PATH_LENGTH} characters (got ${value.length})`,
    );
  }
  if (value[0] !== '$') {
    throw new BlobValidationError('highlight path must be a canonical JSON tree path');
  }

  let index = 1;
  while (index < value.length) {
    const character = value[index];
    let nextIndex: number | null = null;
    if (character === '.') {
      nextIndex = consumeIdentifier(value, index + 1);
    } else if (character === '[') {
      nextIndex = consumeBracketSegment(value, index + 1);
    }
    if (nextIndex === null) {
      throw new BlobValidationError('highlight path must be a canonical JSON tree path');
    }
    index = nextIndex;
  }

  return value;
}

export function assertHighlightColor(value: unknown): string {
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
    throw new BlobValidationError('highlight color must be a #RRGGBB hex color');
  }
  return value;
}

export function assertHighlight(value: unknown): BlobHighlight {
  if (!isRecord(value)) {
    throw new BlobValidationError('highlight must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!(HIGHLIGHT_KEYS as readonly string[]).includes(key)) {
      throw new BlobValidationError(`highlight has unknown field "${key}"`);
    }
  }
  return {
    path: assertHighlightPath(value['path']),
    color: assertHighlightColor(value['color']),
    cascade: assertBool(value['cascade'], 'highlight.cascade'),
  };
}

export function assertHighlights(value: unknown): BlobHighlight[] {
  if (!Array.isArray(value)) {
    throw new BlobValidationError('highlights must be an array');
  }
  if (value.length > MAX_HIGHLIGHTS) {
    throw new BlobValidationError(
      `highlights has too many entries - max ${MAX_HIGHLIGHTS} (got ${value.length})`,
    );
  }

  const seenPaths = new Set<string>();
  const highlights: BlobHighlight[] = [];
  for (const entry of value) {
    const highlight = assertHighlight(entry);
    if (seenPaths.has(highlight.path)) {
      throw new BlobValidationError(`highlights contains duplicate path "${highlight.path}"`);
    }
    seenPaths.add(highlight.path);
    highlights.push(highlight);
  }
  return highlights;
}

function validateBlobDocumentSize(content: string, highlights: BlobHighlight[] | undefined): void {
  const normalizedHighlights = highlights ?? [];
  const serializedHighlightsLength = JSON.stringify(normalizedHighlights).length;
  if (serializedHighlightsLength > MAX_HIGHLIGHTS_SERIALIZED_CHARS) {
    throw new BlobValidationError(
      `highlights too large - max ${MAX_HIGHLIGHTS_SERIALIZED_CHARS} serialized characters (got ${serializedHighlightsLength})`,
    );
  }

  const serializedDocumentLength = JSON.stringify({
    content,
    highlights: normalizedHighlights,
  }).length;
  if (serializedDocumentLength > MAX_BLOB_DOCUMENT_SERIALIZED_CHARS) {
    throw new BlobValidationError(
      `blob document too large - max ${MAX_BLOB_DOCUMENT_SERIALIZED_CHARS} serialized characters including content and highlights (got ${serializedDocumentLength})`,
    );
  }
}

function validateContent(content: unknown): string {
  if (typeof content !== 'string') {
    throw new BlobValidationError('content must be a string');
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_BLOB_BYTES) {
    throw new BlobValidationError(`content too large - max ${MAX_BLOB_BYTES} bytes (got ${bytes})`);
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
      `title too long - max ${MAX_TITLE_LENGTH} characters (got ${trimmed.length})`,
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
      parameters: [{ name: '@key', value: idOrSlug }],
    })
    .fetchAll();
  const found = resources[0];
  return found ? normalizeBlobDocument(found) : null;
}

async function slugExists(slug: string): Promise<boolean> {
  const { resources } = await getBlobsContainer()
    .items.query<{ id: string }>({
      query: 'SELECT VALUE c.id FROM c WHERE c.slug = @slug',
      parameters: [{ name: '@slug', value: slug }],
    })
    .fetchAll();
  return resources.length > 0;
}

/**
 * Create a new blob. Generates a unique slug by retrying on collision up to
 * MAX_SLUG_ATTEMPTS times before giving up.
 */
export async function createBlob(ownerId: string, input: CreateBlobInput): Promise<BlobDocument> {
  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    throw new BlobValidationError('ownerId is required');
  }
  const content = validateContent(input.content);
  const title = validateTitle(input.title);
  const isPublic = validateIsPublic(input.isPublic);
  const highlights =
    input.highlights !== undefined ? assertHighlights(input.highlights) : undefined;
  validateBlobDocumentSize(content, highlights);

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
      `Failed to generate a unique slug after ${MAX_SLUG_ATTEMPTS} attempts`,
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
    ...(highlights !== undefined ? { highlights } : {}),
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  const response: ItemResponse<BlobDocument> =
    await getBlobsContainer().items.create<BlobDocument>(doc);
  return response.resource ?? doc;
}

/**
 * Apply a patch to an existing blob. Validates each supplied field, stamps
 * `updatedAt`, and replaces the document in place. `id`, `slug`, `ownerId`,
 * and `createdAt` are always preserved.
 */
export async function updateBlob(
  existing: BlobDocument,
  patch: UpdateBlobPatch,
  expectedVersion: number,
): Promise<BlobDocument> {
  const current = normalizeBlobDocument(existing);
  if (current.version !== expectedVersion) {
    throw new VersionConflictError(
      `Blob was modified by another writer (expected version ${expectedVersion}, found ${current.version})`,
    );
  }

  const result = await replaceWithIfMatch<BlobDocument>(
    getBlobsContainer(),
    current.ownerId,
    current,
    (draft) => {
      if (patch.content !== undefined) {
        draft.content = validateContent(patch.content);
      }
      if (patch.title !== undefined) {
        const title = validateTitle(patch.title);
        if (title === undefined) {
          delete draft.title;
        } else {
          draft.title = title;
        }
      }
      if (patch.isPublic !== undefined) {
        draft.isPublic = validateIsPublic(patch.isPublic);
      }
      if (patch.highlights !== undefined) {
        draft.highlights = assertHighlights(patch.highlights);
      }
      validateBlobDocumentSize(draft.content, draft.highlights);
      draft.updatedAt = new Date().toISOString();
    },
  );
  return normalizeBlobDocument(result);
}

/**
 * Delete a blob by (id, ownerId). Returns `true` if the doc was removed,
 * `false` if it did not exist. Callers must have already verified ownership
 * via `findBlobByIdOrSlug` + owner check.
 */
export async function deleteBlobById(id: string, ownerId: string): Promise<boolean> {
  try {
    await getBlobsContainer().item(id, ownerId).delete();
    return true;
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code === 404) return false;
    throw error;
  }
}

/**
 * List every blob owned by `ownerId`, most-recently-updated first. Uses the
 * partition key, so this is a single-partition query (no cross-partition RU
 * cost). Not paginated - callers are capped at 100 blobs per user by the
 * quota enforced on insert.
 */
export async function listBlobsByOwner(ownerId: string): Promise<BlobDocument[]> {
  if (typeof ownerId !== 'string' || ownerId.length === 0) return [];
  const { resources } = await getBlobsContainer()
    .items.query<BlobDocument>({
      query: 'SELECT * FROM c WHERE c.ownerId = @ownerId ORDER BY c.updatedAt DESC',
      parameters: [{ name: '@ownerId', value: ownerId }],
    })
    .fetchAll();
  return resources.map(normalizeBlobDocument);
}
