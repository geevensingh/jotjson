<#
.SYNOPSIS
  Starts a full local debugging experience for JotJSON.

.DESCRIPTION
  Spins up three Windows Terminal tabs:
    1. "web"   - ng serve on http://localhost:4200 (proxies /api to :7071)
    2. "api"   - func start in api/  on http://localhost:7071
    3. "tests" - ng test (Karma watch) + jest --watch for the API,
                 split vertically in the same tab.

  Before launching it:
    - Verifies Node 24 is active (falls back to fnm use if available).
    - Verifies func + wt are on PATH.
    - Runs npm install in the repo root and api/ if node_modules is
      missing.
    - Checks that the gitignored env files exist and warns (but does not
      create them) if they don't.

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

# --- 4. Launch Windows Terminal tabs ---------------------------------

Write-Step "Launching Windows Terminal tabs"

$apiDir = Join-Path $repoRoot 'api'

# Each tab runs a pwsh command. We build a wt.exe argument list with
# ';' tab separators. Using Start-Process with -ArgumentList avoids the
# PowerShell parser choking on the semicolons.
$wtArgs = @(
  'new-tab',   '--title', 'web',   '-d', $repoRoot, 'pwsh', '-NoExit', '-Command', 'npm start'
  ';'
  'new-tab',   '--title', 'api',   '-d', $apiDir,   'pwsh', '-NoExit', '-Command', 'func start'
)

if (-not $SkipTests) {
  # Tests tab: ng test on top, jest --watch in a split pane below.
  $wtArgs += @(
    ';'
    'new-tab',    '--title', 'tests', '-d', $repoRoot,
      'pwsh', '-NoExit', '-Command',
      'ng test --watch=true --browsers=ChromeHeadless'
    ';'
    'split-pane', '-H', '-d', $apiDir,
      'pwsh', '-NoExit', '-Command', 'npx jest --watch'
  )
}

Start-Process -FilePath 'wt.exe' -ArgumentList $wtArgs | Out-Null

Write-Host ""
Write-Host "Local dev environment starting:" -ForegroundColor Green
Write-Host "  web   -> http://localhost:4200"
Write-Host "  api   -> http://localhost:7071"
if (-not $SkipTests) {
  Write-Host "  tests -> ng test (top) + jest --watch (bottom)"
}
Write-Host ""
Write-Host "Close the Windows Terminal tabs to stop each process."
