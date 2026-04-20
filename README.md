# JotJSON

A place to **input, store, and display JSON**. Paste or type JSON (or JSONC)
on the left and it is parsed, formatted, and rendered as a searchable tree on
the right. Anonymous use is the default - signing in unlocks persistent,
shareable links, history, and formatting rules (planned).

Production site: **https://jotjson.com** (target).
Preview: https://ambitious-pond-000670a0f.7.azurestaticapps.net/

[`DESIGN_SPEC.md`](./DESIGN_SPEC.md) is the authoritative product and
architecture spec.

## Tech stack

| Layer      | Choice                                                      |
| ---------- | ----------------------------------------------------------- |
| Frontend   | Angular 19 (standalone + Signals), Angular Material, SCSS   |
| Editor     | Monaco (lazy-loaded), [`jsonc-parser`](https://www.npmjs.com/package/jsonc-parser) for JSON/JSONC parsing |
| Backend    | Azure Functions v4, TypeScript (Node 24)                    |
| Data       | Azure Cosmos DB (serverless, NoSQL)                         |
| Auth       | MSAL Angular + Microsoft Entra External ID                  |
| Hosting    | Azure Static Web Apps with managed Functions                |
| IaC        | Bicep (`/infra`)                                            |
| Testing    | Karma + Jasmine (frontend); Jest (API)                      |
| CI/CD      | GitHub Actions (build, test, Bicep validate, SWA deploy)    |

Node **24** is required locally and in CI (pinned via `.nvmrc`, engines, and
workflow `node-version`).

## Repository layout

```
src/               Angular app (standalone components under core/shared/features)
  styles/          Global SCSS (Material theme, design tokens)
  environments/    environment.ts (gitignored) + example + interface + prod
api/               Azure Functions (TypeScript)
infra/             Bicep templates
public/            Static assets copied as-is at build
scripts/           Repo tooling (check-ascii.mjs, generate-icons.mjs, ...)
.github/           Workflows (ci.yml, cd.yml, infra.yml) + dependabot.yml
.vscode/           Launch + tasks configs (ng serve / ng test in Chrome)
DESIGN_SPEC.md     Product + architecture source of truth
AGENTS.md          Coding/AI-agent instructions (linted against by humans too)
CONTRIBUTING.md    Contributor guide
karma.conf.js      Karma config with ChromeHeadlessCI launcher
proxy.conf.json    ng serve proxy that forwards /api/* to func start on :7071
```

## Prerequisites

- Node **24** (pinned via `.nvmrc`; works with `nvm use` or `fnm use`)
- npm 10+
- For API local dev: Azure Functions Core Tools v4
- For infra: Azure CLI + Bicep
- A Chromium-family browser on PATH for `npm test`

Detailed install instructions (by OS, with verification steps and
troubleshooting) are in [PREREQUISITES.md](PREREQUISITES.md).

## Setup

```bash
npm install
(cd api && npm install)

# Web env: copy the template and fill in Entra values for local sign-in.
cp src/environments/environment.example.ts src/environments/environment.ts

# API env: copy the template and fill in Cosmos + Entra values.
cp api/local.settings.sample.json api/local.settings.json
```

`environment.ts` and `api/local.settings.json` are gitignored. For CI, the
workflow copies `environment.example.ts` over `environment.ts` unchanged -
production builds source their real values from `environment.prod.ts`, which
CD bakes from GitHub secrets.

## Running locally

The Angular dev server proxies `/api/*` to the local Functions host
(`proxy.conf.json` -> `http://localhost:7071`), so both pieces need to be
running to exercise the full stack.

```bash
# Terminal 1 - Functions API on :7071
cd api
npm start              # runs `func start` (prestart = tsc)

# Terminal 2 - Angular SPA on :4200
npm start              # ng serve, proxies /api/* to :7071
```

Then open <http://localhost:4200>.

**Signing in locally** requires the Entra External ID app registration to
include `http://localhost:4200/` as a redirect URI for both SPA and profile,
and the matching client/tenant IDs filled into `environment.ts` and
`api/local.settings.json`. See `infra/README.md` for the one-time manual
Entra setup steps.

**Custom auth header.** The SPA sends its bearer token as
`X-Jotjson-Authorization` (Azure Static Web Apps' managed-Functions runtime
rewrites the standard `Authorization` header; the API reads both but SPA
clients must use `X-Jotjson-Authorization`). See
[`DESIGN_SPEC.md` #Auth forwarding](./DESIGN_SPEC.md).

### Debugging in VS Code

`.vscode/launch.json` includes two configs:

- **`ng serve`** - launches Chrome against `http://localhost:4200/` and runs
  `npm: start` as a preLaunchTask. Set breakpoints in `.ts` files and they
  bind through the Angular source map.
- **`ng test`** - launches the Karma debug runner at
  `http://localhost:9876/debug.html` with `npm: test` as preLaunchTask so you
  can step through spec execution.

For the Functions API, run `cd api; npm start` in a terminal and attach
VS Code's Node debugger to the spawned `func` process (Attach to Node
Process), or install the Azure Functions extension and use its "Attach to
Node Functions" config.

### Web (Angular) commands

```bash
npm start              # ng serve on http://localhost:4200 (proxies /api/*)
npm run build          # production build to dist/jotjson
npm run lint           # tsc --noEmit type-check
npm run check:ascii    # fail if non-allowlisted non-ASCII sneaks in
npm test               # Karma + Jasmine, ChromeHeadless, single run
npm run test:ci        # Same, with coverage reporter (CI profile)
```

Tests are co-located as `*.spec.ts`. Run a single spec with
`npx ng test --include=src/app/path/to/file.spec.ts` or focus interactively
with Jasmine's `fdescribe` / `fit`.

Coverage reports land in `coverage/jotjson/` (`index.html` for browse,
`lcov.info` for tooling).

### API (Azure Functions) commands

```bash
cd api
npm run build          # tsc
npm start              # func start on :7071 (runs build via prestart)
npm run lint           # tsc --noEmit
npm test               # Jest (mocked Cosmos + Blob clients)
```

`api/local.settings.sample.json` documents required settings - copy to
`local.settings.json` (gitignored) and fill in real values from Azure.

### Infra (Bicep)

Infrastructure is defined under `infra/` and validated by the `infra.yml`
workflow. See [`DESIGN_SPEC.md` #Azure Infrastructure](./DESIGN_SPEC.md)
and [`infra/README.md`](./infra/README.md) for resource layout and the
one-time Entra app-registration walkthrough.

## CI / CD

Three workflows run on push and PR:

- **CI** (`ci.yml`) - Web build + type-check, API build, Bicep validate, web
  unit tests with coverage artifact.
- **CD** (`cd.yml`) - Deploys the web app + managed Functions to Azure Static
  Web Apps. Gated on `AZURE_STATIC_WEB_APPS_API_TOKEN` being configured.
- **Infra** (`infra.yml`) - `az deployment group what-if` / apply for Bicep
  changes. Gated on `vars.AZURE_CLIENT_ID` (OIDC federated credentials).

Dependencies are kept current by Dependabot (`.github/dependabot.yml`:
weekly npm `/`, npm `/api`, and `github-actions`).

## Release history

Milestone boundaries are captured as annotated git tags. List them with
`git tag -l 'm*-complete'` or view details with `git show m3-complete`:

- **`m1-complete`** - project scaffolding (SPA, Functions, Bicep, CI/CD).
- **`m2-complete`** - core editor experience (Monaco, tree view, search,
  theming, PWA, i18n).
- **`m3-complete`** - Entra External ID sign-in + cloud-synced preferences.

## Contributing

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`AGENTS.md`](./AGENTS.md)
before opening a PR. Key rules:

- Changes must align with `DESIGN_SPEC.md` (update it in the same PR if
  behavior or architecture changes).
- Tests are required for logic changes. `npm run lint`, `npm test`,
  `npm run build`, and `npm run check:ascii` must pass before merge
  (enforced by CI).
- Strict TypeScript; no `any`. Standalone Angular components, `OnPush`,
  `inject()`, Signals. Kebab-case filenames.
- Use `jsonc-parser` - never `JSON.parse` - for user JSON/JSONC input.
- Tracked source files are ASCII-only (see
  `scripts/check-ascii.mjs` and `AGENTS.md` #ASCII-only repository).
- Never log or transmit clipboard/editor contents. No secrets in source.

AI-assisted commits include:

```
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```
