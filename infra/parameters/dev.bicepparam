using '../main.bicep'

param environmentName = 'dev'
param appName = 'jotjson'
param staticWebAppSku = 'Free'
param customDomain = ''

// Entra External ID — populate via `-p` overrides or env-specific param file.
// Keep these empty in the committed dev params; JWT validation is disabled
// until values are provided.
param entraTenantId = ''
param entraAuthority = ''
param entraSpaClientId = ''
param entraApiClientId = ''
param entraApiAudience = ''
