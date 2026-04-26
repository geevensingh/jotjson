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

// Entra External ID - populate via `-p` overrides or env-specific param file.
// Keep these empty in the committed dev params; JWT validation is disabled
// until values are provided.
param entraTenantId = ''
param entraAuthority = ''
param entraSpaClientId = ''
param entraApiClientId = ''
param entraApiAudience = ''
