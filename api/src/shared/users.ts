/**
 * Cosmos DB accessor for user documents. Users are stored in the `users`
 * container, one document per signed-in user, keyed by the stable Entra
 * oid (falling back to sub). The partition key is `/id`.
 *
 * Document shape:
 * ```
 * {
 *   id: string,                    // Entra oid
 *   displayName?: string,
 *   email?: string,
 *   preferences: UserPreferences,
 *   createdAt: string,             // ISO
 *   updatedAt: string              // ISO
 * }
 * ```
 */
import type { Container, ItemResponse } from '@azure/cosmos';
import { getCosmos } from './cosmos';
import type { UserPreferences } from './preferences';

export interface UserDocument {
  id: string;
  displayName?: string;
  email?: string;
  preferences: UserPreferences;
  createdAt: string;
  updatedAt: string;
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

export async function readUser(id: string): Promise<UserDocument | null> {
  try {
    const { resource } = await getUsersContainer()
      .item(id, id)
      .read<UserDocument>();
    return resource ?? null;
  } catch (err) {
    if ((err as { code?: number }).code === 404) return null;
    throw err;
  }
}

export async function upsertUser(doc: UserDocument): Promise<UserDocument> {
  const response: ItemResponse<UserDocument> = await getUsersContainer().items.upsert<UserDocument>(
    doc
  );
  return response.resource ?? doc;
}
