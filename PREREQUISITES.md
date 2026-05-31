# Prerequisites

Detailed install instructions for every tool needed to build, test, and
run JotJSON locally. For a quick overview and the day-to-day dev flow,
see [README.md](README.md).

All tool versions here match what CI uses and what `.nvmrc` / `package.json`
pin. Windows, macOS, and Linux steps are listed where they diverge.

## Summary

| Tool                        | Version | Required for          |
| --------------------------- | ------- | --------------------- |
| Node.js                     | 24.x    | Web + API             |
| npm                         | 10+     | Web + API (ships with Node 24) |
| Azure Functions Core Tools  | v4      | Running the API locally |
| Azure CLI                   | latest  | Deploying / inspecting Azure resources |
| Bicep                       | latest  | Authoring + deploying `infra/` |
| Git                         | 2.30+   | Everything            |
| A Chromium-based browser    | latest  | `npm test` (Vitest browser via Playwright Chromium); perf bench (Karma) |
| Windows Terminal (`wt`)     | latest  | `scripts/dev.ps1` (Windows only) |
| VS Code (optional)          | latest  | Shipped debug configs in `.vscode/` |

---

## 1. Node.js 24 (required)

The repo pins Node **24** via `.nvmrc`. Use a version manager so you can
switch between projects without reinstalling Node globally.

### Option A: fnm (recommended, cross-platform)

[fnm](https://github.com/Schniz/fnm) ("Fast Node Manager") is a
single-binary version manager written in Rust. It's fast, reads
`.nvmrc` out of the box, and works identically on macOS, Linux, and
Windows. Full docs: https://github.com/Schniz/fnm.

#### macOS

Install via Homebrew:

```bash
brew install fnm
```

or via the official installer script:

```bash
curl -fsSL https://fnm.vercel.app/install | bash
```

Then wire it into your shell so `fnm` is on PATH and auto-switches when
you `cd` into a directory with a `.nvmrc`. Add **one** of these lines
to your shell rc file and restart the shell:

```bash
# ~/.zshrc  (default on modern macOS)
eval "$(fnm env --use-on-cd --shell zsh)"

# ~/.bashrc
eval "$(fnm env --use-on-cd --shell bash)"

# ~/.config/fish/config.fish
fnm env --use-on-cd --shell fish | source
```

#### Linux

Install via the official script:

```bash
curl -fsSL https://fnm.vercel.app/install | bash
```

This installs the binary to `~/.local/share/fnm` and appends the shell
hook to `~/.bashrc` or `~/.zshrc` for you. Restart your shell.

If your distro has a package (Arch: `pacman -S fnm`), that works too -
but you'll still need to add the `eval "$(fnm env --use-on-cd ...)"`
hook manually.

#### Windows

Install via winget (Windows 10 / 11):

```powershell
winget install Schniz.fnm
```

Alternatives:

- Scoop: `scoop install fnm`
- Chocolatey: `choco install fnm`
- Cargo (if you have Rust): `cargo install fnm`

Then wire it into PowerShell. Open your profile:

```powershell
notepad $PROFILE
```

Add this line and save:

```powershell
fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression
```

Restart PowerShell. If `notepad $PROFILE` complains the file doesn't
exist, create it first with `New-Item -Type File -Path $PROFILE -Force`.

#### Install Node 24 with fnm

Once `fnm` is on PATH in a fresh shell:

```bash
fnm install 24          # downloads latest 24.x
fnm use 24              # activates it in the current shell
fnm default 24          # makes it the default for new shells
```

On Windows the version string must be explicit:

```powershell
fnm install 24.15.0
fnm use 24.15.0
fnm default 24.15.0
```

With the `--use-on-cd` hook active, `cd C:\Repos\jotjson` (or wherever
you cloned the repo) will auto-switch to the version in `.nvmrc`.

### Option B: nvm

- macOS / Linux: https://github.com/nvm-sh/nvm#install--update-script
- Windows: https://github.com/coreybutler/nvm-windows/releases

```bash
nvm install 24
nvm use 24
```

### Option C: the Node.js installer

If you don't want a version manager, grab the LTS installer from
https://nodejs.org/. Pick the **24.x** line. This pollutes your PATH
with a global Node - fine for hobby use, painful if you work on
projects pinned to different major versions.

### Verify

```bash
node --version   # v24.x.x
npm --version    # 10.x or newer
```

---

## 2. Azure Functions Core Tools v4 (required for API)

Needed to run `func start` in `api/` so the Angular dev proxy can reach
a local Functions host on `:7071`.

**npm (simplest, cross-platform):**

```bash
npm install --global azure-functions-core-tools@4 --unsafe-perm true
```

**macOS (Homebrew):**

```bash
brew tap azure/functions
brew install azure-functions-core-tools@4
```

**Windows (winget):**

```powershell
winget install Microsoft.Azure.FunctionsCoreTools
```

**Debian / Ubuntu:** follow the apt repository steps in
[Microsoft's docs](https://learn.microsoft.com/azure/azure-functions/functions-run-local#install-the-azure-functions-core-tools).

### Verify

```bash
func --version   # 4.x.x
```

---

## 3. Git (required)

- macOS: `xcode-select --install` or `brew install git`
- Windows: https://git-scm.com/download/win (ships Git Bash too)
- Linux: `sudo apt install git` / `sudo dnf install git`

Configure your identity once:

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

See [AGENTS.md](AGENTS.md) for repo-specific git conventions (no rebase,
path-explicit `git add`, required co-author trailer for AI commits).

---

## 4. Azure CLI + Bicep (required for local API dev; required for `infra/`)

The Azure CLI is needed for two things:

1. **Local API development.** Running `func start` needs read/write access
   to the dev Cosmos DB (`cosmos-jotjson-dev`). The cleanest way is to
   sign in with `az login` and let the SDK use your AAD principal -- see
   [Cosmos DB local access](#cosmos-db-local-access) below for the
   data-plane role assignment you'll also need.
2. **Touching `infra/` or other Azure resources.** Bicep deployments,
   resource provisioning, etc.

Skipping this section only works for *purely* client-side changes -
editor formatting, tree rendering, search, theming, and similar UI work
that never hits `/api/*`. Anything that exercises sign-in, save/load,
share URLs (`/s/<slug>`), recently-viewed history, profile pages, or
rule-set persistence will fail or appear broken until you complete this
section.

### Azure CLI

- macOS: `brew install azure-cli`
- Windows: `winget install -e --id Microsoft.AzureCLI`
- Linux / other: https://learn.microsoft.com/cli/azure/install-azure-cli

Then sign in:

```bash
az login
az account set --subscription "JotJson Subscription"
```

If `az login` fails with `AADSTS50076` (MFA required) on your default
tenant, re-run pointing at the tenant that owns the subscription
hosting `rg-jotjson-dev`:

```bash
az login --tenant 68fa6d3c-ab3e-4eea-97bb-f0376ea54cba
```

### Bicep

Bicep ships as an Azure CLI extension. Install / upgrade with:

```bash
az bicep install
az bicep upgrade
```

### Verify

```bash
az --version
az bicep version
```

See [infra/README.md](infra/README.md) for the one-time Azure setup
walkthrough (resource group, SWA, Cosmos, Entra app registration).

### Cosmos DB local access

Running `func start` against the shared dev Cosmos account
(`cosmos-jotjson-dev` in `rg-jotjson-dev`) needs **data-plane** access.
Cosmos data-plane permissions are separate from regular Azure RBAC;
without them the SDK returns `Request blocked by Auth ... does not
have required RBAC permissions to perform action
[Microsoft.DocumentDB/databaseAccounts/readMetadata]`.

Pick one path. Option A is recommended for ongoing dev; Option B is
the fast unblock if you can't grant yourself the role.

**Option A (recommended): self-assign the Cosmos DB Built-in Data
Contributor role.**

Leave `COSMOS_KEY` empty in `api/local.settings.json`. The SDK will
fall through `ChainedTokenCredential` and pick up your `az login`
token. Then assign the data-plane role to your AAD principal:

```bash
# Find your principal id (object id in the tenant where Cosmos lives).
PRINCIPAL_ID=$(az ad signed-in-user show --query id -o tsv)

# Built-in role: 00000000-0000-0000-0000-000000000002
#   = Cosmos DB Built-in Data Contributor
az cosmosdb sql role assignment create `
  --account-name cosmos-jotjson-dev `
  --resource-group rg-jotjson-dev `
  --role-definition-id 00000000-0000-0000-0000-000000000002 `
  --principal-id $PRINCIPAL_ID `
  --scope "/"
```

Pros: no secrets on disk; mirrors how the deployed Function App
authenticates. Cons: the first run requires someone with
`Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments/write` on
the account (typically the account owner / a maintainer) to grant it
to you -- you can self-grant only if you already have that
permission.

**Option B (fast fallback): paste the Cosmos primary key into
`COSMOS_KEY`.**

```bash
az cosmosdb keys list `
  --name cosmos-jotjson-dev `
  --resource-group rg-jotjson-dev `
  --query primaryMasterKey -o tsv
```

Or grab it from the Azure Portal: Cosmos DB account ->
**Settings -> Keys -> PRIMARY KEY**. Paste it into the `COSMOS_KEY`
slot in `api/local.settings.json` and restart `func start`.

Pros: works in 30 seconds, no role-assignment dance. Cons: a
full-control account key sits in a (gitignored) file on your laptop;
rotating it forces every contributor to refresh.

---

## 5. Headless Chrome (required for `npm test`)

The Vitest unit-test runner uses **browser mode**, driving a real
Chromium via Playwright. Vitest provisions its own Chromium binary
under `~/.cache/ms-playwright/` the first time you run the suite -- you
don't need a system Chrome on PATH for the vitest unit tests. To
prefetch the browser explicitly:

```bash
npx playwright install chromium
```

The perf bench (`npm run perf:l2`) is still on Karma+Jasmine and
*does* require a Chromium-family browser on PATH via `CHROME_BIN`.
That migration is tracked separately; see `docs/perf.md`.

- **Chrome**: https://www.google.com/chrome/
- **Edge** (Chromium-based, ships with Windows): no install needed, but
  point Karma at it via `CHROME_BIN` if Chrome itself isn't present:
  ```powershell
  $env:CHROME_BIN = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
  ```
- **Chromium** on Linux: `sudo apt install chromium-browser`

CI runs Vitest browser mode against the Playwright-bundled Chromium
(installed by `npx playwright install --with-deps chromium`).

### Verify

```bash
npm test            # web unit tests (vitest)
(cd api && npm test)  # API unit tests (jest, no browser needed)
```

---

## 6. Windows Terminal (Windows only, for `scripts/dev.ps1`)

`scripts/dev.ps1` opens multiple terminal tabs via `wt.exe` to run the
web dev server, the Functions host, and the test watchers side by side.
If you skip the helper script and run things manually, you don't need
Windows Terminal at all.

Install via winget:

```powershell
winget install Microsoft.WindowsTerminal
```

Or grab it from the Microsoft Store. macOS / Linux contributors run the
manual two-terminal flow documented in [README.md § Running locally](README.md#running-locally).

### Verify

```powershell
wt --version
```

---

## 7. VS Code (optional, but recommended)

The repo ships VS Code launch configs in `.vscode/` that Just Work:

- **Web: ng serve (Chrome)** - starts Angular + opens Chrome with the
  debugger attached.
- **Api: attach** - attaches to `func start` running in a terminal.

For Vitest, install the
[Vitest VS Code extension](https://marketplace.visualstudio.com/items?itemName=vitest.explorer)
or run `npm run test:watch` in a terminal. The extension reads
`vitest.config.mts` directly.

Install VS Code from https://code.visualstudio.com/. Recommended
extensions:

- **Angular Language Service** (`Angular.ng-template`)
- **ESLint** (`dbaeumer.vscode-eslint`)
- **Azure Functions** (`ms-azuretools.vscode-azurefunctions`)
- **Bicep** (`ms-azuretools.vscode-bicep`) - only if touching `infra/`

---

## 8. Environment files

These aren't tools, but they're part of first-time setup. See
[README.md § Setup](README.md#setup) for the exact commands. You'll need
values from the Azure portal (Entra app reg client id + tenant id,
Cosmos connection string). Ask a maintainer or check the live deployment
secrets in GitHub Actions if you have access.

---

## Troubleshooting

**`ng serve` can't reach the API** - `func start` isn't running, or it's
bound to a port other than 7071. Check `proxy.conf.json`.

**Vitest browser mode fails to launch Chromium** - run
`npx playwright install chromium` to provision the bundled browser.

**Karma can't find Chrome (perf bench only)** - set `CHROME_BIN` to a
Chromium-family browser, or `npm install` a fresh Chrome from
https://www.google.com/chrome/. Only affects `npm run perf:l2`.

**`az bicep install` fails** - upgrade Azure CLI first
(`az upgrade`), then retry.

**`func start` complains about missing `local.settings.json`** - copy
the sample: `cp api/local.settings.sample.json api/local.settings.json`
and fill in values (see README § Setup).

**Sign-in redirects to a blank page on `localhost`** - the Entra app
registration needs `http://localhost:4200` as a redirect URI. See
[infra/README.md](infra/README.md).

If a prereq here is missing, out of date, or wrong - please open a PR.
