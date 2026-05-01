<#
.SYNOPSIS
  Starts a full local debugging experience for JotJSON.

.DESCRIPTION
  Spins up three Windows Terminal tabs:
    1. "web"   - ng serve on http://localhost:4200 (proxies /api to :7071)
    2. "api"   - func start in api/  on http://localhost:7071
                 split horizontally with `npm run watch` (tsc -w) so
                 `dist/` stays in sync with `src/` after the initial
                 one-shot build below; manual rebuilds aren't needed.
    3. "tests" - ng test (Karma watch) + jest --watch for the API,
                 split vertically in the same tab.

  Before launching it:
    - Verifies Node 24 is active (falls back to fnm use if available).
    - Verifies func + wt are on PATH.
    - Runs npm install in the repo root and api/ if node_modules is
      missing.
    - Checks that the gitignored env files exist and warns (but does not
      create them) if they don't.

  Alternatives:
    - For a debugger-attach workflow (breakpoints, step-through), prefer
      VS Code's F5: `.vscode/launch.json` + `.vscode/tasks.json` wire
      up `ng serve`, `ng test`, and `func: host start` with the right
      preLaunchTasks. See README.md "Debugging in VS Code".
    - Non-Windows contributors run the two-terminal manual flow
      documented in README.md "Running locally".

.PARAMETER SkipTests
  Don't open the tests tab. Useful if you only want to run the app.

.PARAMETER SkipInstall
  Don't run npm install even if node_modules is missing.

.EXAMPLE
  .\scripts\dev.ps1

.EXAMPLE
  .\scripts\dev.ps1 -SkipTests
#>

[CmdletBinding()]
param(
  [switch]$SkipTests,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

function Write-Step($msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

function Write-Warn($msg) {
  Write-Host "!!  $msg" -ForegroundColor Yellow
}

function Assert-Command($name, $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Write-Host "Missing required tool: $name" -ForegroundColor Red
    if ($hint) { Write-Host "    $hint" -ForegroundColor Red }
    Write-Host "See PREREQUISITES.md for install instructions." -ForegroundColor Red
    exit 1
  }
}

# --- 1. Tool checks --------------------------------------------------

Write-Step "Checking required tools"

Assert-Command 'node' 'Install Node 24. See PREREQUISITES.md.'
Assert-Command 'npm'  'npm ships with Node; reinstall Node 24.'
Assert-Command 'func' 'Install Azure Functions Core Tools v4: npm i -g azure-functions-core-tools@4'
Assert-Command 'wt'   'Install Windows Terminal from the Microsoft Store (or: winget install Microsoft.WindowsTerminal).'

$nodeMajor = (node --version).TrimStart('v').Split('.')[0]
if ($nodeMajor -ne '24') {
  Write-Warn "Active Node is v$nodeMajor; this repo expects Node 24."
  if (Get-Command fnm -ErrorAction SilentlyContinue) {
    $nvmrc = Get-Content (Join-Path $repoRoot '.nvmrc') -Raw
    $pinned = $nvmrc.Trim()
    Write-Host "    Running: fnm use $pinned" -ForegroundColor Yellow
    fnm use $pinned
    $nodeMajor = (node --version).TrimStart('v').Split('.')[0]
    if ($nodeMajor -ne '24') {
      Write-Host "Still not on Node 24 after 'fnm use'. Aborting." -ForegroundColor Red
      exit 1
    }
  } else {
    Write-Host "Install fnm (see PREREQUISITES.md) or switch manually, then re-run." -ForegroundColor Red
    exit 1
  }
}
Write-Host "node $(node --version), npm $(npm --version), func $(func --version)"

# --- 2. Env file sanity check ----------------------------------------

Write-Step "Checking local env files"

$webEnv = Join-Path $repoRoot 'src\environments\environment.ts'
$apiEnv = Join-Path $repoRoot 'api\local.settings.json'
$missing = @()
if (-not (Test-Path $webEnv)) { $missing += $webEnv }
if (-not (Test-Path $apiEnv)) { $missing += $apiEnv }
if ($missing.Count -gt 0) {
  foreach ($m in $missing) { Write-Warn "Missing: $m" }
  Write-Warn "Copy the sample files and fill in values. See README.md # Setup."
  Write-Warn "Continuing anyway - sign-in and Cosmos calls will fail until they exist."
}

# --- 3. Install deps if needed ---------------------------------------

if (-not $SkipInstall) {
  if (-not (Test-Path (Join-Path $repoRoot 'node_modules'))) {
    Write-Step "Installing web dependencies (npm install)"
    npm install
  }
  if (-not (Test-Path (Join-Path $repoRoot 'api\node_modules'))) {
    Write-Step "Installing API dependencies (cd api && npm install)"
    Push-Location (Join-Path $repoRoot 'api')
    try { npm install } finally { Pop-Location }
  }
}

# --- 4. Verify dev ports are free ------------------------------------

Write-Step "Checking dev ports are free"

$devPorts = 4200, 7071, 9876
$held = @()
foreach ($port in $devPorts) {
  $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    $proc = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    $held += [pscustomobject]@{
      Port = $port
      ProcessId = $listener.OwningProcess
      Name = if ($proc) { $proc.ProcessName } else { '<gone>' }
    }
  }
}

if ($held.Count -gt 0) {
  Write-Host ""
  Write-Host "Dev ports already in use:" -ForegroundColor Red
  foreach ($entry in $held) {
    Write-Host ("  port {0,-5} held by PID {1} ({2})" -f $entry.Port, $entry.ProcessId, $entry.Name) -ForegroundColor Red
  }
  Write-Host ""
  Write-Host "Run scripts\dev-stop.ps1 to free them, then re-run scripts\dev.ps1." -ForegroundColor Yellow
  exit 1
}

# --- 5. Launch Windows Terminal tabs ---------------------------------

Write-Step "Launching Windows Terminal tabs"

$apiDir = Join-Path $repoRoot 'api'

# Make sure the API is compiled once before `func start` reads from `dist/`.
# Without this, a fresh clone or a branch with new routes will 404 until
# the first `tsc` run. The `npm run watch` process kicked off below keeps
# `dist/` in sync from here on.
Write-Step "Building API (one-shot) so func start sees the latest routes"
Push-Location $apiDir
try {
  npm run build
  if ($LASTEXITCODE -ne 0) {
    throw "API build failed (exit $LASTEXITCODE). Fix the TypeScript errors above and rerun."
  }
} finally {
  Pop-Location
}

# Each tab runs a pwsh command. We build a wt.exe argument list with
# ';' tab separators. Using Start-Process with -ArgumentList avoids the
# PowerShell parser choking on the semicolons.
#
# The api tab is horizontally split: `func start` on top runs the compiled
# JS from `dist/`, `npm run watch` (tsc -w) on the bottom keeps `dist/` in
# sync with src/. Without the watcher, any change to api/src/** silently
# 404s at /api/... until the next manual build.
$wtArgs = @(
  'new-tab',   '--title', 'web',   '-d', $repoRoot, 'pwsh', '-NoExit', '-Command', 'npm start'
  ';'
  'new-tab',   '--title', 'api',   '-d', $apiDir,   'pwsh', '-NoExit', '-Command', 'func start'
  ';'
  'split-pane', '-H', '-d', $apiDir,
    'pwsh', '-NoExit', '-Command', 'npm run watch'
)

if (-not $SkipTests) {
  # Tests tab: ng test on top, jest --watch in a split pane below.
  # ng is a local devDep, not a global tool, so route the call through
  # `npx` to pick up node_modules/.bin/ng. (`npm start` / `npm run watch`
  # already get this for free because npm-script PATH includes
  # node_modules/.bin; bare `ng` in a fresh wt tab does not.)
  $wtArgs += @(
    ';'
    'new-tab',    '--title', 'tests', '-d', $repoRoot,
      'pwsh', '-NoExit', '-Command',
      'npx ng test --watch=true --browsers=ChromeHeadless'
    ';'
    'split-pane', '-H', '-d', $apiDir,
      'pwsh', '-NoExit', '-Command', 'npx jest --watch'
  )
}

Start-Process -FilePath 'wt.exe' -ArgumentList $wtArgs | Out-Null

Write-Host ""
Write-Host "Local dev environment starting:" -ForegroundColor Green
Write-Host "  web   -> http://localhost:4200"
Write-Host "  api   -> http://localhost:7071 (func start + tsc --watch split)"
if (-not $SkipTests) {
  Write-Host "  tests -> ng test (top) + jest --watch (bottom)"
}
Write-Host ""
Write-Host "Close the Windows Terminal tabs to stop each process."
Write-Host "If ports stay stuck after closing tabs, run scripts\dev-stop.ps1." -ForegroundColor DarkGray
