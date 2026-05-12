# JotJSON Infrastructure (Bicep)

Bicep templates for Azure resources backing JotJSON. See DESIGN_SPEC.md § Azure Infrastructure.

## Resources provisioned

- **Static Web App** - hosts the Angular SPA and SWA-managed Functions (`/api`).
- **Azure DNS zone** - `jotjson.com`. Nameservers are delegated at the
  the registrar (GoDaddy) so SWA custom domain binding works. See
  [DNS + custom domain](#dns--custom-domain).
- **Cosmos DB (serverless)** - database `jotjson` with containers:
  - `blobs` (partition key: `/ownerId`, no TTL - persistent for registered users)
  - `users` (partition key: `/id`)
  - `history` (partition key: `/userId`)
  - `rule-sets` (partition key: `/userId`)
- **Blob Storage** - containers `avatars`, `exports`.
- **Application Insights + Log Analytics** - telemetry.

**Not provisioned here** (managed separately):
- Microsoft Entra External ID tenant + app registrations - must be created
  manually in the Entra admin center (see [Auth setup](#auth-setup)).
- Registrar nameserver delegation - one-time manual step at GoDaddy; see
  [DNS + custom domain](#dns--custom-domain).

## Current deployment

The live site runs out of `rg-jotjson-dev` / `swa-jotjson-dev` (the CD
pipeline's SWA deploy token targets that resource). For a solo project
there's no dev/prod separation; the `dev` environment **is** production.
A parallel `prod` stack can be added later if the split becomes useful.

## Deploy

Push to `main` (touching `infra/**` or `.github/workflows/infra.yml`)
auto-deploys after the workflow's build + what-if jobs pass. For a
manual redeploy (e.g., to roll back or reapply after manual Azure
changes), trigger **Actions -> Infra (Bicep) -> Run workflow**. The
workflow ensures `rg-jotjson-dev` exists before running
`az deployment group create`.

PRs run build only. `what-if` runs on push and on
`workflow_dispatch`, then deploy runs gated on its success.

Manual equivalent (bypasses CI; same template + parameters):

```powershell
az group create --name rg-jotjson-dev --location eastus2
az deployment group create `
  --resource-group rg-jotjson-dev `
  --template-file main.bicep `
  --parameters parameters/dev.bicepparam
```

## Auth setup (Microsoft Entra External ID)

Auth uses Microsoft Entra External ID (CIAM) with MSAL Angular in the browser
and JWT validation in the Functions API. Provisioning is manual; Bicep only
forwards the resulting identifiers as Functions app settings.

### 1. Create an External ID tenant

In the [Entra admin center](https://entra.microsoft.com/), create a new tenant
with the **External** configuration. Note the tenant id (GUID) and the
friendly subdomain (e.g. `jotjsonauth.ciamlogin.com`).

Authority URL is `https://jotjsonauth.ciamlogin.com/f23e8918-d46e-4248-9aa7-0044b5bce622/`.

### 2. Register the SPA app (browser)

- Platform: **Single-page application**.
- Redirect URIs:
  - `https://jotjson.com/`
  - `http://localhost:4200/` (dev)
- Post-logout redirect URIs: same as above.
- Leave implicit grant / hybrid flow unchecked.

Record the **Application (client) id** -> `ENTRA_SPA_CLIENT_ID`.

### 3. Register the API app (Functions)

- No redirect URIs.
- **Expose an API**: set Application ID URI to `api://6bb9ba72-7021-4232-9a97-649d18227b5c` and add a
  scope `access_as_user` (admins + users consent).

Record the **Application (client) id** -> `ENTRA_API_CLIENT_ID`.
The audience the API validates is `ENTRA_API_AUDIENCE = api://6bb9ba72-7021-4232-9a97-649d18227b5c`.

### 4. Wire the SPA to the API

On the SPA app registration -> **API permissions** -> add the
`access_as_user` delegated scope from the API app -> **Grant admin consent**.

The SPA's MSAL config uses `scopes: ['api://6bb9ba72-7021-4232-9a97-649d18227b5c/access_as_user']`.

### 5. Create the user flow

- Create a **Sign up and sign in** user flow.
- Enable identity providers:
  - **Email with password** (built-in).
  - **Google** - requires registering a separate OAuth 2.0 client in Google
    Cloud Console (authorized redirect URI is the tenant-issued callback;
    Entra shows the exact value). Paste the Google client id + secret into
    the Entra federation config.
- Assign the user flow to both app registrations.

### 6. GitHub Actions secrets

The deploy workflow builds the Angular SPA with environment values baked in
(SWA app settings only reach the Functions side, not the static bundle) and
forwards the same values to Bicep as deploy parameters. Configure these repo
secrets:

| Secret                  | Used by              | Example                                                                  |
| ----------------------- | -------------------- | ------------------------------------------------------------------------ |
| `ENTRA_TENANT_ID`       | Bicep                | `f23e8918-d46e-4248-9aa7-0044b5bce622`                                   |
| `ENTRA_AUTHORITY`       | Bicep + SPA build    | `https://jotjsonauth.ciamlogin.com/f23e8918-d46e-4248-9aa7-0044b5bce622/` |
| `ENTRA_KNOWN_AUTHORITY` | SPA build            | `jotjsonauth.ciamlogin.com`                                              |
| `ENTRA_SPA_CLIENT_ID`   | Bicep + SPA build    | `79f1f299-7d52-4efc-8c09-1f4ca929fe2c`                                   |
| `ENTRA_API_CLIENT_ID`   | Bicep                | `6bb9ba72-7021-4232-9a97-649d18227b5c`                                   |
| `ENTRA_API_SCOPE`       | SPA build            | `api://6bb9ba72-7021-4232-9a97-649d18227b5c/access_as_user`              |
| `ENTRA_API_AUDIENCE`    | Bicep                | `api://6bb9ba72-7021-4232-9a97-649d18227b5c`                             |

**What each consumer does with them:**

- **SPA build** (GitHub Actions `ci.yml`, push-to-main path; or
  `cd.yml` `workflow_dispatch` path): before
  `ng build --configuration=production`, writes a
  `src/environments/environment.prod.ts` substituting the values.
  The resulting static bundle therefore has the client id, authority,
  known-authority host, and API scope hard-baked. The bake step fails
  fast if any placeholder survives the substitution. CD's
  `workflow_run` path downloads the prebuilt `web-dist` artifact from
  the upstream CI run and skips the SPA build (`skip_app_build: true`).
- **Bicep** (GitHub Actions `infra.yml`, workflow_dispatch): passes the values
  as `--parameters` overrides on `az deployment group create`. They flow into
  the Static Web App's Functions app settings (`ENTRA_TENANT_ID`,
  `ENTRA_AUTHORITY`, `ENTRA_SPA_CLIENT_ID`, `ENTRA_API_CLIENT_ID`,
  `ENTRA_API_AUDIENCE`). The API reads `ENTRA_AUTHORITY` + `ENTRA_API_AUDIENCE`
  at runtime to validate JWTs.

**Redirect URIs to register on the SPA app** (Entra -> App registrations ->
JotJSON Web (SPA) -> Authentication, Single-page application platform):

- `https://jotjson.com/` - production custom domain.
- `http://localhost:4200/` - local `ng serve`.
- Optionally your SWA default hostname (e.g.
  `https://<site>.azurestaticapps.net/`) during the window before the custom
  domain is bound. The production build's `redirectUri` is hard-coded to
  `https://jotjson.com/` so sign-in via the SWA hostname won't round-trip
  until the custom domain is live.

**Manual local deploy example** (equivalent to what `infra.yml` runs):

```powershell
az deployment group create `
  --resource-group rg-jotjson-dev `
  --template-file main.bicep `
  --parameters parameters/dev.bicepparam `
  --parameters entraTenantId=$env:ENTRA_TENANT_ID `
               entraAuthority=$env:ENTRA_AUTHORITY `
               entraSpaClientId=$env:ENTRA_SPA_CLIENT_ID `
               entraApiClientId=$env:ENTRA_API_CLIENT_ID `
               entraApiAudience=$env:ENTRA_API_AUDIENCE
```

## DNS + custom domain

Apex (`jotjson.com`) is the canonical hostname. Azure Static Web Apps only
supports apex via ALIAS / ANAME / flattened CNAME records, which **GoDaddy
does not support**. So DNS lives in **Azure DNS** (zone provisioned by
`modules/dnsZone.bicep`), and GoDaddy is just the registrar that delegates
the zone to Azure nameservers.

**One-time setup:**

1. Deploy infra (`infra.yml` workflow, or the manual command above). Bicep
   creates the `jotjson.com` DNS zone in `rg-jotjson-dev`. The deployment
   output `dnsNameServers` lists 4 Azure nameservers, e.g.
   `ns1-xx.azure-dns.com`, `ns2-xx.azure-dns.net`, etc. (Also visible in the
   Azure portal -> DNS zone -> Overview.)
2. Log into GoDaddy -> **Domains -> jotjson.com -> Nameservers -> Change**.
   Replace GoDaddy's defaults with the 4 Azure nameservers. Save.
3. Wait for propagation (usually 15-60 min, up to 48h). Verify with
   `nslookup -type=NS jotjson.com` - it should return the Azure nameservers.
4. In the Azure portal -> Static Web App -> **Custom domains** -> delete any
   stale pending entries for `jotjson.com` left over from earlier attempts.
   Re-add using **Custom domain on Azure DNS** -> pick the `jotjson.com` zone.
   SWA creates the required TXT + alias A records in the zone automatically
   and issues a managed cert.
5. (Optional) For `www.jotjson.com`: GoDaddy -> Domain settings -> **Forwarding**
   -> forward `www.jotjson.com -> https://jotjson.com`, 301 Permanent.
   Alternatively, add `www` as a second custom domain on SWA and configure a
   redirect route in `staticwebapp.config.json`.

**After the domain is live**, confirm these are configured to match:

- `src/environments/environment.prod.ts` -> `redirectUri: 'https://jotjson.com/'` [x]
- Entra SPA app registration -> Authentication -> redirect URI includes
  `https://jotjson.com/` [x]

## Non-production environment

A second, **dev/test-only** stack runs in a separate Azure subscription
funded by Visual Studio Enterprise subscriber credits (~$150/mo,
non-transferable). It mirrors prod at lower scale so we can exercise
the deploy pipeline, validate Bicep changes, run anonymous e2e against
a real deployed URL, and host per-PR previews (Phase 2 of issue #93)
without spending production budget.

**Constraint:** VS subscriber Azure credits are licensed for
development and testing only. This stack has **no DNS, no marketing
link, and must not be advertised to real users**.

### Inventory

| Item | Value |
|---|---|
| Subscription | `5698b024-0e2d-4d8b-8db5-fd401ed0ba4a` ("Visual Studio Enterprise Subscription") |
| Resource group | `rg-jotjson-nonprod` (region: `eastus2`) |
| SWA name | `swa-jotjson-nonprod` (Standard SKU - matches prod) |
| SWA hostname | `calm-flower-01969880f.7.azurestaticapps.net` |
| Cosmos account | `cosmos-jotjson-nonprod` (serverless) |
| App Insights | `appi-jotjson-nonprod` (Log Analytics workspace: `appi-jotjson-nonprod-law`) |
| Storage (sourcemaps) | `stjotjsonnonprod` |
| Alerts | action group `ag-jotjson-nonprod`; alert rules `alert-jotjson-nonprod-{boot-failed,app-unhandled,auth-config,fn-5xx}` |
| GH Actions environment | `nonprod` |
| Workflows | `.github/workflows/infra-nonprod.yml`, `.github/workflows/cd-nonprod.yml` (both manual dispatch only) |
| Cost budget | `jotjson-nonprod-monthly` ($100/mo, 80%-actual email alert) |

### One-time bootstrap

Done once per fresh subscription. Captured here so the next person (or
a future Phase 3 third env) doesn't have to re-derive it.

**0. Register required resource providers.** Fresh subscriptions have
no resource providers registered. The first `infra-nonprod.yml` run
will fail at `az deployment group create` if these aren't
`Registered`. Run once per subscription:

```powershell
# Each entry uses the exact casing Azure returns from `az provider show`.
# Note `microsoft.insights` is genuinely lowercase in Azure's response -
# the verify query below uses case-sensitive `contains(...)`, so the two
# lists must match Azure's casing exactly.
$providers = @(
  'Microsoft.Storage',
  'Microsoft.DocumentDB',
  'microsoft.insights',
  'Microsoft.OperationalInsights',
  'Microsoft.Web',
  'Microsoft.AlertsManagement'
)
foreach ($ns in $providers) {
  az provider register --namespace $ns --subscription 5698b024-0e2d-4d8b-8db5-fd401ed0ba4a --wait
}
# Verify
az provider list --subscription 5698b024-0e2d-4d8b-8db5-fd401ed0ba4a `
  --query "[?contains(['Microsoft.Storage','Microsoft.DocumentDB','microsoft.insights','Microsoft.OperationalInsights','Microsoft.Web','Microsoft.AlertsManagement'], namespace)].[namespace, registrationState]" `
  -o table
```

Each provider must reach `registrationState=Registered` before
Bicep apply succeeds.

**1. Resource group.** Created up front so the federated cred has
somewhere to deploy to. (App Insights diagnostic settings and Storage
RBAC for the sourcemap upload are granted by Bicep on apply.)

```powershell
az account set --subscription 5698b024-0e2d-4d8b-8db5-fd401ed0ba4a
az group create --name rg-jotjson-nonprod --location eastus2
```

**2. Federated credential on the existing `gh-actions-jotjson` SP.**
JotJSON uses **one** service principal (`gh-actions-jotjson`) across
prod and nonprod - **do not create a new SP for nonprod**. Add a new
federated credential to that SP bound to the `nonprod` GitHub
environment. The same `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` repo-level
secrets are reused; only the subscription id differs per environment.

```powershell
# Look up the existing prod SP
$app = az ad app list --display-name 'gh-actions-jotjson' `
  --query '[0].{id:id,appId:appId}' -o json | ConvertFrom-Json

# Add a federated credential scoped to the 'nonprod' GH environment
$fic = @{
  name='gh-jotjson-nonprod'
  issuer='https://token.actions.githubusercontent.com'
  subject='repo:geevensingh/jotjson:environment:nonprod'
  audiences=@('api://AzureADTokenExchange')
} | ConvertTo-Json -Compress
az ad app federated-credential create --id $app.id --parameters $fic
```

The workflow files (`.github/workflows/infra-nonprod.yml`,
`cd-nonprod.yml`) call this out in their header comments.

**3. RG role assignment for the SP.** `Contributor` on the nonprod
RG. (Storage Blob Data Contributor on the sourcemap container is
granted by `cd-nonprod.yml` itself when it needs to.)

```powershell
az role assignment create `
  --assignee $app.appId `
  --role 'Contributor' `
  --scope /subscriptions/5698b024-0e2d-4d8b-8db5-fd401ed0ba4a/resourceGroups/rg-jotjson-nonprod
```

**4. GitHub Actions environment + secrets.** Create the `nonprod`
environment in repo settings. Secrets split into **repo-level** (shared
with prod, already exist if prod is set up) and **environment-level**
(nonprod-only, suffixed `_NONPROD`):

| Scope | Secret | Source |
|---|---|---|
| Repo (shared with prod) | `AZURE_CLIENT_ID` | `$app.appId` from step 2 (same SP as prod) |
| Repo (shared with prod) | `AZURE_TENANT_ID` | `az account show --query tenantId -o tsv` |
| Repo (shared with prod) | `ENTRA_TENANT_ID`, `ENTRA_AUTHORITY`, `ENTRA_KNOWN_AUTHORITY`, `ENTRA_SPA_CLIENT_ID`, `ENTRA_API_CLIENT_ID`, `ENTRA_API_AUDIENCE`, `ENTRA_API_SCOPE` | Same External ID tenant as prod (see Auth setup above) |
| `nonprod` env | `AZURE_SUBSCRIPTION_ID_NONPROD` | `5698b024-0e2d-4d8b-8db5-fd401ed0ba4a` |
| `nonprod` env | `AZURE_STATIC_WEB_APPS_API_TOKEN_NONPROD` | `az staticwebapp secrets list --name swa-jotjson-nonprod --resource-group rg-jotjson-nonprod --query "properties.apiKey" -o tsv` (after the first infra deploy creates the SWA) |
| `nonprod` env | `APP_INSIGHTS_CONNECTION_STRING_NONPROD` | from the App Insights resource in the portal, after the first infra deploy |
| `nonprod` env | `AZURE_STORAGE_ACCOUNT_NONPROD` | `stjotjsonnonprod` (used by `cd-nonprod.yml` to upload sourcemaps) |

> **PowerShell + `gh secret set` tip.** Setting a secret with
> `gh secret set NAME --body "$var"` is fragile if `$var` was set in a
> different shell scope. The reliable form is **stdin**:
>
> ```powershell
> $token = az staticwebapp secrets list --name swa-jotjson-nonprod --resource-group rg-jotjson-nonprod --query "properties.apiKey" -o tsv
> $token | gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN_NONPROD --repo geevensingh/jotjson
> ```
>
> This avoids quoting hell and PowerShell's "empty arg makes `gh` block
> on stdin" quirk.

**5. Entra redirect URI.** Add `https://<nonprod-hostname>/` to the
JotJSON SPA app registration's Single-page application redirect URIs
in the same Entra External ID tenant used by prod. The
`cd-nonprod.yml` deploy includes a strict-allowlist guard that fails
if the SWA hostname doesn't match the expected value, so accidentally
deploying to a different SWA won't silently break sign-in.

### Manual deploy commands

Both workflows are dispatch-only. From the Actions UI:

- **`Infra (Bicep) - nonprod`** -> applies `main.bicep` with
  `parameters/nonprod.bicepparam`.
- **`Deploy (SWA) - nonprod`** -> deploys the SPA + Functions bundle
  to the nonprod SWA. Runs the strict-allowlist redirect-URI guard
  and the Storage-RBAC sourcemap upload.

Manual local equivalents:

```powershell
# Infra
az deployment group create `
  --resource-group rg-jotjson-nonprod `
  --template-file main.bicep `
  --parameters parameters/nonprod.bicepparam

# Deploy (the workflow path is the supported one - this is for break-glass only)
# See cd-nonprod.yml for the full env-var bake step and SWA deploy invocation.
```

### Cost budget runbook

Subscription-scoped budgets with notifications **cannot** be created
via `az consumption budget create` - that command accepts no
notification flags in current `az`. Use the Consumption REST API:

```powershell
$body = @{
  properties = @{
    category = 'Cost'
    amount = 100
    timeGrain = 'Monthly'
    timePeriod = @{
      startDate = '2026-05-01T00:00:00Z'  # first of current month, UTC
      endDate   = '2030-05-01T00:00:00Z'
    }
    notifications = @{
      Actual_GreaterThan_80_Percent = @{
        enabled = $true
        operator = 'GreaterThan'
        threshold = 80
        thresholdType = 'Actual'
        contactEmails = @('jotjsonadmin@gmail.com')
      }
    }
  }
} | ConvertTo-Json -Depth 6 -Compress

$body | Out-File -Encoding utf8 budget.json

az rest --method put `
  --url "https://management.azure.com/subscriptions/5698b024-0e2d-4d8b-8db5-fd401ed0ba4a/providers/Microsoft.Consumption/budgets/jotjson-nonprod-monthly?api-version=2024-08-01" `
  --body '@budget.json'
```

Notes:
- `startDate` **must** be the 1st of the month in UTC; the API rejects
  back-dated values outside the current time-grain period.
- `properties.notifications` is a dict keyed by an arbitrary
  notification name. The Azure API echoes the key back with a
  lowercased first letter (`actual_GreaterThan_80_Percent`) - harmless
  cosmetic.

To add additional thresholds (e.g., 100% Actual or Forecasted), add
more entries to the `notifications` dict with distinct keys.

### Pointer

- Workflow files: `.github/workflows/infra-nonprod.yml`,
  `.github/workflows/cd-nonprod.yml`.
- Bicep parameters: `infra/parameters/nonprod.bicepparam`.
- Spec section: DESIGN_SPEC.md -> Azure Infrastructure -> "Non-production environment".
- Tracking issue: #93 (Phase 1 in this RG; Phase 2 wires per-PR previews into this same stack).
