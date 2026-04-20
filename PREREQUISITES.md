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
| A Chromium-based browser    | latest  | `npm test` (Karma `ChromeHeadlessCI`) |
| VS Code (optional)          | latest  | Shipped debug configs in `.vscode/` |

---

## 1. Node.js 24 (required)

The repo pins Node **24** via `.nvmrc`. Use a version manager so you can
switch between projects without reinstalling Node globally.

### Option A: fnm (recommended, cross-platform)

[fnm](https://github.com/Schniz/fnm) is fast, single-binary, and reads
`.nvmrc` out of the box.

**macOS / Linux:**

```bash
curl -fsSL https://fnm.vercel.app/install | bash
# restart your shell, then:
fnm install 24
fnm use 24
```

**Windows (PowerShell):**

```powershell
winget install Schniz.fnm
# restart PowerShell, then:
fnm install 24.15.0
fnm use 24.15.0
```

Add this to your PowerShell `$PROFILE` so fnm auto-switches when you
`cd` into the repo:

```powershell
fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression
```

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

## 4. Azure CLI + Bicep (only if touching `infra/` or Azure resources)

Skip this section if you're only working on the web or API code.

### Azure CLI

- macOS: `brew install azure-cli`
- Windows: `winget install -e --id Microsoft.AzureCLI`
- Linux / other: https://learn.microsoft.com/cli/azure/install-azure-cli

Then sign in:

```bash
az login
az account set --subscription "<your subscription name or id>"
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

---

## 5. Headless Chrome (required for `npm test`)

The Karma test runner uses a `ChromeHeadlessCI` launcher defined in
`karma.conf.js`. You need a Chromium-family browser available on PATH.

- **Chrome**: https://www.google.com/chrome/
- **Edge** (Chromium-based, ships with Windows): no install needed, but
  point Karma at it via `CHROME_BIN` if Chrome itself isn't present:
  ```powershell
  $env:CHROME_BIN = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
  ```
- **Chromium** on Linux: `sudo apt install chromium-browser`

CI uses `ChromeHeadlessCI` (adds `--no-sandbox`); locally `ng test` uses
whatever browser you configure via `npm test`.

### Verify

```bash
npm test            # web unit tests
(cd api && npm test)  # API unit tests (jest, no browser needed)
```

---

## 6. VS Code (optional, but recommended)

The repo ships VS Code launch configs in `.vscode/` that Just Work:

- **Web: ng serve (Chrome)** - starts Angular + opens Chrome with the
  debugger attached.
- **Web: ng test** - runs Karma with the Jasmine debugger.
- **Api: attach** - attaches to `func start` running in a terminal.

Install VS Code from https://code.visualstudio.com/. Recommended
extensions:

- **Angular Language Service** (`Angular.ng-template`)
- **ESLint** (`dbaeumer.vscode-eslint`)
- **Azure Functions** (`ms-azuretools.vscode-azurefunctions`)
- **Bicep** (`ms-azuretools.vscode-bicep`) - only if touching `infra/`

---

## 7. Environment files

These aren't tools, but they're part of first-time setup. See
[README.md § Setup](README.md#setup) for the exact commands. You'll need
values from the Azure portal (Entra app reg client id + tenant id,
Cosmos connection string). Ask a maintainer or check the live deployment
secrets in GitHub Actions if you have access.

---

## Troubleshooting

**`ng serve` can't reach the API** - `func start` isn't running, or it's
bound to a port other than 7071. Check `proxy.conf.json`.

**Karma can't find Chrome** - set `CHROME_BIN` to a Chromium-family
browser, or `npm install` a fresh Chrome from
https://www.google.com/chrome/.

**`az bicep install` fails** - upgrade Azure CLI first
(`az upgrade`), then retry.

**`func start` complains about missing `local.settings.json`** - copy
the sample: `cp api/local.settings.sample.json api/local.settings.json`
and fill in values (see README § Setup).

**Sign-in redirects to a blank page on `localhost`** - the Entra app
registration needs `http://localhost:4200` as a redirect URI. See
[infra/README.md](infra/README.md).

If a prereq here is missing, out of date, or wrong - please open a PR.
