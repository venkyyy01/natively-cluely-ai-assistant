param(
  [string]$OutputDir = "release",
  [switch]$SkipBuild,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

function Invoke-Step {
  param(
    [string]$Command,
    [string[]]$Arguments
  )

  Write-Host "[build-and-install-windows] $Command $($Arguments -join ' ')"
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $Command $($Arguments -join ' ')"
  }
}

function Get-WindowsInstaller {
  param(
    [string]$SearchRoot
  )

  $exeFiles = Get-ChildItem -Path $SearchRoot -Recurse -File -Filter *.exe | Sort-Object LastWriteTimeUtc -Descending
  if (-not $exeFiles) {
    return $null
  }

  $setupInstaller = $exeFiles | Where-Object { $_.Name -match 'setup' } | Select-Object -First 1
  if ($setupInstaller) {
    return $setupInstaller
  }

  return $exeFiles | Select-Object -First 1
}

if (-not $SkipBuild) {
  Invoke-Step "node" @("scripts/ensure-electron-native-deps.js")
  Invoke-Step "npm" @("run", "build")
  Invoke-Step "npm" @("run", "build:native:current")
  Invoke-Step "npx" @("tsc", "-p", "electron/tsconfig.json")
  Invoke-Step "npx" @("electron-builder", "--win", "--x64", "--config.directories.output=$OutputDir")
}

$resolvedOutputDir = Join-Path $repoRoot $OutputDir
if (-not (Test-Path $resolvedOutputDir)) {
  throw "Windows output directory not found: $resolvedOutputDir"
}

Write-Host "[build-and-install-windows] Windows artifacts in $resolvedOutputDir"
Get-ChildItem -Path $resolvedOutputDir -Recurse -File | Sort-Object FullName | ForEach-Object {
  Write-Host " - $($_.FullName)"
}

if ($SkipInstall) {
  Write-Host "[build-and-install-windows] SkipInstall set, not launching installer"
  exit 0
}

$installer = Get-WindowsInstaller -SearchRoot $resolvedOutputDir
if (-not $installer) {
  throw "No Windows installer executable found under $resolvedOutputDir"
}

Write-Host "[build-and-install-windows] Launching $($installer.FullName)"
Start-Process -FilePath $installer.FullName -Wait
