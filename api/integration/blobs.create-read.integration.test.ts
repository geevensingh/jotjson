/**
 * api-integration: blob create -> read round-trip against real Cosmos
 * (#63, first slice).
 *
 * Validates:
 *  - createBlob writes via the production code path to the per-run
 *    container.
 *  - findBlobByIdOrSlug reads the same document back by id (point read
 *    on the partition key).
 *  - findBlobByIdOrSlug reads the same document back by slug
 *    (cross-partition query).
 *  - Document shape is preserved end-to-end through Cosmos including
 *    optional fields, version stamping, and ISO-8601 timestamps.
 *
 * Out of scope for this slice: update, delete, list, slug-collision
 * retry, continuation-token pagination. Those will be added in
 * follow-up integration tests.
 */

import { randomUUID } from 'crypto';
import {
  __resetBlobsContainerForTesting,
  createBlob,
  findBlobByIdOrSlug,
} from '../src/shared/blobs';
import { __resetCosmosForTesting } from '../src/shared/cosmos';

describe('api-integration: blob create -> read round-trip', () => {
  beforeAll(() => {
    // Defensive reset: we run in a separate Jest invocation from the
    // unit suite, but the shared module state is global. Reset to
    // ensure the tests get a fresh client pointed at the per-run
    // container (COSMOS_BLOBS_CONTAINER set by the workflow).
    __resetCosmosForTesting();
    __resetBlobsContainerForTesting();
  });

  it('createBlob then findBlobByIdOrSlug round-trips by id and by slug', async () => {
    const ownerId = randomUUID();
    const content = '{"hello":"world","count":42}';
    const title = 'integration-test';

    const created = await createBlob(ownerId, {
      content,
      title,
    });

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.slug).toMatch(/^[A-Za-z0-9]{6}$/);
    expect(created.ownerId).toBe(ownerId);
    expect(created.content).toBe(content);
    expect(created.title).toBe(title);
    expect(created.version).toBe(1);
    expect(created.createdAt).toBe(created.updatedAt);
    expect(new Date(created.createdAt).toString()).not.toBe('Invalid Date');

    const byId = await findBlobByIdOrSlug(created.id);
    expect(byId).not.toBeNull();
    expect(byId?.id).toBe(created.id);
    expect(byId?.slug).toBe(created.slug);
    expect(byId?.ownerId).toBe(ownerId);
    expect(byId?.content).toBe(content);
    expect(byId?.title).toBe(title);
    expect(byId?.version).toBe(1);

    const bySlug = await findBlobByIdOrSlug(created.slug);
    expect(bySlug).not.toBeNull();
    expect(bySlug?.id).toBe(created.id);
    expect(bySlug?.slug).toBe(created.slug);
    expect(bySlug?.ownerId).toBe(ownerId);
    expect(bySlug?.content).toBe(content);
  });
});
