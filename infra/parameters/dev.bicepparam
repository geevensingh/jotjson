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

// Azure DNS zone for jotjson.com lives in rg-jotjson-dns (relocated in
// Phase 0 of the westus2 migration -- see docs/migration-westus2.md
// Phase 0 step 6). Removing this line or changing its value without
// first moving the zone back will cause the next infra.yml deploy to
// create a phantom authoritative zone for jotjson.com here, silently
// split-braining DNS.
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
