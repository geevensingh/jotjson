using '../main.bicep'

// Non-production environment in the Visual Studio Enterprise subscription
// (`5698b024-0e2d-4d8b-8db5-fd401ed0ba4a`), funded by the VS subscriber
// $150/mo credit. Mirrors `dev` (which is currently prod) in shape so
// Phase 2 preview environments and future signed-in smoke (#68) have an
// independent target. Per the VS subscriber agreement this env is
// dev/test-only -- it must NOT serve real users.
// See plan: M1 non-prod environment plan.

param environmentName = 'nonprod'
param appName = 'jotjson'

// Required for SWA preview environments (`deployment_environment`).
param staticWebAppSku = 'Standard'

// No custom domain in non-prod; use the default *.azurestaticapps.net
// hostname assigned by the Static Web App resource. Apex binding flows
// (custom domain, DNS zone) are prod-only.
param customDomain = ''
param dnsZoneName = ''

// Entra External ID. Real values come from GH secrets via `-p` overrides
// in `infra-nonprod.yml` (same secrets as prod -- same CIAM tenant).
// Keep these empty in the committed param file; JWT validation is
// disabled until the overrides are passed.
param entraTenantId = ''
param entraAuthority = ''
param entraSpaClientId = ''
param entraApiClientId = ''
param entraApiAudience = ''

// Operational alerts receiver. Same address as prod -- the alerting
// surface is unified across environments by design (see issue #94).
param notificationEmail = 'jotjsonadmin@gmail.com'
