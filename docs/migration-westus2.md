# Region migration: eastus2 -> westus2 + rename dev -> prod

Snapshot of the v7 migration plan (with critic-pass gates) that motivates the
following PRs:

- #375 - Maintenance banner (PR-B)
- #376 - Bicep parameterization (PR-A)
- #377 - Cosmos back-sync script (PR-D)
- #378 - Cutover runbook script (PR-C)

This document is the as-of-now snapshot of the plan that produced the four
pre-flight PRs. It is **not** a living spec; `DESIGN_SPEC.md` remains the
authoritative product / architecture spec per AGENTS.md section 1. Once the
migration is executed (or formally cancelled), this file should be either
deleted or moved to an `archive/` folder along with a brief outcome note.

The "Pre-presentation gate" sections at the bottom record the adversarial
critic findings (deep-review:skeptic + deep-review:architect agents) raised
across 5 plan iterations and their dispositions.

---
# Plan: migrate `dev` resources from `eastus2` to `westus2` + rename `dev`->`prod` (v7)

## Decisions (locked, confirmed with user)

| Decision | Value | Notes |
|---|---|---|
| Target region | `westus2` | App Insights tiebreaker moot (AI is in eastus2) |
| App Insights | **Keep in eastus2** | Preserves historical telemetry; accepts cross-region async telemetry egress (~pennies/year) |
| Cosmos backup | **Enable Continuous7Days** | One-way migration; ~$0.006/month at current data size |
| Storage SKU | **Upgrade prod -> `Standard_GZRS`** | Nonprod stays `Standard_LRS` (parameterized) |
| Migration scope | **`dev` only** | `nonprod` stays in eastus2 and serves as rehearsal target |
| Downtime profile | **~45-75 min read-only** | PITR-based; no new API code; banner copy "up to 2 hours" pending rehearsal measurement |
| Rename | **`dev` -> `prod`** for all recreated resources | AI/LAW keep their `appi-jotjson-dev` / `appi-jotjson-dev-law` names (historical wart documented in README) |
| SemVer | **No bump** | Infra-only; documents are bit-for-bit identical |
| Cutover timing | **Weekend** | Phase 3 cutover runs on a Saturday or Sunday (off-peak; less user impact). Phases 0-2 are non-disruptive and can land any weekday. Phase 4 is T+7 days, naturally lands the following weekend. |

## Resource names

Target end state (new = westus2 unless noted):

| Resource | Old (eastus2) | New |
|---|---|---|
| Resource group (compute + data) | `rg-jotjson-dev` | `rg-jotjson-prod` |
| Static Web App | `swa-jotjson-dev` | `swa-jotjson-prod` |
| Cosmos DB account | `cosmos-jotjson-dev` | `cosmos-jotjson-prod` |
| Storage account | `stjotjsondev` | `stjotjsonprod` |
| Action Group | `ag-jotjson-dev-*` | `ag-jotjson-prod-*` |
| Workbooks | `*-jotjson-dev*` | `*-jotjson-prod*` |
| Alerts | `*-jotjson-dev*` | `*-jotjson-prod*` |
| App Insights | `appi-jotjson-dev` | **unchanged** (kept in eastus2, eventually in `rg-jotjson-telemetry`) |
| Log Analytics workspace | `appi-jotjson-dev-law` (per `infra/modules/appInsights.bicep:6`; **not** `log-jotjson-dev`) | **unchanged** (kept in eastus2, eventually in `rg-jotjson-telemetry`) |
| AI/LAW resource group | `rg-jotjson-dev` | `rg-jotjson-telemetry` (new, eastus2; **populated in Phase 4, not Phase 0**) |
| DNS zone resource group | `rg-jotjson-dev` | `rg-jotjson-dns` (new, location-agnostic; populated in Phase 0 **after** PR-A) |
| Bicep param file | `dev.bicepparam` | `prod.bicepparam` (rename + workflow refs in same PR; see Phase 4 step 6) |
| `environmentName` param value | `'dev'` | `'prod'` (already in `@allowed` list) |

Naming principle applied: **don't encode region in resource names**.
Region is metadata; encoding it in the name is the same anti-pattern
as encoding the environment ("dev" meaning prod). Hence `swa-jotjson-prod`,
not `swa-jotjson-prod-west`.

## Side discoveries to track separately

- `rg-jotjson-auth` in `eastus` (note: `eastus`, not `eastus2`). Not
  referenced by Bicep or workflows. Likely manually-provisioned Entra
  External ID supporting resources. **Out of scope.** Filing as a
  tracking issue post-migration.
- **[RESOLVED 2026-05-24, this PR]** `DESIGN_SPEC.md` "Data residency"
  section formerly claimed App Insights is in West US 2; it is
  empirically in eastus2. Per AGENTS.md §1 (`DESIGN_SPEC.md` is
  source of truth), this contradicted the plan's "Decisions" table
  at presentation time. Corrected here. The original prescription
  -- "fix in a separate one-line PR before Phase 0 step 1" -- was
  authored when the truth fix was a critic-v5 finding to land
  pre-Phase-0; with PR-A (#376) and #391 already merged, the
  temporal ordering is moot and the fix folds cleanly into the
  post-merge cleanup PR (this one) closing #392 and #394.

## Out of scope (rationale unchanged)

Multi-region active-active, user-managed AFD, Traffic Manager, Cosmos
provisioned-throughput, Key Vault, AI region move,
`rg-jotjson-auth` ownership.

## Pre-flight PRs (each lands cleanly with its own DoD)

### PR-A: Bicep changes

1. Add to `cosmosDb.bicep`:
   ```
   backupPolicy: {
     type: 'Continuous'
     continuousModeProperties: { tier: 'Continuous7Days' }
   }
   ```
2. Parameterize Storage SKU in `blobStorage.bicep`; default to
   `Standard_GZRS` for prod-env params, `Standard_LRS` for
   nonprod.
3. Add **two** params to `main.bicep` for using an external AI:
   - `existingAppInsightsName string = ''` (e.g.,
     `'appi-jotjson-dev'`, the preserved historical name from
     the dev environment -- see Resource-names table).
   - `existingAppInsightsRg string = ''` (e.g.,
     `'rg-jotjson-telemetry'` after Phase 4 step 2; until then,
     `'rg-jotjson-dev'`).

   When both are non-empty, skip the `insights` module and
   resolve the AI component via an `existing` lookup:
   ```
   resource existingAi 'Microsoft.Insights/components@2020-02-02' existing = if (!empty(existingAppInsightsName) && !empty(existingAppInsightsRg)) {
     name: existingAppInsightsName
     scope: resourceGroup(existingAppInsightsRg)
   }
   ```
   Then feed `existingAi.id` to workbooks and
   `existingAi.properties.ConnectionString` to the SWA's
   `APPLICATIONINSIGHTS_CONNECTION_STRING` appsetting at
   `main.bicep:183` (the conditional collapses cleanly: when
   `existingAppInsightsName` is empty, the original
   `insights.outputs.connectionString` is used).

   **The connection string is never passed via parameter** -- it
   is resolved at deploy time from the live resource. Per
   AGENTS.md §6 ("No secrets in source"), the `InstrumentationKey`
   portion of the connection string is a writable telemetry
   credential and must not land in any param file or `git log`.
   This is the v7 correction to v5/v6's two-param approach
   (`existingAppInsightsId` + `existingAppInsightsConnectionString`),
   which would have committed the credential.

   "Both or neither" enforcement: Bicep has no `assert` outside
   the experimental flag. PR-A enforces it through the PR-C
   script's pre-flight checker (`scripts/migrate-region.mjs`),
   which validates `prod.bicepparam` has both set or neither
   set before any deploy step runs. Same script also enforces
   the same on Phase 4 step 3's redeploy. This shifts the
   contract from "Bicep refuses" to "the runbook script refuses
   before invoking Bicep" -- equivalent operationally.
4. Add `deployMonitoring bool` param to `main.bicep` (default
   `true`). When `false`, skip the following **five** modules:
   - `monitoringActions` (action group; `main.bicep:~80`)
   - `operatorWorkbook` (`main.bicep:104-115`)
   - `productAnalyticsWorkbook` (`main.bicep:124-135`)
   - `swMigrationWorkbook` (`main.bicep:144-155`)
   - `monitoringAlerts` (`main.bicep:157-166`)

   This is the switch Phase 1 uses to avoid double-deploying
   alerts/workbooks against the still-in-`rg-jotjson-dev`
   workspace (which would emit duplicate notifications during
   the 7-day soak). Phase 4 flips it to `true` after AI/LAW move.
   Add an inline comment in `main.bicep` explaining the
   migration motivation so future readers understand why a
   permanent param exists for a one-time operation (and that
   it's reusable for any future "infra without monitoring"
   scenarios).
5. Extract DNS zone provisioning so it can be parameterized with
   an external RG. Specifically: change `module dns
   'modules/dnsZone.bicep' = if (!empty(dnsZoneName))` at
   `main.bicep:193` to `if (!empty(dnsZoneName) &&
   empty(existingDnsZoneRg))`, with new param `existingDnsZoneRg
   string = ''`. When provided and non-empty, **skip the module
   entirely** (assume the zone already exists in the external
   RG). When empty, deploy the zone in the current RG (current
   behavior).

   **Also rewrite the `dnsNameServers` output at `main.bicep:213`**
   (critic v7 Critical finding): the current line is `output
   dnsNameServers array = empty(dnsZoneName) ? [] :
   dns.outputs.nameServers`. With the conditional module above,
   this ternary fails to short-circuit when `existingDnsZoneRg`
   is non-empty (the `dns` module is skipped but the output
   still tries to read it). PR-A item 5 must also rewrite the
   output to: `output dnsNameServers array = (empty(dnsZoneName)
   || !empty(existingDnsZoneRg)) ? [] : dns.outputs.nameServers`.
   Without this, Bicep `build`/`what-if` fails with "dependency
   on a conditional resource that may not be deployed" -- the
   exact failure mode PR-A was trying to avoid.

   This switch decouples Phase 0 step 3's DNS-zone-move from
   `infra.yml`'s deploy cycle. After Phase 0 step 3 moves the
   zone to `rg-jotjson-dns`, the new `prod.bicepparam` sets
   `existingDnsZoneRg = 'rg-jotjson-dns'` so Bicep doesn't try
   to recreate the zone in `rg-jotjson-prod`.

   PR-A's nonprod validation does NOT exercise this switch (PR-A
   defaults it to empty, nonprod's behavior unchanged). The
   prod-side switch happens in Phase 1's `prod.bicepparam`.
6. **`@allowed` / `@maxLength` are already satisfied.**
   `environmentName = 'prod'` is in the allowed set at
   `main.bicep:5`; `appName = 'jotjson'` is 7 chars, within the
   `@maxLength(10)` constraint at `main.bicep:13`. The composed
   `resourceSuffix = 'jotjson-prod'` (12 chars) is NOT subject to
   the `@maxLength` constraint -- the constraint is on `appName`,
   not on the suffix -- so no Bicep changes are needed.
7. **No `existingCosmosAccountId` param.** The v4 "alternative
   ordering" with a placeholder string was unsound. Single
   canonical path: Phase 1 creates `cosmos-jotjson-prod`, Phase 3
   deletes it before final PITR restore.

PR-A is **validated by deploying to nonprod first** -- the new params
default to off (`existingAppInsightsId = ''`,
`existingAppInsightsConnectionString = ''`,
`existingDnsZoneRg = ''`, `deployMonitoring = true`), so nonprod's
deploy semantics don't change.

### PR-B: Maintenance banner

Static banner behind a build-time flag in the SPA. Honest copy:

> "JotJSON is down for maintenance. We'll be back within a couple
> hours. Anonymous shared links will keep working shortly. Signed-in
> features (save, history, rule-sets) are unavailable during this
> window."

Banner copy lives in a static JSON file
(`src/assets/maintenance-banner.json`) so it can be re-shipped
with one workflow_dispatch if the rehearsal shows the wording
should narrow or widen.

**Critical:** PR-B must also add a cache route in
`staticwebapp.config.json` to bypass Azure SWA/AFD's default
~5-60 min static-JSON caching (critic v5 finding):

```json
{
  "route": "/assets/maintenance-banner.json",
  "headers": { "Cache-Control": "no-store" }
}
```

Insert the route **immediately after the `/build-info.json`
route** to keep the no-store-JSON rules contiguous (critic v7
finding: route ordering matters per `scripts/check-swa-config.mjs`;
positioning specific routes contiguously avoids fragile reorders
under future edits). PR-B must also run
`npm run lint:csp-hashes` and pass the `check-swa-config.mjs`
gate per AGENTS.md §6.

### PR-C: Cutover-runbook script

`scripts/migrate-region.mjs`. Idempotent, fails loudly. Includes:

- Fetch earliest-restorable-time before any PITR command runs.
- Cosmos PITR invocation with `<pinned-time>` validated against
  the earliest-restorable-time.
- **Pre-flight delete of `cosmos-jotjson-prod`** (Phase 1-created)
  via `az cosmosdb delete --no-wait` followed by an explicit
  polling loop on `az cosmosdb check-name-exists -n
  cosmos-jotjson-prod` with max 45-min wait (critic v5 finding:
  `az`'s sync delete can return ahead of namespace availability).
- `swaCosmosRole` Bicep module re-deploy targeting the restored
  account name + the NEW SWA's managed-identity principal ID
  (critical: the principal ID is different from old SWA's; the
  script reads `identity.principalId` of the new SWA explicitly).
- AzCopy delta-sync for blob containers.
- Pre/post integrity checks: document count per container, blob
  count per container.
- **SHA-verification helper**: call existing
  `scripts/check-deploy-freshness.mjs` (referenced from
  `cd.yml:406-408`; handles `/build-info.json` fetch with
  exponential backoff, asserts `body.sha === expectedSha`,
  handles status 0 / parse failures / missing-field edge
  cases). Invocation: `node scripts/check-deploy-freshness.mjs
  --origin https://<new-swa-default-hostname> --expected-sha
  <captured-sha>`. Do **not** reinvent this verification
  (critic v7 finding: PR-C had duplicated the logic; the
  existing script is the reference implementation).
- **Pre-flight `existingAppInsightsName` / `existingAppInsightsRg`
  validation**: refuses to run if `prod.bicepparam` has exactly
  one set (must be both or neither). This enforces the PR-A
  item 3 "both or neither" contract since vanilla Bicep can't.
- Abort-criteria checks (see Phase 3 "In-window abort" below).

### PR-D: Back-sync script (pre-built, NOT scripted on demand)

`scripts/cosmos-back-sync.mjs`. Lives in repo so it ships as part of
the runbook artifact, not as panic-coded emergency work. Includes:

- Reads `--cutover-instant-unix-seconds <ts>` argument; refuses to
  run without it.
- Reads `--src` (new account name) and `--dst` (old account
  name) args; refuses to run without both.
- Iterates Cosmos change feed on the **new** account, filtered to
  `_ts >= <cutover-instant>` (the `_ts` filter is a perf
  optimization: without it the back-sync iterates the entire
  restored snapshot. The per-doc strategy below correctly
  no-ops on snapshot docs where `oldDoc._ts >= newDoc._ts`, so
  unfiltered is **slow**, not **wrong**. The filter is still
  required because at our dataset size unfiltered is still
  much slower than necessary).
- **Per-document strategy** (critic v5 Critical finding -- v5's
  naive `If-Match` on NEW account's `_etag` against OLD account
  would 412 on every doc; the fix):
  - For each new-account doc, do `GET` against the OLD account
    by the same partition-key + id.
  - **If OLD returns 404**: unconditional CREATE on OLD account
    (this is a post-cutover new doc with no prior version).
  - **If OLD returns 200**: compare `_ts`. If
    `oldDoc._ts < newDoc._ts`, write with `If-Match:
    "<oldDoc._etag>"`. If `oldDoc._ts >= newDoc._ts`, leave the
    old doc in place (the old account was the live one during
    the rollback window and has fresher data) and log to
    conflicts file.
  - 412 conflicts (concurrent writes during back-sync) are
    logged to a conflicts file, not retried automatically;
    operator reviews and manually reconciles.

**Conflicts file format and location** (critic v7 finding:
v6 was vague):
- Filename: `cosmos-back-sync-conflicts-<ISO8601>.jsonl`
  (e.g., `cosmos-back-sync-conflicts-2026-06-01T03-14-22Z.jsonl`).
  `--dry-run` writes to `cosmos-back-sync-conflicts-dryrun-<ISO8601>.jsonl`.
- Location: operator's current working directory at script
  invocation time (the script logs the full path on startup
  so the operator can `tail -F` it).
- Format: one JSON object per line; fields:
  `{container, id, partitionKey, reason, oldTs, newTs,
  oldEtag, newEtag, attemptedAt}`. `reason` is one of:
  `'old-fresher'` (oldDoc._ts >= newDoc._ts), `'concurrent-write'`
  (412/409 from replace or items.create), `'malformed-source'`
  (source doc failed id / partition-key / _ts validation; operator
  must investigate manually because the script could not classify
  it), `'unknown'` (other errors, including 5xx from read or write).
- Operator runs `jq` queries against the JSONL during
  reconciliation (e.g., `jq 'select(.reason=="concurrent-write")'
  conflicts.jsonl`).
- `--dry-run` flag prints planned operations without writing.
- `--containers <list>` flag scopes the back-sync to specific
  containers (default: all four containers in
  `DESIGN_SPEC.md`).

This script is built once when PR-D lands; it is NOT exercised in
Phase 0 against nonprod-west because nonprod doesn't have the same
write traffic shape. It's an insurance artifact, not a hot path.

### PR-E: env-label classifier (optional, low-priority follow-up)

`src/app/core/env/env-label.ts` currently hardcodes nonprod stem.
When the new prod SWA exists, this hostname classifier resolves to
`'unknown'` for the new SWA's default `*.azurestaticapps.net`
hostname during pre-cutover smoke-tests, producing `[unknown]`
title prefix and unknown-variant favicon. After cutover,
`jotjson.com` classifies normally via the existing apex match.

**Decision: defer.** Documented in Phase 1 step 7 as expected
behavior; the operator should not panic-investigate `[unknown]`
during pre-cutover smoke-test. Filed as follow-up issue post-
migration.

## Phase 0: prep + rehearsal (no `dev` impact)

> **Status convention** (added 2026-05-24): completed steps are
> prefixed with `**[DONE YYYY-MM-DD, PR #NNN]**` (or `this PR` if
> the same PR completing the step also introduced the convention).
> Step numbers never change -- this doc has ~80 "Phase X step Y"
> cross-references that depend on stable numbers (Phase 4 step 4's
> email-confirmation note refers to "Phase 0 step 11"; the risk
> register, the Pre-presentation gate, and the critic-history
> sections also carry step-number pointers). When a step is
> invalidated rather than completed, prefix with
> `**[OBSOLETE YYYY-MM-DD, see #NNN]**` and keep the original body
> (struck through) for the audit trail. Convention applies to all
> phases below.

1. **[DONE 2026-05-24, this PR]** Land the `DESIGN_SPEC.md` "Data
   residency" truth fix PR (critic v5 finding). One-line correction
   stating AI is in eastus2; this removes the contradiction between
   the spec and the plan's "Decisions" table at presentation/review
   time. Folded into this same doc cleanup PR (closes #392 and #394).
2. **[DONE 2026-05-30, operator az CLI]** Pre-flight global uniqueness checks:
   ```
   az storage account check-name --name stjotjsonprod
   az cosmosdb check-name-exists -n cosmos-jotjson-prod
   az cosmosdb check-name-exists -n cosmos-jotjson-prod-rehearse
   ```
   All must return "available" / "doesn't exist." If any are
   squatted, halt and pick fallback names:
   - For `stjotjsonprod` / `cosmos-jotjson-prod`: lock fallback
     names in `prod.bicepparam`.
   - For `cosmos-jotjson-prod-rehearse`: this name is only used
     in Phase 2's `az cosmosdb restore` invocation (NOT in any
     `.bicepparam` file), so fallback handling is just in the
     PR-C script.
3. **[DONE 2026-05-30, operator az CLI]** Pre-flight SKU availability:
   ```
   az rest --method GET \
     --url "https://management.azure.com/subscriptions/<sub-id>/providers/Microsoft.Storage/skus?api-version=2023-01-01" \
     --query "value[?name=='Standard_GZRS' && resourceType=='storageAccounts'].locations" \
     -o json
   ```
   Confirm `westus2` appears in the returned locations array. GZRS
   is supported in westus2 today; this is a defensive guard against
   future SKU rotation. (Use the providers SKUs REST API rather than
   the obvious-looking `az storage account list-skus` -- the latter
   is not a real subcommand.)
4. **[DONE 2026-05-30, operator az CLI]** End-to-end GZRS deployability check (critic v5 finding:
   "listed" != "deployable"; subscription enrollment in zone-
   redundant offers may differ):
   ```
   $rnd = ((New-Guid).Guid -replace '-','').Substring(0,12).ToLower()
   $sa = "stjjskucheck$rnd"
   az group create -n rg-jotjson-skucheck -l westus2
   az storage account create -n $sa -g rg-jotjson-skucheck \
     -l westus2 --sku Standard_GZRS
   az storage account delete -n $sa -g rg-jotjson-skucheck --yes
   az group delete -n rg-jotjson-skucheck --yes --no-wait
   ```
   Validates the GZRS path end-to-end. The 12-char random suffix
   (critic v7 finding: 4-digit was weak entropy / squat risk; 16
   would overflow the 24-char storage-account-name cap with the
   `stjjskucheck` prefix) gives 2^48 entropy -- still squat-proof.
   The `.ToLower()` is defensive: storage account names must be
   lowercase alphanumeric. Discard the test account immediately.
5. **[DONE 2026-05-30, PR #376 + PR #416 + operator-run dispatch]** Land PR-A in nonprod first. Verify Bicep changes deploy
   cleanly with all new params unset (nonprod behavior unchanged).
   Side-effect-via-default note (post-#376 iter-1): with all new
   params unset, `cosmos-jotjson-nonprod` stayed Periodic; a separate
   nonprod Continuous `bicepparam` PR (mirror of #399, tracked as
   `priority:high` issue #404) plus an operator-run
   `workflow_dispatch` of `infra-nonprod.yml` was required before
   step 11's rehearsal could run; satisfied 2026-05-30 (PR #416
   merged, dispatch run id 26481970250, conversion verified
   `Continuous7Days`). Same shape as the dev hole #399 closed.
6. **Move the `jotjson.com` DNS zone to `rg-jotjson-dns`** (new
   RG). **Order mattered** (critic v5 finding: this step would
   have raced against `infra.yml` runs unless the DNS-suppression
   value had already landed in `dev.bicepparam`):
   - **[DONE 2026-05-24, PR #376]** PR-A landed the
     `existingDnsZoneRg` parameter in `main.bicep` plus the DNS
     module conditional gating.
   - **[DONE 2026-05-24, PR #391]** `existingDnsZoneRg =
     'rg-jotjson-dns'` is set in `dev.bicepparam`. This tells the
     Bicep "DNS zone is in `rg-jotjson-dns`, don't try to manage
     it." `main.bicep:238`'s
     `if (!empty(dnsZoneName) && empty(existingDnsZoneRg))` gates
     the `dns` module to false, and `main.bicep:258` short-circuits
     `output dnsNameServers` to `[]`. Any `infra.yml` run between
     now and the move below is a no-op against the live zone
     regardless of which RG currently hosts it.
   - **[DONE 2026-05-30, operator az CLI]** Operator-run move:
     ```
     az group create -n rg-jotjson-dns -l westus2
     az resource move --destination-group rg-jotjson-dns \
       --ids <zone-id>
     ```
     (DNS zones are global resources, but the RG itself requires
     a real region in its metadata; `-l global` is rejected.
     `westus2` chosen to align metadata with the migration target.)
     Move completed in 98.7s with zero external DNS impact (NS
     records preserved across the RG move; public recursive
     resolvers returned unchanged answers post-move).
   - Apex resolution and SOA records unaffected.
7. **AI/LAW move is DEFERRED to Phase 4** (critic v4 finding).
   Moving them in Phase 0 strands the existing alerts in
   `rg-jotjson-dev` because their `scopes:` arrays reference the
   workspace by full ARM path including the old RG, and ARM does
   not retroactively update referring resources. Existing alerts
   stay live through cutover; AI/LAW move happens immediately
   before the new RG's alerts come up in Phase 4.
8. **Land PR-B, PR-C, PR-D in nonprod first**. PR-B validates the
   maintenance-banner cache route in `staticwebapp.config.json`.
   PR-C and PR-D are repo-only artifacts (no infra side effects
   from landing).
9. **[OBSOLETE 2026-05-24, see #376 iter-1 and #399]**
   ~~Apply PR-A to `dev`. This enables continuous backup on the
   source Cosmos account; alone it's a non-disruptive change.~~
   PR-A iter-1 review (#376) made the Periodic branch of
   `cosmosDb.bicep` a true no-op via `union()`
   (`infra/modules/cosmosDb.bicep:15-24`), and `dev.bicepparam`
   does not set `cosmosBackupPolicyType` (defaults to `'Periodic'`
   per `main.bicep:57`), so `cosmos-jotjson-dev` stays Periodic
   under the current state of `main`. The Continuous flip that
   this step originally accomplished is now an explicit
   prerequisite tracked as **`priority:high` issue #399**: a tiny
   `dev.bicepparam` PR (mirror of #391's pattern) setting
   `cosmosBackupPolicyType = 'Continuous'`. **That PR must land
   before step 10's wait begins**; without it Phase 2 step 1's
   `tier=Continuous7Days` query fails and Phase 2 step 2's
   `az cosmosdb restore --account-name cosmos-jotjson-dev` would
   error on a Periodic source.
10. **[DONE 2026-05-30, PR #405 (dev) + PR #416 (nonprod); both Continuous7Days]** Wait for continuous-backup conversion on `cosmos-jotjson-dev`
    to complete (Azure docs: several hours; check via portal).
    **Note the conversion's completion time** -- the first
    restorable point is only available *after* completion. Phase 2
    step 1's `tier=Continuous7Days` query depends on this.
    Subsequent PITRs must use
    `<pinned-time> >= completion-time + restore-window-padding`.
    (Wait semantic unchanged from v7; the source-account anchor
    is now explicit, replacing the previous implicit "PR-A enables
    it" framing in the now-obsolete step 9.)
11. **Rehearse end-to-end against nonprod**: create `nonprod-west`
    in westus2, PITR-restore from nonprod's Cosmos, validate every
    Phase 1-3 step:
    - **Prerequisite**: `cosmos-jotjson-nonprod` must already be on
      Continuous backup before this step begins (PITR from a Periodic
      source fails). The nonprod Continuous `bicepparam` PR flagged
      in step 5 (issue #404) must land, `infra-nonprod.yml` must be
      manually dispatched, and the conversion must be verified via:

      ```
      az cosmosdb show -g rg-jotjson-nonprod -n cosmos-jotjson-nonprod \
        --query backupPolicy.continuousModeProperties.tier
      ```

      Expected: `"Continuous7Days"`. (Satisfied 2026-05-30 -- see
      step 5's marker above. The check is still worth re-running
      immediately before step 11 to confirm the state hasn't
      regressed.)
    - Cosmos RBAC re-grant against restored account.
    - SWA deploy-token rotation logic (test-only target).
    - SHA-verification of `build-info.json` after deploy.
    - Apex rebind against a **test** DNS name (e.g.,
      `rehearsal.jotjson.com` if we provision a temporary
      subdomain; **not** the apex itself).
    - **Fire a test alert** against a recreated nonprod-west
      Action Group, verify the `jotjsonadmin@gmail.com` email
      lands. Azure Monitor email receivers require the recipient
      to acknowledge the initial confirmation; alerts that fire
      before ack are dropped.
    - **Exercise signed-in flows** against `nonprod-west`. The
      nonprod SPA bundle is built per-deploy with a configurable
      `DEPLOY_REDIRECT_URI`; redirect it to `nonprod-west`'s
      `*.azurestaticapps.net` hostname for the rehearsal build,
      add that hostname to the nonprod Entra app's redirect URIs,
      and run the full sign-in / save-blob / save-rule-set /
      list-history flow.
    - **Pin down the real restore time** for our dataset shape.
      Update `maintenance-banner.json` if the rehearsal shows the
      copy should change. If rehearsal shows reliable <75 min,
      narrow the copy to "up to 90 min" for the prod cutover.
      If it shows >2h, widen further.
12. Tear `nonprod-west` down. Document rehearsal output (timing,
    surprises, runbook deltas) in a runbook artifact.

## Phase 1: parallel stack in westus2 (no `dev` impact)

1. **Add `prod.bicepparam`** alongside (NOT replacing) `dev.bicepparam`.
   Targeting `westus2` with `environmentName = 'prod'`. Resource
   suffix is `jotjson-prod`. Both param files coexist until Phase 4
   step 6.
2. Set in `prod.bicepparam`:
   - `existingAppInsightsName` = `'appi-jotjson-dev'` (the
     preserved historical name).
   - `existingAppInsightsRg` = `'rg-jotjson-dev'` (still in the
     dev RG until Phase 4 step 2 moves it).
   - `existingDnsZoneRg` = `'rg-jotjson-dns'` (zone was moved in
     Phase 0 step 6).
   - `dnsZoneName` = `'jotjson.com'` (kept as today; the corrected
     `main.bicep:213` output handles the conditional cleanly).
   - `customDomain` = `''` (explicit: critic v7 edge case --
     phase 3 step 8 binds the apex via the portal, NOT via Bicep,
     to avoid a Phase 1 customDomain-binding race against the
     still-live OLD SWA's binding to `jotjson.com`).
   - `deployMonitoring` = `false` (Phase 1 does NOT create
     workbooks/alerts/AG in the new RG; old RG's monitoring
     continues firing throughout cutover. Phase 4 flips this to
     `true` after AI/LAW move).
   - Storage SKU = `Standard_GZRS`.

   **No connection-string param** (critic v7 fix to v6): the
   AI connection string is resolved at deploy time via PR-A
   item 3's `existing` resource lookup; it is never stored
   in `prod.bicepparam`.
3. **Deploy mechanism for Phase 1** (critic v5 finding:
   `infra.yml` is hardcoded to `rg-jotjson-dev`; Phase 1 needs an
   explicit out-of-workflow path):
   - The deploy is run **manually from the operator's shell**
     using `az deployment group create`. Phase 4 step 6 is when
     `infra.yml` catches up to the new RG / param-file names.
   - **`infra.yml`'s CI gates do NOT run on `prod.bicepparam`**
     (critic v7 finding: `infra.yml:141` only runs `az bicep
     build-params` against `dev.bicepparam`; the PR that adds
     `prod.bicepparam` lands green even if it has syntax
     errors). Operator must validate `prod.bicepparam` locally
     before deploying:
     ```
     az bicep build-params --file infra/parameters/prod.bicepparam
     # Must exit 0; any non-zero exit is a stop-and-fix.
     az deployment group what-if \
       --resource-group rg-jotjson-prod \
       --template-file infra/main.bicep \
       --parameters infra/parameters/prod.bicepparam
     # Review the what-if output; abort if surprises.
     ```
   - Command (run from repo root, with `az` logged in to the
     prod subscription):
     ```
     az group create -n rg-jotjson-prod -l westus2
     az deployment group create \
       --resource-group rg-jotjson-prod \
       --template-file infra/main.bicep \
       --parameters infra/parameters/prod.bicepparam \
       --parameters \
         entraTenantId=<from-prod-secrets> \
         entraAuthority=<from-prod-secrets> \
         entraSpaClientId=<from-prod-secrets> \
         entraApiClientId=<from-prod-secrets> \
         entraApiAudience=<from-prod-secrets>
     ```
   - Bypassing `infra.yml` for Phase 1 is deliberate: local
     `bicep build-params` + `what-if` substitute for the
     workflow's CI gates until Phase 4 step 6 wires the
     workflow up to the new RG / param-file.
4. This creates:
   - `swa-jotjson-prod` (Static Web App, empty bundle)
   - `cosmos-jotjson-prod` (Cosmos account, fresh, with
     continuous backup enabled per PR-A)
   - `stjotjsonprod` (Storage, GZRS, empty)
   - `swaCosmosRole` (RBAC binding from new SWA's managed
     identity to the fresh Cosmos account)
   - NO action group, workbooks, or alerts (deferred to Phase 4)
   - NO DNS zone (existing zone in `rg-jotjson-dns` referenced
     via `existingDnsZoneRg`)

   Note: the Phase-1-created `cosmos-jotjson-prod` exists ONLY to
   satisfy Bicep's contract during the parallel-stack-up phase.
   Phase 3 deletes it before the final PITR restore takes the
   same name.
5. **Verify Functions runtime parity** with eastus2:
   ```
   az staticwebapp show -n swa-jotjson-prod -g rg-jotjson-prod \
     --query properties.apiRuntime
   ```
   Match against eastus2's value.
6. **Audit for hardcoded SWA hostnames across the whole repo**:
   ```
   rg .azurestaticapps.net -g '!node_modules' -g '!coverage' -g '!dist'
   ```
   Action: **decide per-occurrence**, don't replace en masse.
   Known prod-SWA-stem hits include `README.md:9` (preview
   link). Many references may be intentional (e.g., a doc
   explaining how the SWA default hostname differs from the
   apex, or `env-label.ts` nonprod-stem constant). Replace only
   where the reference is stale and points at the soon-to-be-
   deleted old prod SWA stem. Nonprod SWA-stem references
   (e.g., `src/app/core/env/env-label.ts:39`, `src/index.html:311`,
   `infra/README.md:221`) are fine because nonprod isn't moving.
7. **Smoke-test anonymous flows** against the new SWA's default
   `*.azurestaticapps.net` hostname.
   - **Note**: The env-label classifier (`src/app/core/env/env-label.ts:39`)
     will resolve to `'unknown'` for the new SWA's default
     hostname, producing `[unknown]` title prefix and unknown-
     variant favicon. This is **expected pre-cutover**; after
     cutover, `jotjson.com` classifies normally via the apex
     match. PR-E is a deferred follow-up for the SWA-default-
     hostname case.
   - **Signed-in flows cannot be tested pre-cutover** (prod
     redirect URI is hardcoded in
     `src/environments/environment.prod.ts:10-11`); the Phase 0
     nonprod rehearsal covers signed-in correctness.

## Phase 2: data sync (no `dev` impact yet)

1. **Fetch earliest restorable time**:
   ```
   az cosmosdb show -g rg-jotjson-dev -n cosmos-jotjson-dev \
     --query backupPolicy.continuousModeProperties.tier
   ```
   Confirm continuous mode is active. Then derive the earliest
   restorable instant.
2. **PITR restore to a rehearse name** (validates the restore
   workflow against actual prod data without touching the
   eventual final-restore namespace):
   ```
   az cosmosdb restore --location westus2 \
     --target-database-account-name cosmos-jotjson-prod-rehearse \
     --account-name cosmos-jotjson-dev \
     --restore-timestamp <pinned-time> \
     --resource-group rg-jotjson-prod
   ```
3. **Re-run `swaCosmosRole`** against `cosmos-jotjson-prod-rehearse`
   with the new SWA's managed-identity principal ID. Validate
   that the RBAC re-grant logic in PR-C works end-to-end.
4. **Verify continuous backup mode** on the restored account;
   PITR restores do not carry over `backupPolicy`:
   ```
   az cosmosdb update --backup-policy-type Continuous ...
   ```
   if not already set.
5. **Temporarily wire new SWA app settings** to point at
   `cosmos-jotjson-prod-rehearse`. Test anonymous data-plane
   access (e.g., fetch a shared blob by slug; verify it returns
   the prod data). **Revert app settings** back to the Phase-1-
   created `cosmos-jotjson-prod` (or null them out) before
   Phase 3, since the rehearse account is about to be deleted.

   **Warning**: between Phase 3 step 2 (delete rehearse + Phase-1
   accounts) and Phase 3 step 6 (re-wire to final restored
   account), the new SWA's appsettings point at a deleted
   account. **Freeze smoke-test traffic against the new SWA's
   default hostname during Phase 3 steps 2-6** to avoid
   misleading Functions errors. Smoke-tests resume at step 7
   (with the bundle deployed to the new SWA pointing at the
   correctly-restored account).
6. **Storage**: `azcopy sync` from old account to new account
   (initial sync; we'll do a final delta during the cutover
   window). Server-side copy; inter-region egress at standard
   rates, negligible at our dataset size.

   **Enumerate ALL THREE containers** (critic v7 finding:
   `infra/modules/blobStorage.bicep:35,43,51` declares `avatars`,
   `exports`, and `sourcemaps`; the sourcemaps container is used
   by `cd.yml` for AI symbolication uploads. Missing it silently
   breaks reverse-symbolication for pre-cutover crash reports):
   ```
   foreach ($container in 'avatars','exports','sourcemaps') {
     azcopy sync \
       "https://stjotjsondev.blob.core.windows.net/$container" \
       "https://stjotjsonprod.blob.core.windows.net/$container" \
       --delete-destination=false
   }
   ```
7. **Pre-cutover prep for the merge freeze** (lands a day or two
   before Phase 3):
   - Land a tiny PR commenting out `.mergify.yml`'s auto-update
     rule (with a comment "restored after region migration").
     Pauses Mergify's `synchronize` race during the window. Land
     ASAP so this PR itself doesn't fight Mergify.
   - **USER action** (critic v5 finding: branch protection
     toggling is admin-scope; the agent does not and should not
     toggle it): On the cutover day at T-1h, USER enables
     "Lock branch" on `main` via GitHub UI (Settings -> Branches
     -> main -> "Restrict updates" / "Lock branch") for the
     window duration. USER also disables any auto-merge-armed
     PRs via `gh pr merge --disable-auto`.

## Phase 3: cutover (target ~45-75 min, banner says "couple hours")

**Scheduled for a weekend off-peak hour** (per locked decision).
Saturday or Sunday early morning UTC minimizes user impact; the
`main`-merge freeze is shorter when most contributors are also
offline.

Schedule for an off-peak hour on a weekend (per locked decision
in the Decisions table). The `main`-merge freeze is enforced
via USER's branch-protection lock + Mergify-rule pause from
Phase 2 step 7. Pinned PRs with auto-merge enabled should have
auto-merge disabled during the window per AGENTS.md §8 "After
enabling auto-merge" rules.

1. **T-10**: Flip maintenance banner on. Old SWA still serves real
   traffic; users see soft heads-up. Banner serves from the old
   SWA throughout the window until step 8's apex unbind.
2. **T-0: pre-tear-down**. Delete BOTH stale Cosmos accounts to
   free the namespace for the final restore:
   - `cosmos-jotjson-prod-rehearse` (the Phase 2 restore -- now
     stale)
   - `cosmos-jotjson-prod` (the Phase-1-created empty account --
     **this is the namespace blocker for the final restore;
     critic-confirmed Critical bug in v4 was that this delete
     was missing**)

   Use `--no-wait` + explicit polling (critic v5 finding: `az`'s
   sync delete can return ahead of namespace availability):
   ```
   az cosmosdb delete -n cosmos-jotjson-prod \
     -g rg-jotjson-prod --yes --no-wait
   az cosmosdb delete -n cosmos-jotjson-prod-rehearse \
     -g rg-jotjson-prod --yes --no-wait

   # Poll both names until check-name-exists returns false
   # Max wait 45 min. Bail if exceeded -> in-window abort.
   ```
   Verify both names are freed before step 3:
   ```
   az cosmosdb check-name-exists -n cosmos-jotjson-prod
   az cosmosdb check-name-exists -n cosmos-jotjson-prod-rehearse
   ```
   Both must return `false`.

   (Note: critic v3 flagged `az staticwebapp stop` as not a real
   command. Dropped from this plan. Reframing: the maintenance
   banner shipped in PR-B is what users see; the old SWA keeps
   serving the banner bundle until its custom-domain binding is
   removed in step 8. No need to forcibly stop the SWA.)
3. Final `azcopy sync` for blobs (delta from Phase 2's initial
   sync). Same three-container enumeration as Phase 2 step 6
   (`avatars`, `exports`, `sourcemaps`).
4. **Take the final PITR** at a freeze-instant inside the
   maintenance window:
   ```
   az cosmosdb restore --location westus2 \
     --target-database-account-name cosmos-jotjson-prod \
     --account-name cosmos-jotjson-dev \
     --restore-timestamp <freeze-instant> \
     --resource-group rg-jotjson-prod
   ```
   Wait for restore completion (Phase 0 rehearsal pinned the
   estimate; budget the rehearsal-pinned time + 50% safety
   margin). **Cosmos PITR cannot be cancelled once initiated.**
   See "In-window abort" below for behavior if this overruns.
5. **Re-run `swaCosmosRole`** against `cosmos-jotjson-prod` (the
   final account) with the new SWA's principal ID.

   **Note**: step 6 below subsumes this step if implemented as a
   Bicep redeploy (recommended option). When step 6 redeploys
   `main.bicep` with the existing `prod.bicepparam` against the
   restored Cosmos account, the `swaCosmosRole` module re-runs
   automatically with the correct principal ID + restored
   Cosmos name. If operator picks option (b) below (Bicep
   redeploy), step 5 is a no-op; if operator picks option (a)
   (`az staticwebapp appsettings set`), step 5 must run via
   PR-C script's `re-grant-cosmos-role` helper.
6. **Update new SWA app settings** to point at the final
   `cosmos-jotjson-prod`. **Two options** (critic v7 finding:
   v6 gave no concrete command and the PITR-restored account
   has new `listKeys()` values requiring rotation, not just
   re-pointing):
   - **Recommended (option b)**: redeploy Bicep against the
     restored account. The `cosmos.outputs.primaryKey` resolves
     via `listKeys()` on the restored account; SWA appsettings
     for `COSMOS_KEY` + `COSMOS_ENDPOINT` are rotated
     automatically; `swaCosmosRole` re-runs with the correct
     principal ID; `deployMonitoring=false` is preserved.
     ```
     az deployment group create -g rg-jotjson-prod \
       --template-file infra/main.bicep \
       --parameters infra/parameters/prod.bicepparam
     ```
     This is idempotent: the `cosmos` module sees the restored
     account by name and treats it as an idempotent
     reconciliation (NOT a recreation -- the restored data is
     preserved). This option subsumes step 5.
   - **Alternative (option a)**: `az staticwebapp appsettings
     set -n swa-jotjson-prod -g rg-jotjson-prod --setting-names
     COSMOS_ENDPOINT=<restored-endpoint> COSMOS_KEY=<restored-key>`.
     **Risky**: easy to forget `COSMOS_KEY` and only update
     endpoint, which silently breaks data-plane auth. Use only
     if Bicep redeploy is blocked for some reason.
7. **Bundle-deploy + token-rotation FIRST** (eliminates the
   white-screen window and the Mergify lost-deploy race):
   - **Capture expected SHA before any rotation** (critic v7
     finding: "rotation-moment github.sha" was imprecise; the
     SHA is whatever was on `main` HEAD at the moment of
     `workflow_dispatch`, captured pre-rotation):
     ```
     $EXPECTED_SHA = git rev-parse origin/main
     # Capture; do NOT make any commits between this line and the
     # workflow_dispatch trigger below.
     ```
   - Rotate the live secret to the NEW SWA's deploy token:
     ```
     az staticwebapp secrets list -n swa-jotjson-prod \
       -g rg-jotjson-prod --query "properties.apiKey" -o tsv \
       | gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN
     ```
     **No need to back up the OLD SWA's token to a separate
     secret** (critic v7 finding: `gh secret set` is write-only;
     the GH API never exposes secret values, so the saved
     secret would be unreadable). Rollback re-fetches the OLD
     SWA's token directly via `az staticwebapp secrets list
     -n swa-jotjson-dev -g rg-jotjson-dev` -- the OLD SWA
     exists for the 7-day soak, so this path is always
     available until Phase 4 step 8 deletes the dev RG.
   - Trigger a `workflow_dispatch` on `cd.yml` to deploy the
     current prod bundle to the new SWA. Wait for the deploy job
     to succeed.
   - **SHA verification** (critic v7 fix: use existing helper):
     ```
     node scripts/check-deploy-freshness.mjs \
       --origin https://<new-swa-default-hostname> \
       --expected-sha $EXPECTED_SHA
     ```
     If SHA mismatches, the deploy raced the secret rotation;
     re-trigger `workflow_dispatch` and re-check before
     proceeding.
   - Verify the new SWA serves the real bundle (not the Azure
     default placeholder) at its default `*.azurestaticapps.net`
     hostname.
8. **Rebind apex** (only AFTER step 7's bundle is live on the
   new SWA):
   - On old SWA: remove `jotjson.com` from custom domains.
   - On new SWA: add `jotjson.com` via "Custom domain on Azure
     DNS". SWA rewrites the apex alias A record in the (now
     `rg-jotjson-dns`-owned) zone automatically.
   - **Permission prerequisite** (critic v5 finding): the
     operator's signed-in principal must have
     `Microsoft.Network/dnsZones/A/write` on `rg-jotjson-dns`.
     Subscription-level Owner/Contributor satisfies this. If
     the operator's principal is scoped down, USER pre-grants
     `DNS Zone Contributor` on `rg-jotjson-dns` before this
     step.
   - **Cert re-issuance**: 1-15 min. `jotjson.com` returns SSL
     handshake errors or 404 during this window. Unavoidable.
   - **Rollback floor**: ~15 min, not 1 min.
9. **Smoke-test signed-in flows** against `jotjson.com`: sign-in,
   save blob, share blob, list history, fetch shared blob by
   slug, rule-sets create/edit, sign-out + sign-in (validates
   MSAL redirect loop).
10. **Re-enable `main` merges**:
    - USER lifts the branch-protection "Lock branch" via GitHub
      UI.
    - Revert the `.mergify.yml` commenting-out PR (or just
      merge the revert PR that was pre-built).
    - Flip maintenance banner off via `maintenance-banner.json`
      edit + `workflow_dispatch` (the no-store cache route
      from PR-B makes this propagate immediately).
11. Leave eastus2 `rg-jotjson-dev` stack running but **idle** for
    7 days as rollback insurance. See "Post-cutover rollback
    procedure" below for honest data-loss accounting and the
    pre-built back-sync script (PR-D).

### In-window abort (Phase 3, before step 8 completes)

**Cosmos PITR cannot be cancelled.** Once `az cosmosdb restore` is
running, you cannot stop it -- you can only let it finish, then
delete the resulting account if you don't want it. Plan the abort
accordingly.

Trigger an in-window abort if:

- Final PITR exceeds 2x the rehearsal-pinned estimate (e.g.,
  rehearsal pinned 60 min -> abort criterion at 120 min). **Abort
  decision happens BEFORE PITR completes** -- you decide to
  abort, let the restore finish in the background (cleanup
  task), and follow the in-window-abort procedure.
- `swaCosmosRole` apply fails after 3 retries.
- Step 7 bundle deploy SHA verification fails after 3 retries.
- Step 9 smoke-test fails on signed-in writes (likely culprit:
  Cosmos RBAC re-grant against the freshly-restored account).
- Cert re-issuance (after step 8) fails or stalls >30 min.

**In-window abort procedure** (apex still on OLD SWA OR rebind
just happened):

1. **If step 8 has NOT yet run**: apex is still on old SWA.
   - Lift maintenance banner on old SWA.
   - Restore `AZURE_STATIC_WEB_APPS_API_TOKEN` GH secret back to
     the OLD SWA's token by re-fetching from old SWA:
     ```
     az staticwebapp secrets list -n swa-jotjson-dev \
       -g rg-jotjson-dev --query "properties.apiKey" -o tsv \
       | gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN
     ```
   - Trigger a `workflow_dispatch` on `cd.yml` to confirm the
     old SWA still receives deploys.
   - Leave new RG running for cleanup. The orphan
     `cosmos-jotjson-prod` (final PITR may still be running) is
     deleted post-abort as cleanup. **No data loss; no signed-in
     writes ever hit the new stack.**
   - **Note: retry budget.** If operator plans to retry the
     cutover within the same week, the still-running orphan
     PITR is a **serializing prerequisite to retry** (Phase 3
     step 4 can't restore to `cosmos-jotjson-prod` while the
     orphan still exists). Wait for the orphan PITR to complete
     (5-30 min more), then `az cosmosdb delete` it (another
     5-30 min). Budget ~60 min between abort decision and
     retry start.
2. **If step 8 HAS run** (apex moved, cert re-issuance in flight
   or done) **and step 9 failed**:
   - Re-bind apex back to OLD SWA. Eats another 1-15 min cert-
     reissuance window.
   - Restore `AZURE_STATIC_WEB_APPS_API_TOKEN` GH secret back to
     the OLD SWA's token (re-fetch from old SWA via `az
     staticwebapp secrets list`).
   - **Data-loss budget**: whatever signed-in writes hit the new
     stack between step 8 and the abort decision. With smoke-
     test failing fast (step 9), this is typically zero writes
     (operator hasn't unfrozen merges yet, only the operator's
     own smoke-test traffic). The pre-built back-sync (PR-D) is
     overkill for this case.

### Post-cutover rollback procedure (7-day soak window)

**Honest framing**: post-cutover rollback is not lossless. Writes
made on the new stack between cutover (step 10's banner-off) and
rollback decision are NOT on the old stack. Specifically:

- **Cosmos**: every blob saved, rule-set saved, profile updated,
  or history row written hits `cosmos-jotjson-prod` only.
- **Storage**: every avatar uploaded, every export downloaded
  hits `stjotjsonprod` only.
- **GH Actions deploys**: every push to `main` between cutover
  and rollback deploys to `swa-jotjson-prod`. The old SWA's
  bundle is stale by the rollback-window duration.

**Rollback procedure**:

1. **Restore the GH secret to OLD SWA's deploy token** -- re-fetch
   directly from old SWA (the OLD SWA still exists during the
   7-day soak so this is always available):
   ```
   az staticwebapp secrets list -n swa-jotjson-dev \
     -g rg-jotjson-dev --query "properties.apiKey" -o tsv \
     | gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN
   ```
2. **Re-bind apex**: on `swa-jotjson-prod` remove `jotjson.com`
   custom domain; on `swa-jotjson-dev` add it via "Custom domain
   on Azure DNS". Eats another 1-15 min cert-reissuance window.
3. **Run back-sync** via the pre-built `scripts/cosmos-back-sync.mjs`
   (PR-D), passing the cutover-instant Unix timestamp. `--src-rg`,
   `--dst-rg`, and `--accept-delete-loss` are required: the script
   refuses to run without all of them. `--accept-delete-loss` is the
   operator's explicit acknowledgment of the
   "delete-loss budget" item below -- standard Cosmos change feed
   does not replay deletes.
   ```
   node scripts/cosmos-back-sync.mjs \
     --src cosmos-jotjson-prod \
     --src-rg rg-jotjson-prod \
     --dst cosmos-jotjson-dev \
     --dst-rg rg-jotjson-dev \
     --cutover-instant-unix-seconds <ts> \
     --accept-delete-loss
   ```
   This iterates the change feed on the new account filtered to
   `_ts >= <cutover-instant>`, and per-doc:
   - If the doc doesn't exist on the OLD account -> unconditional
     CREATE.
   - If the doc DOES exist on the OLD account and `oldDoc._ts <
     newDoc._ts` -> `If-Match` write with OLD's `_etag`.
   - If `oldDoc._ts >= newDoc._ts` -> leave the old doc alone,
     log to conflicts file (the old account was the live one
     during rollback window and has fresher data).

   **The `_ts` filter is critical** -- without it, the change
   feed replays the entire document history (PITR-restored
   accounts' change feed is not bounded to the restore point)
   and the script doubles every doc.

   **The per-doc strategy is critical too** (critic v5 Critical
   finding) -- a naive `If-Match` on the NEW account's
   `_etag` against the OLD account would 412 on every doc and
   the back-sync would write ZERO documents.
4. **AzCopy back-sync for blobs** (manual; storage doesn't have a
   clean equivalent of the change-feed pattern). **Enumerate all
   three containers** (critic v7 finding: same `sourcemaps`
   container omission as the forward-sync):
   ```
   foreach ($container in 'avatars','exports','sourcemaps') {
     azcopy sync \
       "https://stjotjsonprod.blob.core.windows.net/$container" \
       "https://stjotjsondev.blob.core.windows.net/$container" \
       --delete-destination=false
   }
   ```
   `--delete-destination=false` is critical -- we don't want
   the back-sync to delete blobs that exist on `dev` but not on
   `prod` (those would be pre-cutover-only blobs that the
   back-sync shouldn't touch).

**Rollback data-loss budget**: even with the back-sync, accept
loss of:
- Any document where `oldDoc._ts >= newDoc._ts` (the OLD account
  was the live one during rollback window; logged to conflicts
  file for manual review).
- Any storage blob that was overwritten on the new stack after
  cutover but the old stack already had a same-name blob
  (`--delete-destination=false` means the old blob wins; manual
  inspection required).
- Any 412 conflicts during back-sync (concurrent writes); logged
  for manual reconciliation.
- **Any Cosmos document deleted on the NEW account between
  cutover and back-sync will resurrect on the OLD account**
  after rollback. The standard Cosmos change feed (latest-
  version mode) does not emit deletes, so `cosmos-back-sync.mjs`
  cannot replay them. The `AllVersionsAndDeletes` mode would
  capture deletes but requires `changeFeedPolicy.retentionDuration`
  to be enabled on the container BEFORE the deletes happen
  (forward-looking only) and is not enabled on the current
  migration's containers. Affected containers: `blobs`,
  `history`, `rule-sets`. The `users` container has no delete
  path in production code and is unaffected. Resurrected
  deletes produce zero rows in the back-sync conflicts file --
  the script's audit trail is incomplete by design for this
  failure mode. After the back-sync run, perform a per-container
  diff: list document IDs that exist on OLD but not on NEW
  (after the back-sync writes complete), filter to IDs the user
  could have deleted post-cutover, and either re-delete them or
  surface them for manual review.

If the rollback window extends past 24-48 hours after cutover,
the back-sync cost (manual reconciliation, user-visible
inconsistency) likely exceeds the value of rollback -- at that
point, fix-forward on `swa-jotjson-prod` instead.

## Phase 4: cleanup + AI/LAW move (T+7 days)

1. **Pre-move: disable old alerts and action group** in
   `rg-jotjson-dev`. Disable the action group itself (silences
   all alerts feeding it atomically; critic v5 finding: the
   per-alert disable loop isn't atomic). Then also disable each
   alert for hygiene:
   ```
   az monitor action-group update \
     -g rg-jotjson-dev -n ag-jotjson-dev-monitoring \
     --set properties.enabled=false

   foreach ($alert in @(
     'alert-jotjson-dev-boot-failed',
     'alert-jotjson-dev-app-unhandled',
     'alert-jotjson-dev-fn-5xx',
     'alert-jotjson-dev-auth-config',
     'alert-jotjson-dev-sw-migration-stuck-cohort')) {
     az monitor scheduled-query update \
       -g rg-jotjson-dev -n $alert --enabled false
   }

   # Concrete verification (critic v7: eyeball check is error-
   # prone at 1AM):
   $still_enabled = az monitor scheduled-query list \
     -g rg-jotjson-dev --query "length([?enabled])" -o tsv
   if ($still_enabled -ne '0') {
     Write-Error "ERROR: $still_enabled alerts still enabled"
     exit 1
   }
   $ag_enabled = az monitor action-group show \
     -g rg-jotjson-dev -n ag-jotjson-dev-monitoring \
     --query "properties.enabled" -o tsv
   if ($ag_enabled -ne 'false') {
     Write-Error "ERROR: action group still enabled"
     exit 1
   }
   ```
2. **Move AI + Log Analytics workspace to `rg-jotjson-telemetry`**:
   ```
   az group create -n rg-jotjson-telemetry -l eastus2
   az resource move --destination-group rg-jotjson-telemetry \
     --ids <appi-resource-id> <law-resource-id>
   ```
   - Both `Microsoft.Insights/components` and
     `Microsoft.OperationalInsights/workspaces` support cross-RG
     move per Microsoft's "Move resources to a new resource
     group" documentation.
   - Telemetry ingestion is unaffected (connection string carries
     region, not RG path). Apex resolution is unaffected.
   - **Old alerts in `rg-jotjson-dev` now have stale `scopes`
     ARM paths** -- but they're disabled per step 1 so this is
     by design.
3. **Redeploy `rg-jotjson-prod` Bicep with `deployMonitoring=true`**
   and `existingAppInsightsRg` updated to `rg-jotjson-telemetry`
   (the new RG after step 2's move). `existingAppInsightsName`
   stays `'appi-jotjson-dev'`:
   ```
   # Edit prod.bicepparam:
   #   existingAppInsightsRg = 'rg-jotjson-telemetry'
   #   deployMonitoring = true
   az deployment group create -g rg-jotjson-prod \
     --template-file infra/main.bicep \
     --parameters infra/parameters/prod.bicepparam
   ```
   The PR-A `existing` resource lookup resolves the AI's
   connection string at deploy time from the moved resource;
   no connection-string param. This creates the AG, 3
   workbooks (operator, product-analytics, sw-migration), and
   alerts in `rg-jotjson-prod` referencing the moved AI/LAW.
4. **Fire a test alert** to confirm new alerting is live. The
   new AG's email receiver requires the same confirmation flow
   as nonprod-west did in Phase 0 step 11.
5. **Verify Workflows/cd.yml deploys** are landing on the new
   SWA (a real deploy from a `main` push, not just
   `workflow_dispatch`).
6. **Workflow + param-file rename PR** (single atomic PR;
   critic v5 finding: prevents CI/CD breaking at an unspecified
   moment). Re-grep before opening the PR to catch any new
   references added since v6 drafted; the enumeration below is
   the verified set as of plan v7:
   - Rename `infra/parameters/dev.bicepparam` to
     `infra/parameters/prod.bicepparam` (or, if `prod.bicepparam`
     already exists from Phase 1 step 1, delete
     `dev.bicepparam` and merge any content gap).
   - Update `.github/workflows/infra.yml` (**SIX** `rg-jotjson-dev`
     references at lines 176, 187, 226, 237, **253**, **261**;
     critic v7 finding: lines 253 and 261 are `echo` lines
     inside the Summary heredoc that v6 missed):
     - Line 136: "Validate dev.bicepparam" step label ->
       "Validate prod.bicepparam"
     - Line 141: `--file infra/parameters/dev.bicepparam` ->
       `--file infra/parameters/prod.bicepparam`
     - Lines 176, 187, 226, 237: `rg-jotjson-dev` ->
       `rg-jotjson-prod`
     - Lines 253, 261: `echo "- Resource group: rg-jotjson-dev"`
       -> `echo "- Resource group: rg-jotjson-prod"`
     - Line 189: `--parameters infra/parameters/dev.bicepparam`
       -> `--parameters infra/parameters/prod.bicepparam`
     - Line 239: `--parameters infra/parameters/dev.bicepparam`
       -> `--parameters infra/parameters/prod.bicepparam`
     - Lines 177, 227 `--location ${{ vars.AZURE_LOCATION ||
       'eastus2' }}` -> `--location ${{
       vars.AZURE_LOCATION_PROD || 'westus2' }}`
   - Update `.github/workflows/infra-nonprod.yml` (**TWO**
     `--location` instances; critic v7 finding: v6 missed line
     108):
     - Line 65: `--location ${{ vars.AZURE_LOCATION ||
       'eastus2' }}` -> `--location ${{
       vars.AZURE_LOCATION_NONPROD || 'eastus2' }}`
     - Line 108: same substitution.
   - **No `cd.yml` changes** (critic v7 finding: v6 instructed
     `rg-jotjson-dev` / `swa-jotjson-dev` substitution in
     `cd.yml`; that file has zero such references because it
     deploys via `secrets.AZURE_STATIC_WEB_APPS_API_TOKEN`, no
     RG/SWA names. v7 drops the instruction.)
   - USER removes the single `AZURE_LOCATION` repo variable
     after this PR merges (replaced by `AZURE_LOCATION_PROD` /
     `AZURE_LOCATION_NONPROD`).

   **Scope-discipline note** (critic v7 suspicious-pattern
   finding): this PR bundles two distinct changes -- (a) the
   param-file rename + workflow refs, (b) the `AZURE_LOCATION`
   split + USER variable rename. Splitting them across two
   coordinated PRs is also viable: land (a) first (rename),
   then (b) (variable split) the same day before any
   `infra.yml` run. Bundling is the recommended path because
   they share a CI cycle and any intermediate-merge state
   between them would break `infra.yml`. The bundling is a
   deliberate trade-off, not an architectural necessity.
7. **Documentation updates** (critic v7 finding: v6 cited
   wrong line numbers; the verified stale-reference set in plan
   v7 is below. Operator should re-grep before opening the
   PR -- new lines may have been added since plan v7 drafted):
   - `infra/README.md`: stale `rg-jotjson-dev` and
     `dev.bicepparam` references at lines 27, 38, 47, 49, **51**,
     156, **158**, 177 (re-grep `dev.bicepparam`,
     `rg-jotjson-dev`, `swa-jotjson-dev`). Update to `prod`
     names; add the historical-naming-wart note (AI/LAW kept
     `appi-jotjson-dev` / `appi-jotjson-dev-law` names) and
     the tag wart (AI/LAW carry `env: dev` from original
     deployment; new prod stack tags `env: prod`).
   - `docs/telemetry.md`: stale `dev.bicepparam` references at
     **1123, 1291, 1297, 1301**; stale `rg-jotjson-dev` /
     `appi-jotjson-dev` portal-URL bullets at lines 720, 727,
     747, 748, 750, 796, 828, 1081, 1082, 1084, 1091, 1092,
     1095. Update workbook portal URLs to the new workbook
     resource IDs in `rg-jotjson-prod` (workbook resource IDs
     change post-Phase-4-step-3 redeploy).
   - **No `DESIGN_SPEC.md` "Data residency" update needed** --
     already corrected in Phase 0 step 1.
8. **Delete `rg-jotjson-dev`** (the old eastus2 RG). It now
   contains only the old SWA + idle Cosmos + idle Storage +
   disabled Action Group + disabled Workbooks/Alerts. The DNS
   zone moved to `rg-jotjson-dns` in Phase 0 step 6; AI/LAW
   moved to `rg-jotjson-telemetry` in Phase 4 step 2. Safe to
   delete.
9. **File follow-up issues**:
   - Investigate `rg-jotjson-auth` in `eastus`; decide whether
     it should follow the migration.
   - `stagingEnvironmentPolicy: 'Enabled'` on prod SWA --
     consider `'Disabled'` since preview slots run on nonprod.
   - PR-E: update `env-label.ts` to map the new SWA stem to
     `[prod]` for pre-cutover-style smoke-tests.

(Critic v7 finding: v6 had a Phase 4 step 10 cleaning up a
temporary `AZURE_STATIC_WEB_APPS_API_TOKEN_OLD_SWA` GH secret.
v7 dropped the temp-secret entirely from Phase 3 step 7
because `gh secret set` is write-only and the secret would
have been unreadable. With nothing to clean up, step 10 is
removed.)

## Risk + mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Cosmos RBAC re-grant uses wrong principal ID | Med | Critical | Phase 0 rehearsal validates principal-ID logic; PR-C script reads `identity.principalId` of the new SWA explicitly |
| AI/LAW pre-move strands existing alerts | Mitigated | High | Move DEFERRED to Phase 4; alerts AG-level disabled before move; new alerts redeployed against moved IDs immediately after |
| DNS zone deletion when old RG deleted | Mitigated | Critical | Phase 0 step 6 moves zone to `rg-jotjson-dns` AFTER PR-A's `existingDnsZoneRg` switch lands |
| Cosmos name collision on final PITR | Mitigated | Critical | Phase 3 step 2 explicitly deletes BOTH `cosmos-jotjson-prod` (Phase-1-created) AND `cosmos-jotjson-prod-rehearse` with `--no-wait` + `check-name-exists` polling before final restore |
| Storage / Cosmos / SWA name globally unavailable | Mitigated | High | Phase 0 step 2 pre-flight `check-name` calls; fallback names locked in `prod.bicepparam` if any squatted |
| GZRS not deployable in westus2 | Mitigated | Med | Phase 0 step 3 SKU availability check + step 4 end-to-end test deployment (with 16-char random suffix per v7 entropy fix) |
| External-AI Bicep wiring breaks Functions telemetry | Mitigated | Critical | PR-A item 3 uses `existing` resource lookup for AI (single source of name+RG; connection string never stored in param file); PR-C script enforces both-or-neither contract |
| AI `InstrumentationKey` committed to source | Mitigated | High | PR-A item 3 uses `existing` resource lookup, not committed connection string. AGENTS.md §6 compliance verified by critic v7 |
| `main.bicep:213` `dnsNameServers` output breaks under conditional DNS module | Mitigated | High | PR-A item 5 explicitly rewrites the output: `(empty(dnsZoneName) \|\| !empty(existingDnsZoneRg)) ? [] : dns.outputs.nameServers` |
| `prod.bicepparam` lands with syntax errors that CI didn't catch | Mitigated | High | Phase 1 step 3 mandates local `az bicep build-params` + `what-if` validation before deploy (workflow's CI doesn't reference `prod.bicepparam` until Phase 4 step 6) |
| Phase 3 step 6 ambiguous mechanism leads to inconsistent SWA appsettings | Mitigated | High | Phase 3 step 6 specifies Bicep redeploy as recommended path (rotates `COSMOS_KEY` + endpoint atomically); subsumes step 5 |
| SWA deploy token stale post-cutover | Mitigated | High | Phase 3 step 7 rotates token + deploys bundle BEFORE step 8 apex rebind. **No backup-to-GH-secret needed** -- OLD SWA still exists for 7-day soak; rollback re-fetches token directly via `az staticwebapp secrets list` |
| `main` merges during window deploy to wrong SWA | Mitigated | Med | Phase 2 step 7 lands `.mergify.yml` pause PR + USER enables branch-protection lock during cutover window |
| New SWA serves Azure default placeholder after apex rebind | Mitigated | High | Phase 3 step 7 deploys bundle to new SWA via `workflow_dispatch` + `check-deploy-freshness.mjs` SHA verification BEFORE step 8 apex rebind |
| `dev.bicepparam` workflow references break post-rename | Mitigated | High | Phase 4 step 6 enumerates ALL 6 `rg-jotjson-dev` references in `infra.yml` (lines 176, 187, 226, 237, 253, 261) + BOTH `--location` lines in `infra-nonprod.yml` (lines 65, 108) per v7 verification |
| Phase 1 deploy mechanism unclear (workflow targets old RG) | Mitigated | High | Phase 1 step 3 explicitly specifies manual `az deployment group create` from operator shell + local `bicep build-params` + `what-if` validation |
| `infra.yml` deploy between Phase 0 step 6 and PR-A merge tries to create DNS zone in `rg-jotjson-dev` | Mitigated | High | Phase 0 step 6 explicitly sequences: PR-A merge -> `existingDnsZoneRg='rg-jotjson-dns'` PR merge -> `az resource move` |
| AzCopy misses `sourcemaps` container, breaking AI symbolication | Mitigated | Med | Phase 2 step 6, Phase 3 step 3, and rollback step 4 explicitly enumerate `avatars`, `exports`, `sourcemaps` per `infra/modules/blobStorage.bicep:35,43,51` |
| PR-D conflicts file unfindable mid-rollback | Mitigated | Low | PR-D specifies `cosmos-back-sync-conflicts-<ISO8601>.jsonl` JSONL format in CWD with `{container, id, partitionKey, reason, oldTs, newTs, ...}` fields |
| SWA cert re-issuance fails after apex rebind | Low | High | Banner copy honest about ~15-min floor; rehearsal on test DNS first |
| Final PITR exceeds rehearsal estimate | Med | Med | Banner says "couple hours"; in-window abort criterion at 2x rehearsal time; PITR can't be cancelled but new account is just deleted post-abort |
| AzCopy delta is large | Low | Low | Dataset is small; pre-sync repeatedly |
| Cross-region telemetry from west Functions to east AI: ingestion failure on regional partition | Very Low | Med | Accepted operational asymmetry; AI live-metrics stream may stall on west->east network partition. Not "negligible"; acknowledged. |
| Email-receiver confirmation drops alerts | Mitigated | Med | Phase 0 rehearsal fires test alert against recreated AG (nonprod-west); Phase 4 step 4 re-fires against prod AG |
| Rollback within 7-day soak loses signed-in writes (partial) | Partial mitigation | High | Pre-built `cosmos-back-sync.mjs` (PR-D) with `_ts` filter + per-doc strategy (NOT naive `If-Match` -- critic v5 Critical correction); AzCopy back-sync with `--delete-destination=false` and three-container enumeration; documented data-loss budget for unrecoverable cases |
| `maintenance-banner.json` cache propagation delay (~60min) | Mitigated | Med | PR-B adds `Cache-Control: no-store` route in `staticwebapp.config.json` immediately after `/build-info.json` rule |
| Phase 3 steps 2-6 leave new SWA appsettings pointing at deleted account | Mitigated | Low | Phase 2 step 5 documents "freeze smoke-test traffic during Phase 3 steps 2-6" |
| Phase 4 step 1 sequential alert disable not atomic | Mitigated | Med | AG-level disable first (atomic for all 5 alerts); then per-alert disable; then concrete verification predicate (`length([?enabled])` must be 0) |
| `Microsoft.Network/dnsZones/A/write` permission on `rg-jotjson-dns` not granted | Mitigated | Med | Phase 3 step 8 documents pre-grant requirement; USER pre-grants `DNS Zone Contributor` if scoped down |
| In-window abort serializes retry on orphan PITR cleanup | Documented | Low | In-window abort step 1 acknowledges 60-min retry budget for orphan PITR cleanup |
| env-label.ts `[unknown]` during pre-cutover smoke-test | Documented | Low | Phase 1 step 7 documents the expected behavior; PR-E is a deferred follow-up |
| AI/LAW tags carry `env: dev` after move | Documented | Low | Phase 4 step 7 documents the tag wart in `infra/README.md` |
| Cosmos PITR cancellation not supported | Documented | Med | In-window abort procedure explicitly accounts for "PITR cannot be cancelled" |
| `DESIGN_SPEC.md` "Data residency" contradicts plan premise | Resolved | Low | Phase 0 step 1 folded into the post-merge doc cleanup PR (this PR) along with #392, #394; closes the side-discovery tracking bullet at the same time |

## Pre-presentation gate

This v7 gate documents the v7 critic pass; the v6 gate is
preserved below for the audit trail of prior iterations.

### v7 critic pass (this iteration)

- **Critic agent**: `deep-review:skeptic` -- "find weaknesses in
  the v5 -> v6 delta; if you genuinely cannot, say so. Don't
  default to minimal change. The plan is 5 critic passes in;
  find what justifies another iteration or confirm v6 is
  presentable."
- **Critic conclusion**: "Sound-but-needs-tiny-fix." 4 Highs
  (mechanically-detectable Bicep + workflow + GH-API bugs that
  would burn a turn each in execution), 7 Mediums, 4 Lows,
  3 edge cases, 3 suspicious patterns, 8 "could not break"
  affirmations. Full transcript at
  `C:\Users\geevens\AppData\Local\Temp\1779413937522-copilot-tool-output-but0m7.txt`.
- **Findings adopted in v7** (all 4 Highs + relevant Mediums +
  relevant Lows + edge cases + 1 suspicious-pattern):

  - **High: PR-A item 5 incomplete -- missed `main.bicep:213`
    output reference** -> PR-A item 5 now explicitly rewrites
    the output: `(empty(dnsZoneName) || !empty(existingDnsZoneRg))
    ? [] : dns.outputs.nameServers`. Without this Bicep
    `build`/`what-if` would fail with "dependency on a
    conditional resource that may not be deployed."

  - **High: `existingAppInsightsConnectionString` commits a
    writable telemetry credential to source** -> PR-A item 3
    rewritten to use a single `existing` resource lookup
    (`existingAppInsightsName` + `existingAppInsightsRg`). The
    connection string is resolved at deploy time from the live
    resource; never lands in `prod.bicepparam` or `git log`.
    AGENTS.md §6 compliance.

  - **High: Temp `AZURE_STATIC_WEB_APPS_API_TOKEN_OLD_SWA` GH
    secret is unreadable, so it doesn't help any rollback path**
    -> Phase 3 step 7 drops the temp-secret save entirely;
    in-window abort step 1 and rollback step 1 re-fetch
    directly from old SWA via `az staticwebapp secrets list`
    (OLD SWA exists for the 7-day soak). Phase 4 step 10
    eliminated.

  - **High: Phase 1 step 3 "workflow's CI gates still run" is
    false** -> Phase 1 step 3 corrected: `infra.yml`'s CI does
    NOT run on `prod.bicepparam`; operator must validate
    locally with `az bicep build-params` and `az deployment
    group what-if` before deploying.

  - **Medium: Phase 4 step 6 enumeration incomplete** -> v7
    enumerates ALL 6 `rg-jotjson-dev` references in `infra.yml`
    (lines 176, 187, 226, 237, **253**, **261** -- the latter
    two in the Summary heredoc), BOTH `--location` lines in
    `infra-nonprod.yml` (65, 108), and drops the spurious
    `cd.yml` instruction (zero such refs).

  - **Medium: Phase 4 step 7 line numbers wrong** -> v7 lists
    actual verified stale-reference set:
    `docs/telemetry.md:1123,1291,1297,1301` for `dev.bicepparam`
    plus the `rg-jotjson-dev`/`appi-jotjson-dev` portal-URL
    bullets; `infra/README.md:51,158` for `dev.bicepparam`.

  - **Medium: Phase 3 step 6 no concrete command** -> v7 gives
    two options (recommended: Bicep redeploy which subsumes
    step 5; alternative: `az staticwebapp appsettings set` with
    risk noted).

  - **Medium: "Both or neither" Bicep validation unenforceable**
    -> PR-A item 3 pushes contract enforcement to PR-C's
    `migrate-region.mjs` pre-flight checker.

  - **Medium: PR-C reinvents `check-deploy-freshness.mjs`** ->
    PR-C now calls existing script:
    `node scripts/check-deploy-freshness.mjs --origin ...
    --expected-sha ...`.

  - **Medium: Phase 4 step 1 verification eyeball-prone** -> v7
    uses concrete predicate:
    `[?enabled]` length must be 0; bash conditional bails on
    nonzero.

  - **Low: PR-D conflicts file format unspecified** -> v7 gives
    full spec: `cosmos-back-sync-conflicts-<ISO8601>.jsonl`
    JSONL in CWD with `{container, id, partitionKey, reason,
    oldTs, newTs, oldEtag, newEtag, attemptedAt}` fields;
    `--dry-run` adds `-dryrun-` suffix.

  - **Low: Phase 3 step 7 SHA capture imprecise** -> v7
    explicit: `EXPECTED_SHA = git rev-parse origin/main` before
    rotation; pass to `check-deploy-freshness.mjs --expected-sha`.

  - **Low: PR-B cache route position unspecified** -> PR-B
    inserts immediately after `/build-info.json` route to keep
    no-store-JSON rules contiguous.

  - **Low: Phase 0 step 4 GZRS test name has weak entropy
    (4 digits)** -> v7 uses `New-Guid`-derived 16-char random
    suffix.

  - **Low: AzCopy doesn't enumerate `sourcemaps` container** ->
    Phase 2 step 6, Phase 3 step 3, and rollback step 4
    explicitly enumerate `avatars`, `exports`, `sourcemaps`
    per `infra/modules/blobStorage.bicep:35,43,51`. Missing
    `sourcemaps` would have broken AI symbolication for
    pre-cutover crash reports.

  - **Edge: Phase 1 step 2 `customDomain` implicit** -> Phase 1
    step 2 explicitly sets `customDomain = ''` (apex bound via
    portal in Phase 3 step 8, not via Bicep).

  - **Edge: `dnsZoneName` value in `prod.bicepparam`** -> Phase
    1 step 2 explicitly sets `dnsZoneName = 'jotjson.com'`; the
    corrected `main.bicep:213` output (PR-A item 5) handles
    the conditional cleanly.

  - **Suspicious: PR-D `_ts` filter rationale incorrect** -> PR-D
    description corrected: filter is a **perf optimization**
    (without it the back-sync iterates the entire restored
    snapshot but no-ops per-doc on snapshot rows where
    `oldDoc._ts >= newDoc._ts`); slow not wrong. Mental-model
    fix.

- **Findings set aside** (with reason):

  - **Concurrent-write 412 budgeting during rollback back-sync**:
    Acknowledged in PR-D ("logged to conflicts file, not
    retried automatically; operator reviews and manually
    reconciles"). JotJSON's traffic level is low enough that
    a precise rate-budget would be theatre. Bounded by the
    rollback data-loss-budget framing already in the rollback
    procedure.
  - **Phase 4 step 6 "atomic" framing**: v7 acknowledges this
    as a deliberate trade-off (the two changes share a CI
    cycle, intermediate-merge state would break `infra.yml`).
    Bundling is recommended but not architecturally
    mandatory; the trade-off is documented inline.
  - **PR-A item 7 Bicep idempotency note**: The single
    canonical Cosmos path is sound; v6/v7 plan adds the
    Phase 3 step 6 Bicep-redeploy option which inherently
    relies on Bicep's idempotency against a PITR-restored
    account by the same name. The note is implicit but
    operator-readable from the recommended Phase 3 step 6
    "idempotent reconciliation, not recreation" wording.
  - **Pre-presentation-gate §11 contradiction**: Cosmetic
    documentation issue; v7 gate (this one) replaces the v6
    "recommended but not required" wording with the actual
    v7 critic pass performed.
  - **Risk table split**: Cosmetic; the table now has 33 rows
    but is operationally usable as a single audit-trail-plus-
    operator-checklist hybrid. Splitting can be a follow-up
    cosmetic edit.
  - **`check-deploy-freshness.mjs --origin` flag verification**:
    Operator validates the flag exists when they reach Phase 3
    step 7. If the flag doesn't exist, PR-C extends the script;
    the script ownership is in-repo.

- **Findings out of scope**: none.

### v6 gate (preserved for audit trail)
- **Critic conclusion**: 11 findings raised (2 Critical, 5 High,
  3 Medium, 1 Low + 1 Low-Med), 4 edge cases, 4 suspicious
  patterns, 6 areas verified as robust, 1 minor over-correction
  flagged. Full transcript preserved in critic output file
  (`C:\Users\geevens\AppData\Local\Temp\1779412791549-copilot-tool-output-v4qzdq.txt`).
- **Findings adopted in v6** (11 of 11 + 4 of 4 edge cases + 4 of
  4 suspicious patterns + 1 of 1 over-correction):

  - **Critical: PR-D back-sync `If-Match` strategy structurally
    broken** -> PR-D rewritten with per-doc strategy: GET on OLD
    account first; CREATE if 404; `If-Match` with OLD's `_etag`
    if exists and newer; skip + log if OLD is fresher.

  - **Critical: PR-A `existingAppInsightsId` doesn't supply
    connection string** -> PR-A item 3 now requires BOTH
    `existingAppInsightsId` AND
    `existingAppInsightsConnectionString` params (or single
    `existing` resource lookup); Bicep validation enforces both
    or neither.

  - **High: LAW name factually wrong in resource-name table**
    -> corrected to `appi-jotjson-dev-law` (verified at
    `infra/modules/appInsights.bicep:6`); also flagged in Phase
    4 step 7 docs update.

  - **High: `dev.bicepparam` rename + workflow file references
    not coordinated** -> Phase 4 step 6 enumerates all 4
    references in `infra.yml` (lines 136, 141, 189, 239) + the
    "Validate" step label; specifies they flip in the same PR
    as the file rename. `prod.bicepparam` coexists with
    `dev.bicepparam` from Phase 1 step 1 until Phase 4 step 6.

  - **High: Phase 1 deploy mechanism unspecified** -> Phase 1
    step 3 explicitly specifies manual `az deployment group
    create` from operator shell, with full parameter list.
    `infra.yml` catches up in Phase 4 step 6.

  - **High: Phase 0 DNS zone move races with `infra.yml`** ->
    PR-A item 5 adds `existingDnsZoneRg` switch; Phase 0 step 6
    explicitly sequences (a) PR-A merge -> (b) tiny PR setting
    `existingDnsZoneRg='rg-jotjson-dns'` in `dev.bicepparam`
    -> (c) `az resource move`.

  - **Medium: `useCommonAlertSchema` alternative is wrong** ->
    Phase 4 step 1 replaced with AG-level
    `az monitor action-group update --set
    properties.enabled=false` (which atomically silences all
    receivers).

  - **Medium: `maintenance-banner.json` cache route missing**
    -> PR-B adds `Cache-Control: no-store` route in
    `staticwebapp.config.json` for `/assets/maintenance-banner.json`.

  - **Medium: `az cosmosdb delete` sync timeout** -> Phase 3
    step 2 uses `--no-wait` + explicit `check-name-exists`
    polling with max 45-min wait.

  - **Medium: Phase 4 step 1 alert disable not atomic** -> AG-
    level disable first (atomic for all 5 alerts feeding that
    AG); per-alert disable as hygiene; explicit verification
    step assertion all 5 are `enabled=false` before proceeding
    to step 2.

  - **Medium: "Lock branch" presented as agent work** -> Phase
    2 step 7 and Phase 3 step 10 explicitly mark "USER action"
    (branch-protection toggling is admin-scope; the agent does
    not toggle it).

  - **Low-Med: Phase 3 step 2 wait time clarity** -> reworded
    with explicit `--no-wait` + polling pattern.

  - **Low: pre-presentation gate count discrepancy** ->
    re-counted in this v6 gate (11 findings = 2 Critical + 5
    High + 3 Medium + 1 Low + 1 Low-Med).

  - **Low: OLD SWA token saved in plaintext** -> stored as
    temporary GH Actions secret `AZURE_STATIC_WEB_APPS_API_TOKEN_OLD_SWA`
    instead; cleanup in Phase 4 step 10.

  - **Edge: Phase 2 step 5 deleted-account smoke-test window**
    -> explicit "freeze smoke-test traffic during Phase 3
    steps 2-6" guidance added.

  - **Edge: in-window abort retry blocked by orphan PITR** ->
    in-window abort step 1 documents 60-min retry budget for
    orphan PITR cleanup.

  - **Edge: SHA-verification for token-rotation deploy** ->
    Phase 3 step 7 adds explicit `build-info.json` SHA
    assertion against rotation-moment `github.sha`.

  - **Edge: GZRS deployability check** -> Phase 0 step 4 adds
    end-to-end test deployment (provision + delete a one-off
    GZRS account in westus2).

  - **Suspicious: 5-alert disable list misleading naming** ->
    Phase 4 step 1 enumerates all 5 by full name including
    the less-obvious `alert-jotjson-dev-sw-migration-stuck-cohort`.

  - **Suspicious: PR-A item 4 module enumeration incomplete**
    -> PR-A item 4 now enumerates all FIVE modules:
    `monitoringActions`, `operatorWorkbook`,
    `productAnalyticsWorkbook`, `swMigrationWorkbook`,
    `monitoringAlerts`.

  - **Suspicious: `DESIGN_SPEC.md:1966` stale claim** -> Phase
    0 step 1 lands a separate one-line truth fix PR before
    plan execution.

  - **Suspicious: Phase 3 step 8b DNS write permission** ->
    Phase 3 step 8 documents `Microsoft.Network/dnsZones/A/write`
    permission requirement on `rg-jotjson-dns`; USER pre-grants
    `DNS Zone Contributor` if scoped down.

  - **Over-correction: `deployMonitoring` permanent param** ->
    accepted as architecturally clean (single switch, not a
    hack); PR-A adds an inline comment explaining the
    migration motivation and noting future reusability.

- **Findings set aside**: none.
- **Findings out of scope**: none.
- **Re-rubber-duck on v6**: v6 absorbed 2 new Criticals and 5
  new Highs from the v5 critic. The structural defects in v5
  (back-sync strategy, AI connection string, workflow
  coordination) are fixed in v6. Remaining v6 changes are
  smaller (sequencing, verification, atomic operations,
  documentation). Per AGENTS.md §11, v6 may be presented to the
  user after this gate. A v7 critic pass is recommended but
  not required; the user has been patient through 6 plan
  iterations and the core architecture has been hardened
  across 5 critic passes.

