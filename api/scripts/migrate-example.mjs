#!/usr/bin/env node
/**
 * Template for a one-shot operator-run Cosmos migration script.
 *
 * Schema renames in JotJSON follow the playbook in
 * DESIGN_SPEC.md -> Versioning -> Schema evolution. Step 4 of the
 * rename playbook is "ship a one-shot script that reads every
 * affected doc and re-saves any straggler in the legacy shape."
 * This file is the starting template for that script: copy it to
 * `api/scripts/migrate-<topic>.mjs`, fill in the TODOs, and run it
 * once after the deploy that lands the rename.
 *
 * Usage (local):
 *   COSMOS_ENDPOINT=https://...
 *   COSMOS_KEY=...
 *   COSMOS_DATABASE=jotjson
 *   JOTJSON_MIGRATION_CONFIRMED=1 node api/scripts/migrate-<topic>.mjs
 *
 * The fail-fast guard below stops accidental invocations of the
 * unedited template (or invocations without an explicit
 * acknowledgement) before they touch Cosmos.
 */

import { CosmosClient } from '@azure/cosmos';

if (!process.env.JOTJSON_MIGRATION_CONFIRMED) {
  console.error('migrate-example.mjs is a TEMPLATE. Copy it to api/scripts/migrate-<topic>.mjs,');
  console.error('fill in the per-rename normalize-and-write logic, then re-run with');
  console.error('JOTJSON_MIGRATION_CONFIRMED=1 set in the environment.');
  process.exit(1);
}

const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const databaseName = process.env.COSMOS_DATABASE ?? 'jotjson';
// TODO(per-rename): set the container name for the docs being migrated.
const containerName = 'users';

if (!endpoint || !key) {
  console.error('COSMOS_ENDPOINT and COSMOS_KEY must be set.');
  process.exit(1);
}

const client = new CosmosClient({ endpoint, key });
const container = client.database(databaseName).container(containerName);

let total = 0;
let touched = 0;

const iterator = container.items.query({ query: 'SELECT * FROM c' }).getAsyncIterator();

for await (const page of iterator) {
  for (const doc of page.resources) {
    total += 1;

    // TODO(per-rename): inspect doc for the legacy shape. Skip when
    // already canonical so we do not churn updatedAt for clean docs.
    const needsMigration = false;
    if (!needsMigration) continue;

    // TODO(per-rename): build the canonical doc shape. Strip legacy
    // keys; preserve every other field; bump updatedAt.
    const next = { ...doc, updatedAt: new Date().toISOString() };

    // TODO(per-rename): pass the correct partition-key value for this
    // container (often doc.id or doc.userId). The replace call below
    // assumes id-as-partition-key for the example.
    await container.item(doc.id, doc.id).replace(next);
    touched += 1;
  }
}

console.log(`migrate-example: scanned ${total} docs, re-saved ${touched}.`);
