using '../main.bicep'

param environmentName = 'prod'
param appName = 'jotjson'
param staticWebAppSku = 'Standard'
param customDomain = 'jotjson.com'
param dnsZoneName = 'jotjson.com'

// Entra External ID — production values are injected at deploy time from
// GitHub Actions secrets. Keep placeholders here; real values do not live
// in source control.
param entraTenantId = ''
param entraAuthority = ''
param entraSpaClientId = ''
param entraApiClientId = ''
param entraApiAudience = ''
