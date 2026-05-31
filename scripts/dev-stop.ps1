<#
.SYNOPSIS
  Cleans up any leftover dev processes from scripts/dev.ps1.

.DESCRIPTION
  Finds processes listening on the well-known dev ports (4200 web,
  7071 api), then walks each process tree and kills it
  along with everything below it. Use this when:
    - The dev.ps1 supervisor crashed.
    - You closed the wrong window first and ports are stuck.
    - Anything else that left zombies behind.

  (The vitest browser-mode dev server binds to an ephemeral port that
  Vitest does not surface to a stable config knob today; we don't try
  to kill it from here. Close the wt tab instead.)

  Idempotent: if no dev ports are bound, prints "Nothing to stop"
  and exits 0.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ports = 4200, 7071

function Get-DescendantPids([int]$rootPid) {
  $all = Get-CimInstance Win32_Process |
         Select-Object ProcessId, ParentProcessId
  $children = @{}
  foreach ($entry in $all) {
    $parentId = [int]$entry.ParentProcessId
    if (-not $children.ContainsKey($parentId)) {
      $children[$parentId] = @()
    }
    $children[$parentId] += [int]$entry.ProcessId
  }
  $found = @($rootPid)
  $stack = New-Object System.Collections.Stack
  $stack.Push($rootPid)
  while ($stack.Count -gt 0) {
    $current = $stack.Pop()
    if ($children.ContainsKey($current)) {
      foreach ($childId in $children[$current]) {
        if ($found -notcontains $childId) {
          $found += $childId
          $stack.Push($childId)
        }
      }
    }
  }
  return $found
}

$victims = @()
foreach ($port in $ports) {
  $listeners = Get-NetTCPConnection -LocalPort $port `
    -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    $victims += Get-DescendantPids $listener.OwningProcess
  }
}
$victims = $victims | Sort-Object -Unique

if (-not $victims) {
  Write-Host "Nothing to stop. Dev ports are free." -ForegroundColor Green
  exit 0
}

Write-Host "Stopping $($victims.Count) process(es)..." -ForegroundColor Cyan
foreach ($processId in $victims) {
  try {
    Stop-Process -Id $processId -Force -ErrorAction Stop
    Write-Host "  killed $processId"
  } catch {
    Write-Host "  skipped $processId ($($_.Exception.Message))" -ForegroundColor DarkGray
  }
}

Start-Sleep -Milliseconds 500
$still = @()
foreach ($port in $ports) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    $still += $port
  }
}
if ($still) {
  Write-Host "Still listening on: $($still -join ', '). Run again or check Task Manager." -ForegroundColor Yellow
} else {
  Write-Host "All dev ports free." -ForegroundColor Green
}
