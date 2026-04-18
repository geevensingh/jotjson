# JotJSON Infrastructure (Bicep)

Bicep templates for Azure resources backing JotJSON. See DESIGN_SPEC.md § Azure Infrastructure.

## Resources provisioned

- **Static Web App** — hosts the Angular SPA and SWA-managed Functions (`/api`).
- **Cosmos DB (serverless)** — database `jotjson` with containers:
  - `blobs` (partition key: `/ownerId`, 30-day default TTL for anonymous)
  - `users` (partition key: `/id`)
  - `history` (partition key: `/userId`)
  - `rule-sets` (partition key: `/userId`)
- **Blob Storage** — containers `avatars`, `exports`.
- **Application Insights + Log Analytics** — telemetry.

**Not provisioned here** (managed separately):
- Azure AD B2C tenant — must be created manually (separate control plane).
- DNS records for `jotjson.com` — configured at the registrar.

## Deploy (dev)

```powershell
az group create --name rg-jotjson-dev --location eastus2
az deployment group create `
  --resource-group rg-jotjson-dev `
  --template-file main.bicep `
  --parameters parameters/dev.bicepparam
```

## Deploy (prod)

```powershell
az group create --name rg-jotjson-prod --location eastus2
az deployment group create `
  --resource-group rg-jotjson-prod `
  --template-file main.bicep `
  --parameters parameters/prod.bicepparam
```
