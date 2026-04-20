# JotJSON Infrastructure (Bicep)

Bicep templates for Azure resources backing JotJSON. See DESIGN_SPEC.md § Azure Infrastructure.

## Resources provisioned

- **Static Web App** — hosts the Angular SPA and SWA-managed Functions (`/api`).
- **Azure DNS zone** (prod only) — `jotjson.com`. Nameservers are delegated at
  the registrar (GoDaddy) so SWA custom domain binding works. See
  [DNS + custom domain](#dns--custom-domain).
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
- Registrar nameserver delegation — one-time manual step at GoDaddy; see
  [DNS + custom domain](#dns--custom-domain).

## Current deployment

The live site runs out of `rg-jotjson-dev` / `swa-jotjson-dev` (the CD
pipeline's SWA deploy token targets that resource). For a solo project there's
no dev/prod separation today; the `dev` environment **is** production.
`prod.bicepparam` exists for the day a split is useful, but it isn't wired to
anything live.

## Deploy

Trigger **Actions → Deploy infra (Bicep) → Run workflow → dev** (or `prod`
once a parallel stack is warranted). The workflow ensures the resource group
exists before running `az deployment group create`.

Manual equivalent:

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

## DNS + custom domain

Apex (`jotjson.com`) is the canonical hostname. Azure Static Web Apps only
supports apex via ALIAS / ANAME / flattened CNAME records, which **GoDaddy
does not support**. So prod DNS lives in **Azure DNS** (zone provisioned by
`modules/dnsZone.bicep`), and GoDaddy is just the registrar that delegates
the zone to Azure nameservers.

**One-time setup:**

1. Deploy infra (`infra.yml` workflow, or the manual command above). Bicep
   creates the `jotjson.com` DNS zone in `rg-jotjson-prod`. The deployment
   output `dnsNameServers` lists 4 Azure nameservers, e.g.
   `ns1-xx.azure-dns.com`, `ns2-xx.azure-dns.net`, etc. (Also visible in the
   Azure portal → DNS zone → Overview.)
2. Log into GoDaddy → **Domains → jotjson.com → Nameservers → Change**.
   Replace GoDaddy's defaults with the 4 Azure nameservers. Save.
3. Wait for propagation (usually 15–60 min, up to 48h). Verify with
   `nslookup -type=NS jotjson.com` — it should return the Azure nameservers.
4. In the Azure portal → Static Web App → **Custom domains** → delete any
   stale pending entries for `jotjson.com` left over from earlier attempts.
   Re-add using **Custom domain on Azure DNS** → pick the `jotjson.com` zone.
   SWA creates the required TXT + alias A records in the zone automatically
   and issues a managed cert.
5. (Optional) For `www.jotjson.com`: GoDaddy → Domain settings → **Forwarding**
   → forward `www.jotjson.com → https://jotjson.com`, 301 Permanent.
   Alternatively, add `www` as a second custom domain on SWA and configure a
   redirect route in `staticwebapp.config.json`.

**After the domain is live**, confirm these are configured to match:

- `src/environments/environment.prod.ts` → `redirectUri: 'https://jotjson.com/'` ✔
- Entra SPA app registration → Authentication → redirect URI includes
  `https://jotjson.com/` ✔
