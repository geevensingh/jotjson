# CI-only Cosmos DB account for api-integration tests (#63)

The `api-integration` v1 gate (issue #63) runs Jest against a real
Azure Cosmos DB account dedicated to CI. This document covers the
**one-time provisioning** the repo owner does before the gate goes
active. It is NOT relevant to most contributors - PRs from forks
skip the integration job gracefully (no secrets), and most local
work doesn't need this.

## Why a separate account from production

Production Cosmos (`infra/modules/cosmosDb.bicep`) is a **serverless**
account. Cosmos free tier is for **provisioned-throughput** accounts,
not serverless. The CI account is a separate provisioned-throughput
account with the free-tier flag, distinct from the production
serverless account. This gives the CI gate:

- Production-grade Cosmos service (faithful query / partition-key /
  continuation-token semantics, unlike the `vnext-preview` Linux
  emulator we rejected).
- Zero monthly cost (free tier covers 1000 RU/s + 25 GB forever).
- Isolation from production data and credentials.

The test validates Cosmos API semantics, partition keys, document
shape preservation, and indexing-policy correctness. It does NOT
validate serverless billing behavior or the production deployment
itself.

## Prerequisites

- Azure CLI installed and `az login` complete.
- Azure subscription with permissions to create Cosmos accounts.
- A resource group to put the CI account in (reuse an existing CI
  rg if you have one).

## Pre-check: free-tier slot availability

Each Azure subscription gets exactly **one** free-tier Cosmos
account. If your subscription already has one (e.g., a personal-use
production account), you have to use a different subscription or
fall back to a regular serverless or provisioned-throughput account
for CI.

```bash
az cosmosdb list \
  --query "[?enableFreeTier==\`true\`].[name, resourceGroup]" \
  -o table
```

Sample output if a free-tier account already exists in this
subscription:

```
Column1               Column2
--------------------  ----------------
existing-cosmos-acct  some-resource-grp
```

If the output is empty (no rows), your subscription's free-tier slot
is available - proceed with the steps below.

If the output shows an existing free-tier account that you don't
want to reuse for CI, you have two paths:

- **Use a different subscription** (preferred if you have one).
- **Use a regular serverless account** (no free-tier flag). Cost at
  the test volume of #63 is pennies/month. Adapt the create command
  below by removing `--enable-free-tier true` and adding
  `--capabilities EnableServerless`. The shared-throughput database
  step is replaced by a regular database without `--throughput`.

## Provisioning steps

Replace `<rg>` with your resource group name and adjust the account
name `jotjson-ci-cosmos` as desired (must be globally unique within
Cosmos's account-name namespace).

### 1. Create the Cosmos account with free tier

```bash
az cosmosdb create \
  --name jotjson-ci-cosmos \
  --resource-group <rg> \
  --enable-free-tier true \
  --kind GlobalDocumentDB \
  --default-consistency-level Session \
  --locations regionName=<your-region>
```

Choose a region close to where GitHub-hosted runners actually run
(GitHub-hosted runners default to a few US/EU regions; `eastus`,
`westus2`, or `westeurope` are reasonable defaults).

### 2. Create the shared-throughput database

The `jotjson-ci` database holds **all** per-run test containers, sharing
its 1000 RU/s allocation. Per-run containers underneath don't need
their own throughput.

```bash
az cosmosdb sql database create \
  --account-name jotjson-ci-cosmos \
  --resource-group <rg> \
  --name jotjson-ci \
  --throughput 1000
```

The `--throughput 1000` parameter activates shared throughput on this
database. (Without it, per-container throughput is required, which
breaks the free-tier model.)

### 3. Read the endpoint and primary key

```bash
ENDPOINT=$(az cosmosdb show \
  --name jotjson-ci-cosmos \
  --resource-group <rg> \
  --query documentEndpoint -o tsv)
echo "Endpoint: $ENDPOINT"

KEY=$(az cosmosdb keys list \
  --name jotjson-ci-cosmos \
  --resource-group <rg> \
  --query primaryMasterKey -o tsv)
echo "Key: <redacted; copy from terminal>"
```

### 4. Add GitHub repo secrets

In GitHub: **Settings -> Secrets and variables -> Actions -> New
repository secret**:

| Secret name           | Value                                |
|-----------------------|--------------------------------------|
| `COSMOS_CI_ENDPOINT`  | the value of `$ENDPOINT` above       |
| `COSMOS_CI_KEY`       | the value of `$KEY` above            |

The `api-integration` CI job activates on the next workflow run after
both secrets are present. Until then, the job logs "skipping
integration tests" and exits 0 - it does NOT block PR merge in that
state.

### 5. Verify

Open a small PR that touches the api or integration code. Confirm
the `Smoke api integration` job runs and is green. Optionally also
test locally:

```bash
export COSMOS_CI_ENDPOINT="$ENDPOINT"
export COSMOS_CI_KEY="$KEY"
export COSMOS_DATABASE=jotjson-ci
export COSMOS_BLOBS_CONTAINER="blobs-local-$(date +%s)"
npm --prefix api run test:integration
```

The test creates a per-run container, runs the smoke, and drops the
container at the end.

## Marking #63 as an active v1 gate

Per the #63 plan §D12 phased rollout, after secrets are wired and a
green CI run confirms the gate works, the gate becomes "active". A
separate doc-only PR updates `DESIGN_SPEC.md`'s testing-strategy
table to reflect the active status (and updates branch-protection
required-check lists once PR-by-default also lands - that's a
separate Pre-v1 readiness item).

## Manual orphan cleanup

The integration test has three layers of automated cleanup (Jest
globalTeardown, CI `if: always()` step, setup-time orphan sweep).
If a runner cancellation leaks a container that the next run's
preflight doesn't catch (e.g., it's < 24h old), you can drop
orphans manually:

```bash
export COSMOS_CI_ENDPOINT="$ENDPOINT"
export COSMOS_CI_KEY="$KEY"
npm --prefix api run cleanup:cosmos-ci
```

This lists all `blobs-*` containers older than 24h and drops them.
It is safe to run any time; it never touches the canonical `blobs`
container (which doesn't have the `blobs-` prefix and lives in a
different account anyway).

## Troubleshooting

- **"Cosmos free tier already enabled in subscription"**: see the
  pre-check above; you've hit the one-per-subscription limit.
- **"Container creation 429 retry exhausted"**: real Cosmos can be
  slow during region-wide spikes. The harness retries with
  exponential backoff (3 attempts, base 500ms). Re-run the workflow.
- **"More than 20 blobs-* containers"**: setup throws this hard cap
  to stay under Cosmos's 25-container shared-throughput limit. Run
  `npm --prefix api run cleanup:cosmos-ci` to drop orphans.

<!-- mergify-test-target: temporary marker to verify Mergify auto-update; will be closed without merging -->
