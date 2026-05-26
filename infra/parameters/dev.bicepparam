using '../main.bicep'

param environmentName = 'dev'
param appName = 'jotjson'
param staticWebAppSku = 'Standard'
// Bicep's customDomain resource only supports CNAME-validated subdomains
// out of the box. Apex binding is done via the portal's "Custom domain on
// Azure DNS" flow after nameserver delegation completes, so leave this
// empty and manage the SWA binding manually.
param customDomain = ''
param dnsZoneName = 'jotjson.com'

// DNS zone jotjson.com is not managed by this template; the `dns`
// module is suppressed while `existingDnsZoneRg` is non-empty. The
// zone's current resource group and the operator-run relocation
// sequence are documented in docs/migration-westus2.md Phase 0
// step 6. Removing this line or clearing its value would re-enable
// the `dns` module and have the next deploy attempt to manage
// `jotjson.com` in rg-jotjson-dev, conflicting with the live zone
// managed outside this template -- the textbook split-brain DNS
// failure mode.
param existingDnsZoneRg = 'rg-jotjson-dns'

// Entra External ID - populate via `-p` overrides or env-specific param file.
// Keep these empty in the committed dev params; JWT validation is disabled
// until values are provided.
param entraTenantId = ''
param entraAuthority = ''
param entraSpaClientId = ''
param entraApiClientId = ''
param entraApiAudience = ''

// Operational alerts receiver. See issue #94 and the 5/1 incident
// retrospective in plan.md for context on why this is set in source.
param notificationEmail = 'jotjsonadmin@gmail.com'

// Cosmos backup policy: 'Continuous' is required for the
// continuous-backup-conversion wait at docs/migration-westus2.md
// Phase 0 step 10 (against cosmos-jotjson-dev), and for Phase 2
// step 1's tier=Continuous7Days query and step 2's
// `az cosmosdb restore`. PR-A iter-1 (#376) made the Periodic
// branch of `cosmosDb.bicep` a true no-op via `union()`, so
// this param is the only way to enable Continuous explicitly.
// One-way per Azure -- see `infra/modules/cosmosDb.bicep:6`.
// Tracking: #399.
param cosmosBackupPolicyType = 'Continuous'
