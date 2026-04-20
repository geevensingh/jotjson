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

| Secret                  | Used by              | Example                                          |
| ----------------------- | -------------------- | ------------------------------------------------ |
| `ENTRA_TENANT_ID`       | Bicep                | `00000000-0000-0000-0000-000000000000`           |
| `ENTRA_AUTHORITY`       | Bicep + SPA build    | `https://jotjsonauth.ciamlogin.com/<tenantId>/`  |
| `ENTRA_KNOWN_AUTHORITY` | SPA build            | `jotjsonauth.ciamlogin.com`                      |
| `ENTRA_SPA_CLIENT_ID`   | Bicep + SPA build    | SPA app registration's Application (client) id   |
| `ENTRA_API_CLIENT_ID`   | Bicep                | API app registration's Application (client) id   |
| `ENTRA_API_SCOPE`       | SPA build            | `api://<apiClientId>/access_as_user`             |
| `ENTRA_API_AUDIENCE`    | Bicep                | `api://<apiClientId>`                            |

**What each consumer does with them:**

- **SPA build** (GitHub Actions `cd.yml`): before `ng build --configuration=production`,
  writes a `src/environments/environment.prod.ts` substituting the values.
  The resulting static bundle therefore has the client id, authority,
  known-authority host, and API scope hard-baked. The deploy step then fails
  fast if any placeholder survives the substitution.
- **Bicep** (GitHub Actions `infra.yml`, workflow_dispatch): passes the values
  as `--parameters` overrides on `az deployment group create`. They flow into
  the Static Web App's Functions app settings (`ENTRA_TENANT_ID`,
  `ENTRA_AUTHORITY`, `ENTRA_SPA_CLIENT_ID`, `ENTRA_API_CLIENT_ID`,
  `ENTRA_API_AUDIENCE`). The API reads `ENTRA_AUTHORITY` + `ENTRA_API_AUDIENCE`
  at runtime to validate JWTs.

**Redirect URIs to register on the SPA app** (Entra → App registrations →
JotJSON Web (SPA) → Authentication, Single-page application platform):

- `https://jotjson.com/` — production custom domain.
- `http://localhost:4200/` — local `ng serve`.
- Optionally your SWA default hostname (e.g.
  `https://<site>.azurestaticapps.net/`) during the window before the custom
  domain is bound. The production build's `redirectUri` is hard-coded to
  `https://jotjson.com/` so sign-in via the SWA hostname won't round-trip
  until the custom domain is live.

**Manual local deploy example** (equivalent to what `infra.yml` runs):

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

