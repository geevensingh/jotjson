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
- Microsoft Entra External ID tenant + app registrations — must be created
  manually in the Entra admin center (see [Auth setup](#auth-setup)).
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

## Auth setup (Microsoft Entra External ID)

Auth uses Microsoft Entra External ID (CIAM) with MSAL Angular in the browser
and JWT validation in the Functions API. Provisioning is manual; Bicep only
forwards the resulting identifiers as Functions app settings.

### 1. Create an External ID tenant

In the [Entra admin center](https://entra.microsoft.com/), create a new tenant
with the **External** configuration. Note the tenant id (GUID) and the
friendly subdomain (e.g. `jotjsonauth.ciamlogin.com`).

Authority URL is `https://<subdomain>.ciamlogin.com/<tenantId>/`.

### 2. Register the SPA app (browser)

- Platform: **Single-page application**.
- Redirect URIs:
  - `https://jotjson.com/`
  - `http://localhost:4200/` (dev)
- Post-logout redirect URIs: same as above.
- Leave implicit grant / hybrid flow unchecked.

Record the **Application (client) id** → `ENTRA_SPA_CLIENT_ID`.

### 3. Register the API app (Functions)

- No redirect URIs.
- **Expose an API**: set Application ID URI to `api://<apiClientId>` and add a
  scope `access_as_user` (admins + users consent).

Record the **Application (client) id** → `ENTRA_API_CLIENT_ID`.
The audience the API validates is `ENTRA_API_AUDIENCE = api://<apiClientId>`.

### 4. Wire the SPA to the API

On the SPA app registration → **API permissions** → add the
`access_as_user` delegated scope from the API app → **Grant admin consent**.

The SPA's MSAL config uses `scopes: ['api://<apiClientId>/access_as_user']`.

### 5. Create the user flow

- Create a **Sign up and sign in** user flow.
- Enable identity providers:
  - **Email with password** (built-in).
  - **Google** — requires registering a separate OAuth 2.0 client in Google
    Cloud Console (authorized redirect URI is the tenant-issued callback;
    Entra shows the exact value). Paste the Google client id + secret into
    the Entra federation config.
- Assign the user flow to both app registrations.

### 6. GitHub Actions secrets

The deploy workflow builds the Angular SPA with environment values baked in
(SWA app settings only reach the Functions side, not the static bundle) and
forwards the same values to Bicep as deploy parameters. Configure these repo
secrets:

| Secret                  | Example                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `ENTRA_TENANT_ID`       | `00000000-0000-0000-0000-000000000000`                     |
| `ENTRA_AUTHORITY`       | `https://jotjsonauth.ciamlogin.com/<tenantId>/`            |
| `ENTRA_KNOWN_AUTHORITY` | `jotjsonauth.ciamlogin.com`                                |
| `ENTRA_SPA_CLIENT_ID`   | SPA app registration's Application (client) id            |
| `ENTRA_API_CLIENT_ID`   | API app registration's Application (client) id            |
| `ENTRA_API_SCOPE`       | `api://<apiClientId>/access_as_user`                       |
| `ENTRA_API_AUDIENCE`    | `api://<apiClientId>`                                      |

At deploy time, pass the infra-bound values through as Bicep overrides:

```powershell
az deployment group create `
  --resource-group rg-jotjson-prod `
  --template-file main.bicep `
  --parameters parameters/prod.bicepparam `
  --parameters entraTenantId=$env:ENTRA_TENANT_ID `
               entraAuthority=$env:ENTRA_AUTHORITY `
               entraSpaClientId=$env:ENTRA_SPA_CLIENT_ID `
               entraApiClientId=$env:ENTRA_API_CLIENT_ID `
               entraApiAudience=$env:ENTRA_API_AUDIENCE
```

