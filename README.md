# JotJSON

A place to **input, store, and display JSON**. Paste or type JSON (or JSONC)
on the left and it is parsed, formatted, and rendered as a searchable tree on
the right. Anonymous use is the default — signing in unlocks persistent,
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
| Data       | Azure Cosmos DB (serverless, NoSQL) — planned               |
| Auth       | MSAL Angular + Azure AD B2C — planned                       |
| Hosting    | Azure Static Web Apps with managed Functions                |
| IaC        | Bicep (`/infra`)                                            |
| Testing    | Karma + Jasmine (frontend); Jest planned for API            |
| CI/CD      | GitHub Actions (build, test, Bicep validate, SWA deploy)    |

Node **24** is required locally and in CI (pinned via `.nvmrc`, engines, and
workflow `node-version`).

## Repository layout

```
src/               Angular app (standalone components under core/shared/features)
  styles/          Global SCSS (Material theme, design tokens)
api/               Azure Functions (TypeScript)
infra/             Bicep templates
public/            Static assets copied as-is at build
.github/           Workflows (ci.yml, cd.yml, infra.yml) + dependabot.yml
DESIGN_SPEC.md     Product + architecture source of truth
AGENTS.md          Coding/AI-agent instructions (linted against by humans too)
CONTRIBUTING.md    Contributor guide
karma.conf.js      Karma config with ChromeHeadlessCI launcher
```

## Prerequisites

- Node **24** (`nvm use`)
- npm 10+
- For API local dev: Azure Functions Core Tools v4
  (`npm i -g azure-functions-core-tools@4`)
- For infra: Azure CLI + Bicep (`az bicep install`)

## Setup

```bash
npm install
(cd api && npm install)
```

## Development

### Web (Angular)

```bash
npm start              # ng serve on http://localhost:4200
npm run build          # production build to dist/jotjson
npm run lint           # tsc --noEmit type-check
npm test               # Karma + Jasmine, ChromeHeadless, single run
npm run test:ci        # Same, with coverage reporter (CI profile)
```

Tests are co-located as `*.spec.ts`. Run a single spec with
`npx ng test --include=src/app/path/to/file.spec.ts` or focus interactively
with Jasmine's `fdescribe` / `fit`.

Coverage reports land in `coverage/jotjson/` (`index.html` for browse,
`lcov.info` for tooling).

### API (Azure Functions)

```bash
cd api
npm run build          # tsc
npm start              # func start (also runs build via prestart)
npm run lint           # tsc --noEmit
```

`api/local.settings.sample.json` documents required settings — copy to
`local.settings.json` (gitignored) and fill in.

### Infra (Bicep)

Infrastructure is defined under `infra/` and validated by the `infra.yml`
workflow. See [`DESIGN_SPEC.md §Azure Infrastructure`](./DESIGN_SPEC.md) for
resource layout.

## CI / CD

Three workflows run on push and PR:

- **CI** (`ci.yml`) — Web build + type-check, API build, Bicep validate, web
  unit tests with coverage artifact.
- **CD** (`cd.yml`) — Deploys the web app + managed Functions to Azure Static
  Web Apps. Gated on `AZURE_STATIC_WEB_APPS_API_TOKEN` being configured.
- **Infra** (`infra.yml`) — `az deployment group what-if` / apply for Bicep
  changes. Gated on `vars.AZURE_CLIENT_ID` (OIDC federated credentials).

Dependencies are kept current by Dependabot (`.github/dependabot.yml`:
weekly npm `/`, npm `/api`, and `github-actions`).

## Contributing

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`AGENTS.md`](./AGENTS.md)
before opening a PR. Key rules:

- Changes must align with `DESIGN_SPEC.md` (update it in the same PR if
  behavior or architecture changes).
- Tests are required for logic changes. `npm run lint`, `npm test`, and
  `npm run build` must pass before merge (enforced by CI).
- Strict TypeScript; no `any`. Standalone Angular components, `OnPush`,
  `inject()`, Signals. Kebab-case filenames.
- Use `jsonc-parser` — never `JSON.parse` — for user JSON/JSONC input.
- Never log or transmit clipboard/editor contents. No secrets in source.

AI-assisted commits include:

```
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```
