/**
 * Cosmos DB accessor for user documents. Users are stored in the `users`
 * container, one document per signed-in user, keyed by the stable Entra
 * oid (falling back to sub). The partition key is `/id`.
 *
 * Document shape (see DESIGN_SPEC.md §Entities / User):
 * ```
 * {
 *   id: string,                    // Entra oid; partition key
 *   displayName?: string,
 *   email?: string,
 *   preferences: UserPreferences,
 *   version: number,               // monotonic, surfaced as ETag
 *   createdAt: string,             // ISO
 *   updatedAt: string              // ISO
 * }
 * ```
 *
 * Concurrency: `version` is the client-facing concurrency token; on
 * the wire to Cosmos we use the shared `replaceWithIfMatch` helper,
 * which also enforces server-side `_etag` IfMatch so the
 * version + replace pair is atomic from the client's point of view.
 *
 * Schema evolution: legacy stored docs predating the `version` field
 * are read-fold-defaulted to `version: 1` by `normalizeStoredUser`.
 * The next write naturally emits `version: 2`. See DESIGN_SPEC.md
 * -> Versioning -> Schema evolution (Additive playbook).
 */
import type { Container, ItemResponse } from '@azure/cosmos';
import { getCosmos, replaceWithIfMatch, type Mutable, type VersionedDocument } from './cosmos';
import type { UserPreferences } from './preferences';

export interface UserDocument extends VersionedDocument {
  id: string;
  displayName?: string;
  email?: string;
  preferences: UserPreferences;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export class UserAlreadyExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserAlreadyExistsError';
  }
}

let cached: Container | undefined;

export function getUsersContainer(): Container {
  if (!cached) {
    cached = getCosmos().database.container('users');
  }
  return cached;
}

/** Reset the cached container - used by tests. */
export function __resetUsersContainerForTesting(): void {
  cached = undefined;
}

/**
 * Read-side fold for the additive `version` field. Legacy stored
 * docs without `version` are treated as `version: 1`. Per the
 * "Additive" playbook in DESIGN_SPEC.md -> Versioning -> Schema
 * evolution, no migration script is needed; new writes naturally
 * emit canonical shape.
 */
export function normalizeStoredUser(doc: UserDocument): UserDocument {
  if (typeof doc.version === 'number' && Number.isInteger(doc.version) && doc.version > 0) {
    return doc;
  }
  return { ...doc, version: 1 };
}

export async function readUser(id: string): Promise<UserDocument | null> {
  try {
    const { resource } = await getUsersContainer().item(id, id).read<UserDocument>();
    return resource ? normalizeStoredUser(resource) : null;
  } catch (error) {
    if ((error as { code?: number }).code === 404) return null;
    throw error;
  }
}

/**
 * Insert a new user document. Throws `UserAlreadyExistsError` when
 * the partition already contains a doc with this `id` (Cosmos 409).
 * Used by the first-time seed path; ongoing edits go through
 * `replaceUser`.
 */
export async function createUser(doc: UserDocument): Promise<UserDocument> {
  try {
    const response: ItemResponse<UserDocument> =
      await getUsersContainer().items.create<UserDocument>(doc);
    return response.resource ?? doc;
  } catch (error) {
    if ((error as { code?: number }).code === 409) {
      throw new UserAlreadyExistsError(`User ${doc.id} already exists`);
    }
    throw error;
  }
}

/**
 * Replace an existing user doc using the shared `replaceWithIfMatch`
 * helper. The mutator may freely modify `displayName`, `email`,
 * `preferences`, and `updatedAt`; the helper preserves `id` and bumps
 * `version` to `existing.version + 1`. Concurrency is enforced
 * server-side via the Cosmos `_etag` IfMatch; mismatches throw
 * `VersionConflictError`.
 */
export async function replaceUser(
  existing: UserDocument,
  mutate: (draft: Mutable<UserDocument>) => void,
): Promise<UserDocument> {
  return replaceWithIfMatch<UserDocument>(getUsersContainer(), existing.id, existing, mutate);
}
